/**
 * host.ts — 插件宿主生命周期（plugin 阶段 P2.4）。
 *
 * 职责：从注册表读已启用插件 → 逐个加载（失败隔离：单插件抛错只留一行 warning，
 * 其余继续、不阻塞启动）→ 维护 name→LoadedPlugin；`unload`/`reload` 逆序释放。
 *
 * 加载顺序 = 注册表键序；卸载逆序调用 disposer（单插件内部，见 loader）。
 * 不主动删槽位目录（P2 决策：靠下次覆盖 / 进程退出回收；规避删除类操作）。
 */
import type { PluginCapabilities } from './capabilities';
import { loadPlugin, type LoadedPlugin } from './loader';
import { readManifest } from './manifest';
import { readRegistry, resolvePluginDir, type PluginEntry, type PluginRegistryData } from './registry';

export interface PluginHostOptions {
  capabilities: PluginCapabilities;
  /** 单行警告出口（缺省 stderr） */
  warn?: (message: string) => void;
  /** 注册表文件覆盖（测试用；缺省 ~/.omc/plugins.json） */
  registryFile?: string;
}

export class PluginHost {
  private readonly loaded = new Map<string, LoadedPlugin>();
  private readonly warn: (message: string) => void;

  constructor(private readonly opts: PluginHostOptions) {
    this.warn = opts.warn ?? ((m: string) => process.stderr.write(`${m}\n`));
  }

  /** 已加载插件名（注册序） */
  loadedNames(): string[] {
    return [...this.loaded.keys()];
  }

  /**
   * 读注册表并加载全部启用插件。单插件失败 → 一行 warning，继续下一个。
   * @returns 成功加载的插件名列表
   */
  async loadAll(data: PluginRegistryData = readRegistry(this.opts.registryFile)): Promise<string[]> {
    const ok: string[] = [];
    for (const [name, entry] of Object.entries(data.plugins)) {
      if (entry.enabled === false) continue;
      if (await this.load(name, entry)) ok.push(name);
    }
    return ok;
  }

  /** 加载单个插件；已加载则跳过返回 false。失败 → warning + false。 */
  async load(name: string, entry: PluginEntry): Promise<boolean> {
    if (this.loaded.has(name)) return false;
    try {
      const dir = resolvePluginDir(name, entry);
      const manifest = readManifest(dir);
      const plugin = await loadPlugin({
        name,
        pluginDir: dir,
        manifest,
        capabilities: this.opts.capabilities,
        warn: this.warn,
      });
      this.loaded.set(name, plugin);
      return true;
    } catch (e) {
      this.warn(`[plugin] ${name} 加载失败：${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  /** 卸载单个插件（逆序释放 disposer）；未加载则空操作 */
  async unload(name: string): Promise<void> {
    const plugin = this.loaded.get(name);
    if (!plugin) return;
    this.loaded.delete(name);
    await plugin.dispose();
  }

  /** 重载：先卸载再按注册表条目重新加载（用于热更新/启停） */
  async reload(name: string): Promise<boolean> {
    await this.unload(name);
    const entry = readRegistry(this.opts.registryFile).plugins[name];
    if (!entry) {
      this.warn(`[plugin] ${name} 不在注册表，跳过重载`);
      return false;
    }
    return this.load(name, entry);
  }

  /** 卸载全部（进程退出兜底；逆序） */
  async unloadAll(): Promise<void> {
    for (const name of [...this.loaded.keys()].reverse()) {
      await this.unload(name);
    }
  }
}

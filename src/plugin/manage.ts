/**
 * manage.ts — 插件状态列表与表格渲染（plugin 阶段 P5.1；纯函数，可测）。
 *
 * 数据源：注册表（`~/.omc/plugins.json`）+ 宿主已加载名集合。
 * 版本/问题来自 best-effort 读 manifest（目录缺失 / 坏 manifest → 记 issue，不抛，
 * 保证「一个坏插件不影响列表」）。
 */
import { readManifest } from './manifest';
import { resolvePluginDir, type PluginRegistryData } from './registry';

const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

/** 单个插件的展示状态（注册表口径 + 运行期加载状态 + manifest 信息） */
export interface PluginStatusEntry {
  name: string;
  enabled: boolean;
  loaded: boolean;
  source: string;
  commit?: string;
  version?: string;
  /** 加载目录缺失 / manifest 读取失败的原因（不阻塞列表，仅供提示） */
  issue?: string;
}

/** 状态短文本（列表/浮层共用）：启用/停用 + 加载态；有问题尾随 ⚠ */
export function statusText(e: PluginStatusEntry): string {
  const state = e.enabled ? (e.loaded ? '启用·已加载' : '启用·未加载') : '停用';
  return e.issue ? `${state} ⚠` : state;
}

/** 来源标签：github 源补 commit 前 7 位 */
export function sourceLabel(e: PluginStatusEntry): string {
  return e.commit ? `${e.source} @${e.commit.slice(0, 7)}` : e.source;
}

/**
 * 汇总插件状态：注册表条目序 → 逐条解析加载目录 + manifest 版本（best-effort）。
 * @param loadedNames 宿主已加载插件名（PluginHost.loadedNames()）
 */
export function pluginStatuses(
  data: PluginRegistryData,
  loadedNames: Iterable<string>,
): PluginStatusEntry[] {
  const loaded = new Set(loadedNames);
  return Object.entries(data.plugins).map(([name, entry]) => {
    const out: PluginStatusEntry = {
      name,
      enabled: entry.enabled !== false,
      loaded: loaded.has(name),
      source: entry.source,
    };
    if (entry.commit) out.commit = entry.commit;
    try {
      const manifest = readManifest(resolvePluginDir(name, entry));
      if (manifest.version) out.version = manifest.version;
    } catch (e) {
      out.issue = e instanceof Error ? e.message : String(e);
    }
    return out;
  });
}

const HEADERS = ['名称', '版本', '状态', '来源'] as const;

/** 显示宽度对齐（中文占 2 列）；Bun 锁定，直接用 Bun.stringWidth */
function pad(s: string, width: number): string {
  const w = Bun.stringWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

/** 渲染为对齐表格（多行字符串数组；无插件 → 安装提示；有 issue → 表后附问题行） */
export function formatPluginTable(entries: PluginStatusEntry[]): string[] {
  if (entries.length === 0) {
    return [`${DIM}（无已安装插件）安装：omc plugin add <path|github:owner/repo>${RESET}`];
  }
  const rows = entries.map((e) => [
    e.name,
    e.version ? `v${e.version}` : '-',
    statusText(e),
    sourceLabel(e),
  ]);
  const widths = HEADERS.map((h, i) =>
    Math.max(Bun.stringWidth(h), ...rows.map((r) => Bun.stringWidth(r[i]))),
  );
  const line = (cells: readonly string[]): string => cells.map((c, i) => pad(c, widths[i])).join('  ');
  const lines = [
    `${DIM}${line(HEADERS)}${RESET}`,
    // 名称列染色：先拼纯文本再替换行首名称段（避免行内染色破坏宽度对齐）
    ...rows.map((r) => line(r).replace(r[0], `${CYAN}${r[0]}${RESET}`)),
  ];
  const issues = entries.filter((e) => e.issue);
  if (issues.length > 0) {
    lines.push('');
    for (const e of issues) lines.push(`${YELLOW}⚠ ${e.name}: ${e.issue}${RESET}`);
  }
  return lines;
}

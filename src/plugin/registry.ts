/**
 * registry.ts — 插件注册表 `~/.omc/plugins.json`（plugin 阶段 P2.2）。
 *
 * 结构：
 *   { "plugins": { "<name>": { "source": "<本地绝对路径 | github:owner/repo#ref>",
 *                              "enabled": true, "api": 1, "commit": "<sha>" } } }
 *
 * 容忍语义对齐 config：坏 JSON / 缺文件 / 结构不符 → 空注册表（不阻塞启动）。
 * 本阶段只读；写入（add/remove/enable）在 P3/P5，但 writeRegistry 先备好。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pluginRegistryFile, pluginsDir } from '../config/paths';

export interface PluginEntry {
  /** 来源：本地绝对/相对路径，或 `github:owner/repo[#ref]` */
  source: string;
  /** 是否启用（缺省视为 true） */
  enabled: boolean;
  /** 安装时记录的插件 API 版本（可选用作审计） */
  api?: number;
  /** github 源解析到的 commit（P3；可复现/审计） */
  commit?: string;
}

export interface PluginRegistryData {
  plugins: Record<string, PluginEntry>;
}

const EMPTY: PluginRegistryData = { plugins: {} };

/** 读注册表；任何异常 → 空注册表（坏 JSON 静默，对齐 config 容忍） */
export function readRegistry(file: string = pluginRegistryFile()): PluginRegistryData {
  try {
    if (!existsSync(file)) return { plugins: {} };
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return normalize(raw);
  } catch {
    return { plugins: {} };
  }
}

/** 写注册表（保留其他键由调用方负责）；写失败静默 */
export function writeRegistry(data: PluginRegistryData, file: string = pluginRegistryFile()): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  } catch {
    // 写失败不影响当次操作
  }
}

/** 宽松归一化：只保留 source 为非空字符串的条目 */
function normalize(raw: unknown): PluginRegistryData {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { plugins: {} };
  const pluginsRaw = (raw as Record<string, unknown>).plugins;
  if (pluginsRaw === null || typeof pluginsRaw !== 'object' || Array.isArray(pluginsRaw)) {
    return { plugins: {} };
  }
  const plugins: Record<string, PluginEntry> = {};
  for (const [name, value] of Object.entries(pluginsRaw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    if (typeof v.source !== 'string' || !v.source.trim()) continue;
    const entry: PluginEntry = {
      source: v.source,
      enabled: v.enabled !== false, // 缺省启用
    };
    if (typeof v.api === 'number') entry.api = v.api;
    if (typeof v.commit === 'string') entry.commit = v.commit;
    plugins[name] = entry;
  }
  return { plugins };
}

/**
 * 解析插件的实际加载目录：
 * - `source` 是现存目录（绝对或相对 cwd）→ 用它（本地安装 = symlink 到源目录）
 * - 否则 → `~/.omc/plugins/<name>`（github clone / 托管安装落点）
 */
export function resolvePluginDir(name: string, entry: PluginEntry): string {
  const src = entry.source;
  if (src && !src.startsWith('github:')) {
    const abs = isAbsolute(src) ? src : resolve(src);
    if (existsSync(abs)) return abs;
  }
  return join(pluginsDir(), name);
}

/** 空注册表常量（只读用；勿改） */
export function emptyRegistry(): PluginRegistryData {
  return EMPTY;
}

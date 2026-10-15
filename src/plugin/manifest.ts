/**
 * manifest.ts — 插件 manifest 解析（plugin 阶段 P2.1）。
 *
 * manifest 内嵌在插件目录的 `package.json#omc`（复用 npm 生态，少一个文件）：
 *   { "name": "omc-xxx", "version": "0.1.0", "type": "module",
 *     "omc": { "api": 1, "entry": "index.ts", "engines": { "omc": ">=0.2.0" } } }
 *
 * 规则：
 * - `api` 必填且 `=== HOST_API`，否则拒载（门禁）
 * - `entry` 缺省回退 `index.ts` → `dist/index.js`（择一存在者）
 * - 解析出的 entry 必须是插件目录内的相对路径且文件存在
 * - name 取 `omc.name` → `package.json#name` → 目录名
 *
 * 全程抛 Error（带人话 message），由 host 层 catch 成「一行 warning + 不阻塞启动」。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import { HOST_API, type PluginManifest } from './types';

/** 解析失败（缺文件/坏 JSON/门禁不过/entry 非法）——host 层据此降级为 warning */
export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

/** 缺省 entry 候选（按序取第一个存在的文件） */
const DEFAULT_ENTRIES = ['index.ts', 'dist/index.js'] as const;

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 读取并校验插件 manifest。
 * @param pluginDir 插件目录（绝对路径）
 * @throws ManifestError
 */
export function readManifest(pluginDir: string): PluginManifest {
  const pkgFile = join(pluginDir, 'package.json');
  if (!existsSync(pkgFile)) {
    throw new ManifestError(`缺少 package.json（${pluginDir}）`);
  }
  let pkg: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(pkgFile, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    pkg = parsed as Record<string, unknown>;
  } catch {
    throw new ManifestError(`package.json 解析失败（${pkgFile}）`);
  }

  const omcRaw = pkg.omc;
  if (omcRaw === null || typeof omcRaw !== 'object' || Array.isArray(omcRaw)) {
    throw new ManifestError(`缺少 package.json#omc 字段（${pkgFile}）`);
  }
  const omc = omcRaw as Record<string, unknown>;

  // API 门禁：必需且严格相等
  const api = omc.api;
  if (typeof api !== 'number' || !Number.isInteger(api)) {
    throw new ManifestError(`omc.api 缺失或非整数（${pkgFile}）`);
  }
  if (api !== HOST_API) {
    throw new ManifestError(`插件 API 版本不匹配：需要 ${HOST_API}，实际 ${api}，请升级插件`);
  }

  const name =
    (typeof omc.name === 'string' && omc.name.trim()) ||
    (typeof pkg.name === 'string' && pkg.name.trim()) ||
    basename(pluginDir);

  const entry = resolveEntry(pluginDir, omc.entry);
  const version = typeof pkg.version === 'string' ? pkg.version : undefined;
  const engines = omc.engines;

  return {
    name: String(name),
    api,
    entry,
    version,
    engines:
      engines !== null && typeof engines === 'object' && !Array.isArray(engines)
        ? (engines as { omc?: string })
        : undefined,
  };
}

/** 解析 entry：显式值优先，否则按候选回退；结果必须是插件目录内的现存文件 */
function resolveEntry(pluginDir: string, raw: unknown): string {
  let entry: string;
  if (typeof raw === 'string' && raw.trim()) {
    entry = raw.trim();
    if (isAbsolute(entry)) {
      throw new ManifestError(`omc.entry 必须是插件目录内的相对路径（${entry}）`);
    }
  } else {
    const found = DEFAULT_ENTRIES.find((e) => existsSync(join(pluginDir, e)));
    if (!found) {
      throw new ManifestError(`未指定 omc.entry 且缺省入口不存在（${DEFAULT_ENTRIES.join(' / ')}）`);
    }
    entry = found;
  }
  // 归一化路径穿越（`../x`）：解析结果必须仍在插件目录内（先于存在性检查）
  const rel = relative(pluginDir, join(pluginDir, entry));
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new ManifestError(`omc.entry 越出插件目录：${entry}`);
  }
  if (!existsSync(join(pluginDir, entry))) {
    throw new ManifestError(`omc.entry 指向的文件不存在：${entry}`);
  }
  return entry;
}

/** 目录是否为合法插件（供安装器/列表用；不抛异常） */
export function isPluginDir(pluginDir: string): boolean {
  if (!isDir(pluginDir)) return false;
  try {
    readManifest(pluginDir);
    return true;
  } catch {
    return false;
  }
}

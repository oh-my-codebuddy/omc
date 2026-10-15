/**
 * mcp-config.ts — MCP 配置文件读取（mcp-console P1）。
 *
 * 背景（探针 `scripts/probe-sdk-mcp.ts` 实证）：omc 会话恒传 `settingSources: []`
 * → CLI 侧 settings scope = none → **`.mcp.json` 完全不加载**（不是「没配」而是「配了也不加载」）。
 * 唯一低风险出路 = omc **自读配置** + 经 `SessionOptions.mcpServers` **显式注入**，
 * 保住 `settingSources: []` 隔离（放弃它会连带继承用户 hooks/permissions/skillOverrides，
 * 属架构倒退，见 AGENTS.md 与 rate-limit 同类决策）。
 *
 * 查找链（复刻 CLI `docs/cn/cli/mcp.md` 配置作用域优先级；**同一作用域只用第一个存在的文件**）：
 * - USER：`~/.codebuddy/.mcp.json`（推荐）→ `~/.codebuddy/mcp.json`（已废弃）
 * - PROJECT：`<cwd>/.mcp.json`（推荐）→ `<cwd>/mcp.json`（已废弃）
 * 同名服务**项目覆盖用户**（对齐 CLI「同名 `local > project > user`」中 project > user 一节）。
 *
 * 格式 = **JSONC**（CLI 文档明示：允许行注释 / 块注释与尾随逗号）；
 * 另支持 `${VAR}` / `${VAR:-default}` 环境变量扩展（CLI 文档「环境变量扩展」节）。
 *
 * ⚠ 会话构造（= spawn CLI 子进程）时读定 → **改配置需重启会话生效**（同变体 env 约束）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpServerConfig } from '@tencent-ai/agent-sdk';

/** 生效来源作用域（同名时 project 覆盖 user） */
export type McpScope = 'user' | 'project';

/** 单个 server 条目（含来源，供 `/mcp` 展示；P2 消费） */
export interface McpServerEntry {
  name: string;
  config: McpServerConfig;
  scope: McpScope;
  /** 该条目来自的配置文件绝对路径 */
  sourceFile: string;
  /** 是否命中禁用名单（`.mcp.json#disabledMcpServers`；P3 应用为「不注入」） */
  disabled: boolean;
}

export interface McpConfigResult {
  /**
   * 合并后的 server 表（user 铺底、project 同名覆盖），**已剔除禁用项**（P3：
   * omc 自管禁用集 ∪ `.mcp.json#disabledMcpServers`）→ 可直接作为注入面。
   * 想看被禁用项请用 `entries`（含全部，标 `disabled`）。
   */
  servers: Record<string, McpServerConfig>;
  /** 全部条目（含来源 / 禁用标记；P2 `/mcp` 展示用） */
  entries: McpServerEntry[];
  /** 汇总的禁用名单（user ∪ project 的 `disabledMcpServers` ∪ `extraDisabled`；去重保序） */
  disabled: string[];
  /** 实际命中的配置文件（未命中为 null），供 `/mcp` 展示来源 */
  sources: { user: string | null; project: string | null };
}

/** USER 作用域查找链（高 → 低优先级） */
function userCandidates(home: string): string[] {
  return [join(home, '.codebuddy', '.mcp.json'), join(home, '.codebuddy', 'mcp.json')];
}

/** PROJECT 作用域查找链（高 → 低优先级） */
function projectCandidates(cwd: string): string[] {
  return [join(cwd, '.mcp.json'), join(cwd, 'mcp.json')];
}

/** 返回第一个存在的路径（都不存在 → null；对齐 CLI「同一作用域只用第一个存在的文件」） */
function firstExisting(paths: string[]): string | null {
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * 剥 JSONC 注释（行注释 + 块注释），**字符串内的斜杠不误判**。
 * 逐字符扫描并跟踪双引号状态（JSON/JSONC 无单引号字符串，故只跟踪 `"`）。
 */
export function stripJsonComments(text: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === '\\') {
        // 转义：连同下一个字符原样输出（避免 \ " 提前闭合字符串）
        out += text[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2; // 跳过收尾 */
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** 去尾随逗号（`, }` / `, ]`，中间仅空白）；在剥注释后调用，配置场景足够 */
export function stripTrailingCommas(text: string): string {
  return text.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * 解析 JSONC 文本 → 对象；失败返回 null（坏配置**不抛**，按「无配置」降级）。
 * 先按标准 JSON 解析；失败再剥注释 + 尾逗号重试（保持对标准 JSON 的零成本路径）。
 */
function parseJsonc(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    // 落到 JSONC 容错
  }
  try {
    return JSON.parse(stripTrailingCommas(stripJsonComments(text)));
  } catch {
    return null;
  }
}

/** 环境变量扩展：`${VAR}` / `${VAR:-default}`；合法名 `[A-Z_][A-Z0-9_]*`（CLI 文档规则） */
const ENV_PLACEHOLDER = /\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/g;

export function expandEnvValue(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(ENV_PLACEHOLDER, (whole, name: string, fallback?: string) => {
    const v = env[name];
    if (typeof v === 'string' && v.length > 0) return v;
    if (fallback !== undefined) return fallback;
    return whole; // 未设且无默认 → 保留原占位符（CLI 同口径：不因缺变量而失败）
  });
}

/** 只保留字符串值（env / headers 均为 `Record<string,string>`） */
function stringRecord(raw: unknown): Record<string, string> | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 规范化单个 server 配置：校验必需字段 + 补 `type`（CLI 文档：含 `command` → stdio、
 * 含 `url` → http）+ 做环境变量扩展。非法（缺 name 对应的必需字段 / 未知 type）→ null。
 */
function normalizeServer(raw: unknown, env: NodeJS.ProcessEnv): McpServerConfig | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  let type = typeof o.type === 'string' ? o.type : undefined;
  if (type === undefined) {
    if (typeof o.command === 'string' && o.command.length > 0) type = 'stdio';
    else if (typeof o.url === 'string' && o.url.length > 0) type = 'http';
  }
  if (type === 'stdio') {
    if (typeof o.command !== 'string' || o.command.length === 0) return null;
    const args = Array.isArray(o.args)
      ? o.args.filter((a): a is string => typeof a === 'string').map((a) => expandEnvValue(a, env))
      : undefined;
    const envRec = stringRecord(o.env);
    return {
      type: 'stdio',
      command: expandEnvValue(o.command, env),
      ...(args ? { args } : {}),
      ...(envRec
        ? { env: Object.fromEntries(Object.entries(envRec).map(([k, v]) => [k, expandEnvValue(v, env)])) }
        : {}),
    };
  }
  if (type === 'sse' || type === 'http') {
    if (typeof o.url !== 'string' || o.url.length === 0) return null;
    const headers = stringRecord(o.headers);
    return {
      type,
      url: expandEnvValue(o.url, env),
      ...(headers
        ? { headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, expandEnvValue(v, env)])) }
        : {}),
    };
  }
  return null; // 'sdk' 等进程内类型不可能来自磁盘配置，忽略
}

/** 单文件解析产物：server 表 + 禁用名单 */
interface ParsedFile {
  servers: Record<string, McpServerConfig>;
  disabled: string[];
}

/** 读一个文件的 `mcpServers` + `disabledMcpServers`（缺失/坏 JSON → 空） */
function parseFile(path: string, env: NodeJS.ProcessEnv): ParsedFile {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { servers: {}, disabled: [] };
  }
  const parsed = parseJsonc(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { servers: {}, disabled: [] };
  }
  const root = parsed as Record<string, unknown>;
  const servers: Record<string, McpServerConfig> = {};
  const rawServers = root.mcpServers;
  if (rawServers !== null && typeof rawServers === 'object' && !Array.isArray(rawServers)) {
    for (const [name, cfg] of Object.entries(rawServers as Record<string, unknown>)) {
      const normalized = normalizeServer(cfg, env);
      if (normalized) servers[name] = normalized;
    }
  }
  const rawDisabled = root.disabledMcpServers;
  const disabled = Array.isArray(rawDisabled)
    ? rawDisabled.filter((n): n is string => typeof n === 'string' && n.length > 0)
    : [];
  return { servers, disabled };
}

/**
 * 主出口：读 user + project 两个作用域的 MCP 配置并合并。
 *
 * @param cwd  项目根目录（PROJECT 作用域基准）
 * @param opts `home` / `env` / `extraDisabled` 可注入（单测；缺省用 `os.homedir()` /
 *   `process.env` / 无额外禁用）。`extraDisabled` = omc 自管禁用集
 *   （`~/.omc/config.json#mcp.disabled`，mcp-console P3；由调用方读入以避免 app 层依赖 config）。
 */
export function readMcpServers(
  cwd: string = process.cwd(),
  opts: { home?: string; env?: NodeJS.ProcessEnv; extraDisabled?: readonly string[] } = {},
): McpConfigResult {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;

  const userFile = firstExisting(userCandidates(home));
  const projectFile = firstExisting(projectCandidates(cwd));
  const user = userFile ? parseFile(userFile, env) : { servers: {}, disabled: [] };
  const project = projectFile ? parseFile(projectFile, env) : { servers: {}, disabled: [] };

  // 合并：user 铺底 → project 同名覆盖（Map.set 同名替换值、保留原插入位置）
  const merged = new Map<string, { config: McpServerConfig; scope: McpScope; sourceFile: string }>();
  for (const [name, config] of Object.entries(user.servers)) {
    merged.set(name, { config, scope: 'user', sourceFile: userFile! });
  }
  for (const [name, config] of Object.entries(project.servers)) {
    merged.set(name, { config, scope: 'project', sourceFile: projectFile! });
  }

  const disabled = [
    ...new Set([...user.disabled, ...project.disabled, ...(opts.extraDisabled ?? [])]),
  ];
  const disabledSet = new Set(disabled);
  const servers: Record<string, McpServerConfig> = {};
  const entries: McpServerEntry[] = [];
  for (const [name, meta] of merged) {
    const isDisabled = disabledSet.has(name);
    entries.push({ name, ...meta, disabled: isDisabled });
    if (!isDisabled) servers[name] = meta.config; // P3：注入面剔除禁用项
  }

  return {
    servers,
    entries,
    disabled,
    sources: { user: userFile, project: projectFile },
  };
}

/**
 * config/index.ts — 配置系统（P6.5），三级合并：
 *   `~/.omc/config.json`（`OMC_CONFIG_DIR` 可覆盖，见 src/config/paths.ts）
 *   ← 项目级 `<cwd>/.omc/config.json` 覆盖
 *   ← env 覆盖（OMC_MODEL / OMC_PERMISSION_MODE / OMC_MAX_TURNS / OMC_VERBOSE / OMC_COMPOSER_SHAPE）
 *
 * 坏 JSON 静默忽略该层（配置不阻塞启动）。只用 Node 标准 API。
 *
 * 双校验体系（statusline 阶段 P1 起，刻意取舍）：
 *   扁平字段保持手写 typeof 校验（历史代码，够用不动）；
 *   嵌套结构（statusline）用 zod——手写逐层 typeof 会爆炸，zod 已在依赖零新增。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LaunchPermissionMode } from '../permission/modes';
import { isBuiltinComposerStyle } from '@oh-my-pi/pi-tui';
import { z } from 'zod';
import { projectConfigFile, userConfigFile } from './paths';

/** statusline 可用 segment（statusline 阶段；渲染注册表见 src/app/statusline-segments.ts） */
export const SEGMENT_IDS = [
  'vim',
  'model',
  'mode',
  'tokens',
  'token_in',
  'token_out',
  'ctx',
  'cwd',
  'git',
  'cost',
  'turns',
  'time',
  'hostname',
  'session',
  'session_name',
] as const;
export type SegmentId = (typeof SEGMENT_IDS)[number];

export const STATUSLINE_SEPARATORS = [
  'pipe',
  'slash',
  'dot',
  'powerline',
  'powerline-thin',
  'block',
  'none',
  'ascii',
] as const;
export type StatuslineSeparator = (typeof STATUSLINE_SEPARATORS)[number];

const statuslineSchema = z.object({
  /**
   * 最多两行，每行左右两组（超越 omp 单行限制）；缺省 = 现状单行布局。
   * 段 id 为**任意非空字符串**：内置段（SEGMENT_IDS）或插件段（`plugin:<插件自报 id>`，
   * 如 `plugin:codebuddy:account`）。**未知 id 由渲染层跳过并告警**（见 Statusline.unknownSegments），
   * 不在此处 reject —— 否则插件卸载后遗留 id 会让**整块** statusline 配置失效。
   */
  rows: z
    .array(
      z.object({
        left: z.array(z.string().min(1)).optional(),
        right: z.array(z.string().min(1)).optional(),
      }),
    )
    .max(2)
    .optional(),
  separator: z.enum(STATUSLINE_SEPARATORS).optional(),
  /** 段前图标（默认 false；omp unicode preset 字形，零字体依赖，statusline 阶段 P3.7） */
  icons: z.boolean().optional(),
  colors: z
    .object({
      /** 整行 DIM（默认 true，现状观感；segments:true 时忽略——分段着色与整行 DIM 互斥） */
      dim: z.boolean().optional(),
      /** 语义着色（默认 true：ctx 段 ≥70% 黄 ≥90% 红） */
      semantic: z.boolean().optional(),
      /** 每段独立语义色（默认 false；true = omp dark 主题分段色板，statusline 阶段 P3.6） */
      segments: z.boolean().optional(),
    })
    .optional(),
});
export type StatuslineConfig = z.infer<typeof statuslineSchema>;

/**
 * MCP 管理面配置（mcp-console P3）：omc 自管禁用集。
 * 为什么自管而非写用户 `.mcp.json#disabledMcpServers`：避免与 CLI 的 `codebuddy mcp`
 * 命令互相 clobber（AGENTS.md 耦合点）。生效 = `~/.omc/config.json#mcp.disabled`
 * ∪ `.mcp.json#disabledMcpServers`（后者只读）。
 */
const mcpSchema = z.object({
  disabled: z.array(z.string().min(1)).optional(),
});
export type McpConfigSection = z.infer<typeof mcpSchema>;

export interface AppConfig {
  model?: string;
  permissionMode?: LaunchPermissionMode;
  maxTurns?: number;
  /** 工具详情全显开关（/verbose 可运行时切换） */
  verbose?: boolean;
  /** vim 编辑模式（/vim 热切换并写用户级配置持久化，ux-port P3.4） */
  vimMode?: boolean;
  /** 输入区形状（composer shape，8 种内置；/shape 热切换并写用户级配置，composer-shape 阶段） */
  composerShape?: string;
  /** 输入框浅色「提问建议」开关（prompt-suggestion 阶段；默认开，`/suggest` 热切换并写用户级配置） */
  suggestEnabled?: boolean;
  /** statusline 布局/样式（statusline 阶段；env 层不设覆盖——嵌套结构不适合 env 扁平语义） */
  statusline?: StatuslineConfig;
  /** MCP 自管禁用集（mcp-console P3；`/mcp enable|disable` 写用户级配置） */
  mcp?: McpConfigSection;
}

function readJson(file: string): Partial<AppConfig> {
  try {
    if (!existsSync(file)) return {};
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const out: Partial<AppConfig> = {};
    if (typeof raw.model === 'string') out.model = raw.model;
    if (typeof raw.permissionMode === 'string') out.permissionMode = raw.permissionMode as LaunchPermissionMode;
    if (typeof raw.maxTurns === 'number') out.maxTurns = raw.maxTurns;
    if (typeof raw.verbose === 'boolean') out.verbose = raw.verbose;
    if (typeof raw.vimMode === 'boolean') out.vimMode = raw.vimMode;
    if (typeof raw.suggestEnabled === 'boolean') out.suggestEnabled = raw.suggestEnabled;
    if (typeof raw.composerShape === 'string') {
      // 只认内置 shape，避免写错/过期 id 让状态栏落点出错；非法值丢弃但留一行 warning
      if (isBuiltinComposerStyle(raw.composerShape)) {
        out.composerShape = raw.composerShape;
      } else {
        process.stderr.write(`[config] 忽略非法 composerShape：${raw.composerShape}\n`);
      }
    }
    if (raw.statusline !== undefined) {
      const parsed = statuslineSchema.safeParse(raw.statusline);
      if (parsed.success) {
        out.statusline = parsed.data;
      } else {
        // 与「坏 JSON 静默忽略」语义一致：丢弃该字段回退默认，但留一行 warning 便于排查
        process.stderr.write(
          `[config] 忽略非法 statusline 配置：${parsed.error.issues[0]?.message ?? 'invalid'}\n`,
        );
      }
    }
    if (raw.mcp !== undefined) {
      const parsed = mcpSchema.safeParse(raw.mcp);
      if (parsed.success) {
        out.mcp = parsed.data;
      } else {
        process.stderr.write(
          `[config] 忽略非法 mcp 配置：${parsed.error.issues[0]?.message ?? 'invalid'}\n`,
        );
      }
    }
    return out;
  } catch {
    return {};
  }
}

function fromEnv(): Partial<AppConfig> {
  const out: Partial<AppConfig> = {};
  const e = process.env;
  if (e.OMC_MODEL) out.model = e.OMC_MODEL;
  if (e.OMC_PERMISSION_MODE) out.permissionMode = e.OMC_PERMISSION_MODE as LaunchPermissionMode;
  if (e.OMC_MAX_TURNS) {
    const n = Number.parseInt(e.OMC_MAX_TURNS, 10);
    if (Number.isFinite(n) && n > 0) out.maxTurns = n;
  }
  if (e.OMC_VERBOSE && /^(1|true|yes)$/i.test(e.OMC_VERBOSE)) out.verbose = true;
  if (e.OMC_COMPOSER_SHAPE && isBuiltinComposerStyle(e.OMC_COMPOSER_SHAPE)) out.composerShape = e.OMC_COMPOSER_SHAPE;
  // prompt-suggestion：OMC_SUGGEST=0/false 可关（显式赋值才覆盖文件/默认）
  if (e.OMC_SUGGEST !== undefined) out.suggestEnabled = /^(1|true|yes)$/i.test(e.OMC_SUGGEST);
  return out;
}

export function loadConfig(cwd: string): AppConfig {
  const projectFile = projectConfigFile(cwd);
  return { ...readJson(userConfigFile()), ...readJson(projectFile), ...fromEnv() };
}

/** 用户级配置读-改-写（保留其他键）；坏 JSON 按空对象覆盖（与 readJson 容忍语义一致），写失败静默 */
function updateUserConfig(
  key: 'vimMode' | 'model' | 'composerShape' | 'suggestEnabled',
  value: boolean | string,
): void {
  const file = userConfigFile();
  let raw: Record<string, unknown> = {};
  try {
    if (existsSync(file)) {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>;
      }
    }
  } catch {
    // 坏 JSON 当空对象
  }
  raw[key] = value;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
  } catch {
    // 写失败不影响当次操作
  }
}

/** /vim 持久化（ux-port P3.4） */
export function saveUserVimMode(enabled: boolean): void {
  updateUserConfig('vimMode', enabled);
}

/** /model Global 域持久化（选中模型写用户级 model 键，影响之后所有会话） */
export function saveUserModel(model: string): void {
  updateUserConfig('model', model);
}

/** /shape 持久化（写用户级 composerShape 键，影响之后所有会话；composer-shape 阶段） */
export function saveUserComposerShape(shape: string): void {
  updateUserConfig('composerShape', shape);
}

/** /suggest 持久化（写用户级 suggestEnabled 键，影响之后所有会话；prompt-suggestion 阶段） */
export function saveUserSuggestEnabled(enabled: boolean): void {
  updateUserConfig('suggestEnabled', enabled);
}

/** 读用户级 config.json 原始对象（坏 JSON/缺省 → {}）；插件配置区读写共用 */
function readUserConfigRaw(): Record<string, unknown> {
  const file = userConfigFile();
  try {
    if (!existsSync(file)) return {};
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 坏 JSON 当空对象
  }
  return {};
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 读插件自有配置区（用户级 config.json `plugins.<name>`；P4）。
 * 缺省/坏结构 → {}（容忍语义对齐 readJson）。
 */
export function readPluginConfig(name: string): Record<string, unknown> {
  const plugins = readUserConfigRaw().plugins;
  if (!isPlainObject(plugins)) return {};
  const section = plugins[name];
  return isPlainObject(section) ? section : {};
}

/**
 * 写插件自有配置区某键（`plugins.<name>.<key>`；保留其他键与顶层键；P4）。
 * 写失败静默（不阻塞插件主流程）。
 */
export function writePluginConfig(name: string, key: string, value: unknown): void {
  const raw = readUserConfigRaw();
  const plugins = isPlainObject(raw.plugins) ? raw.plugins : {};
  const section = isPlainObject(plugins[name]) ? plugins[name] : {};
  section[key] = value;
  plugins[name] = section;
  raw.plugins = plugins;
  try {
    mkdirSync(dirname(userConfigFile()), { recursive: true });
    writeFileSync(userConfigFile(), `${JSON.stringify(raw, null, 2)}\n`);
  } catch {
    // 写失败不影响当次操作
  }
}

/**
 * 读 omc 自管 MCP 禁用集（用户级 `config.json#mcp.disabled`；mcp-console P3）。
 * 缺省 / 坏结构 → []（容忍语义对齐其他配置读取）。
 */
export function readUserMcpDisabled(): string[] {
  const mcp = readUserConfigRaw().mcp;
  if (!isPlainObject(mcp)) return [];
  const d = mcp.disabled;
  return Array.isArray(d) ? d.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
}

/**
 * 写 omc 自管 MCP 禁用集（用户级 `config.json#mcp.disabled`；保留其他键）。
 * 去重保序；空数组 → 删 `disabled` 键（连带 `mcp` 空对象也删，避免噪声）。写失败静默。
 */
export function saveUserMcpDisabled(disabled: string[]): void {
  const raw = readUserConfigRaw();
  const section = isPlainObject(raw.mcp) ? { ...raw.mcp } : {};
  const uniq = [...new Set(disabled.filter((x) => typeof x === 'string' && x.length > 0))];
  if (uniq.length > 0) section.disabled = uniq;
  else delete section.disabled;
  if (Object.keys(section).length > 0) raw.mcp = section;
  else delete raw.mcp;
  try {
    mkdirSync(dirname(userConfigFile()), { recursive: true });
    writeFileSync(userConfigFile(), `${JSON.stringify(raw, null, 2)}\n`);
  } catch {
    // 写失败不影响当次操作
  }
}

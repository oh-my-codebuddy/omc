/**
 * memory-store.ts — 私有通道记忆存储（active-memory P1.1）。
 *
 * 定位：模型主动写记忆的**私有通道**落盘层 —— `save_memory(scope:'private')` 的落地实现。
 * 存储骨架对齐 CodeBuddy/Claude（「索引常驻 + 正文按需」，本机 `~/.codebuddy/projects/<slug>/memory/`
 * 是活样本）：
 *
 *   <projectStoreDir(cwd)>/memory/
 *     MEMORY.md                 ← 索引，一行一条 `- [name](file.md) — description`
 *     <type>_<slug>.md          ← 主题文件：YAML frontmatter(name/description/type) + 正文
 *
 * 硬约束：
 * - 本文件**不得** import `../ui` / pi-tui（纯逻辑 + `node:fs`，同 `memory-append.ts` 的约束）。
 * - **写入策略决策（P1.1 待定项落定，2026-10-14）**：
 *   - **私有通道（本文件）允许「整文件重写」** —— 该目录是 omc 独占的（不会与用户手写文件混放），
 *     且「同一主题的记忆被更新」是正常语义（`name` 稳定 → 同一文件名 → 覆盖重写正文/描述）。
 *     索引 `MEMORY.md` 也必须能更新既有行（改 description / 换文件名），故用
 *     「读 → 改 → 写临时文件 + `rename` 原子替换」。
 *   - **共享通道（AGENTS.md）仍严格「只 append、绝不覆盖」** —— 那是用户/团队的文件，见
 *     `memory-append.ts`。两条通道的策略差异是**刻意的**，不要互相套用。
 * - 所有返回值一律不抛错（上层据 `ok` / `error` 提示），与 `appendMemory` 一致。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { projectStoreDir } from '../config/paths';
import { memoryDebug } from './memory-append';

/** 记忆四类枚举（对齐 CodeBuddy / Claude：模型对这套语义已熟悉，提示词可直接借） */
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** 值是否为合法 `type`（P1.2 工具入参校验用） */
export function isMemoryType(v: unknown): v is MemoryType {
  return typeof v === 'string' && (MEMORY_TYPES as readonly string[]).includes(v);
}

/** 索引文件名（对齐 CodeBuddy） */
export const MEMORY_INDEX_FILE = 'MEMORY.md';
/** 记忆子目录名（相对项目存储目录） */
export const MEMORY_DIR_NAME = 'memory';
/** 索引文件缺省标题行（文件首次创建时补） */
export const MEMORY_INDEX_HEADER = '# Memory Index';
/** 索引行里 name 与 description 的分隔符（对齐 CodeBuddy 的 em dash） */
export const INDEX_SEPARATOR = '—';

/**
 * 记忆 MCP 工具的标识（**放在本文件**是有意的：`src/permission/bridge.ts` 需要按
 * 工具全名 + `scope` 做「私有自动放行」判定，而从 permission 层 import `memory-tool.ts`
 * 会连带拉起 SDK / zod 依赖；本文件只依赖 `node:fs` + 路径工具，是轻量引用点）。
 *
 * ⚠️ **服务名必须用下划线（`omc_memory`），不能用连字符** —— 实测（2026-10-14，真机 +
 * 探针）：CLI 把 MCP 工具名里的 `-` 归一成 `_`，于是同一个工具在两处名字不同：
 *   - `system/init.tools`（omc `/tools` 展示）：`mcp__omc-memory__save_memory`
 *   - `canUseTool` 回调 / assistant `tool_use` 块 / 模型侧：`mcp__omc_memory__save_memory`
 * 用下划线即让两处一致（否则权限判定按字符串比较**永不命中** → 私有记忆仍弹窗）。
 * 判定一律走 {@link isMemoryToolName}（归一化比较），不要直接比字符串。
 */
export const MEMORY_SERVER_NAME = 'omc_memory';
/** 工具短名 */
export const SAVE_MEMORY_TOOL_NAME = 'save_memory';
/** 工具在全名口径下的名字（MCP 工具顶层名即全名） */
export const SAVE_MEMORY_TOOL_FULL_NAME = `mcp__${MEMORY_SERVER_NAME}__${SAVE_MEMORY_TOOL_NAME}`;

/**
 * 是否为记忆工具（**归一化比较**：`-` 与 `_` 视作等价）。
 *
 * 为何要容错：CLI 在 `system/init.tools` 与 `canUseTool`/`tool_use` 两处对 MCP 工具名的
 * `-`/`_` 处理不一致（见 {@link MEMORY_SERVER_NAME} 注释）。服务名已用下划线，但保留这层
 * 归一可让权限判定对 CLI 侧将来再变规则免疫。
 */
export function isMemoryToolName(toolName: string): boolean {
  const canon = (s: string) => s.toLowerCase().replace(/-/g, '_');
  return canon(toolName) === canon(SAVE_MEMORY_TOOL_FULL_NAME);
}

/** 某 cwd 的私有记忆目录 `~/.omc/projects/<escaped-cwd>/memory` */
export function memoryDir(cwd: string): string {
  return join(projectStoreDir(cwd), MEMORY_DIR_NAME);
}

/** 索引文件绝对路径 `<memoryDir>/MEMORY.md` */
export function memoryIndexPath(cwd: string): string {
  return join(memoryDir(cwd), MEMORY_INDEX_FILE);
}

/** 主题文件绝对路径（`file` 为裸文件名，不接受路径分隔符） */
export function memoryTopicPath(cwd: string, file: string): string {
  return join(memoryDir(cwd), file);
}

/** ASCII slug（小写词字符，其余折叠为 `_`；CJK 等非 ASCII 全丢） */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
    .replace(/^_+|_+$/g, '');
}

/** djb2 base36（短哈希；与 `paths.ts` 同款，用于 slug 为空时的稳定兜底） */
function shortHash(s: string): string {
  const buf = Buffer.from(s, 'utf8');
  let h = 5381;
  for (let i = 0; i < buf.length; i++) h = (33 * h) ^ buf[i];
  return (h >>> 0).toString(36);
}

/**
 * 记忆名 + 类型 → 主题文件名 `<type>_<slug>.md`（对齐 CodeBuddy 命名，如 `feedback_no_commit.md`）。
 *
 * `name` 是**人类可读标题**（如「改动不提交，先展示 diff」），文件名取其 slug；
 * 全 CJK 等 slug 为空时回退 `shortHash(name)`（同一 name 恒得同一文件名 → 更新语义成立）。
 */
export function memoryFileName(name: string, type: MemoryType): string {
  return `${type}_${slugify(name) || shortHash(name)}.md`;
}

/** 文件名是否为安全裸名（无路径分隔符 / 无 `..` 逃逸） */
function isSafeFileName(file: string): boolean {
  return (
    file.length > 0 &&
    !file.includes('/') &&
    !file.includes('\\') &&
    file !== '.' &&
    file !== '..' &&
    !file.startsWith('.')
  );
}

/** 原子写：同目录临时文件 + `rename` 替换（对齐 `command-usage` 的写盘范式） */
function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

/** YAML 标量编码：特殊字符/首尾空白/换行 → JSON 双引号形式（JSON 转义是合法 YAML） */
function yamlScalar(v: string): string {
  const oneLine = v.replace(/\r?\n/g, ' ').trim();
  if (oneLine.length === 0) return '""';
  // 需要引号的情形：含 YAML 指示符、或首字符是特殊符号、或含前后空白
  if (/[:#"'{}[\],&*!|>%@`]/.test(oneLine) || /^[-?]/.test(oneLine) || /^\s|\s$/.test(v)) {
    return JSON.stringify(oneLine);
  }
  return oneLine;
}

/** 记忆主题写入入参 */
export interface MemoryTopicInput {
  /** 人类可读标题（也用作索引显示名） */
  name: string;
  /** 一行摘要（索引里跟在 `—` 后，也是将来判断相关性的依据） */
  description: string;
  type: MemoryType;
  /** 正文（不含 frontmatter） */
  body: string;
}

/** 记忆写入结果（私有 / 共享通用外形） */
export interface MemoryWriteResult {
  ok: boolean;
  /** 绝对路径 */
  path?: string;
  /** 裸文件名（私有通道；共享通道为 `AGENTS.md`） */
  file?: string;
  error?: string;
}

/** 渲染主题文件全文（frontmatter + 正文） */
export function renderMemoryTopic(input: MemoryTopicInput): string {
  const fm = [
    '---',
    `name: ${yamlScalar(input.name)}`,
    `description: ${yamlScalar(input.description)}`,
    `type: ${input.type}`,
    '---',
  ].join('\n');
  const body = input.body.replace(/\s+$/, '');
  return `${fm}\n\n${body}\n`;
}

/** 解析出的主题文件内容 */
export interface ParsedMemoryTopic {
  name: string;
  description: string;
  type: string;
  body: string;
}

/** 抽 `---` 包裹的 frontmatter 段（含正文；无 frontmatter → null） */
function splitFrontmatter(content: string): { fm: string; body: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!m) return null;
  return { fm: m[1]!, body: m[2] ?? '' };
}

/**
 * 解析主题文件（frontmatter 往返用）。无 frontmatter → null；
 * YAML 解析失败 → 回退逐行 `key: value` 粗解析（不丢内容）。
 */
export function parseMemoryTopic(content: string): ParsedMemoryTopic | null {
  const parts = splitFrontmatter(content);
  if (!parts) return null;
  let data: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = Bun.YAML.parse(parts.fm);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    data = null;
  }
  const scalar = (v: unknown): string => (v === undefined || v === null ? '' : String(v));
  // frontmatter 与正文之间以空行分隔 → 去掉正文前导换行（对齐 CodeBuddy 布局）
  const body = parts.body.replace(/^\n+/, '').replace(/\s+$/, '');
  if (data) {
    return {
      name: scalar(data.name).trim(),
      description: scalar(data.description).trim(),
      type: scalar(data.type).trim(),
      body,
    };
  }
  // 兜底：逐行粗解析
  const field = (key: string): string => {
    const raw = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(parts.fm)?.[1]?.trim() ?? '';
    return raw.replace(/^(['"])(.*)\1$/, '$2');
  };
  return {
    name: field('name'),
    description: field('description'),
    type: field('type'),
    body,
  };
}

/**
 * 写一个记忆主题文件（`<type>_<slug>.md`，**整文件重写** —— 见文件头「写入策略决策」）。
 * 同名（同 type + 同 slug）→ 覆盖更新。
 */
export function writeMemoryTopic(cwd: string, input: MemoryTopicInput): MemoryWriteResult {
  const name = input.name.trim();
  if (!name) return { ok: false, error: 'name 为空' };
  if (!isMemoryType(input.type)) return { ok: false, error: `type 非法：${String(input.type)}` };

  const file = memoryFileName(name, input.type);
  if (!isSafeFileName(file)) return { ok: false, error: `文件名非法：${file}` };

  const path = memoryTopicPath(cwd, file);
  try {
    writeFileAtomic(path, renderMemoryTopic({ ...input, name }));
  } catch (e) {
    return { ok: false, error: `写入失败：${e instanceof Error ? e.message : String(e)}` };
  }
  memoryDebug(`STORE_WRITE private file=${file}`);
  return { ok: true, path, file };
}

/** 索引条目 */
export interface MemoryIndexEntry {
  /** 显示名（`[]` 内文本） */
  name: string;
  /** 链接目标（裸文件名） */
  file: string;
  /** `—` 后的描述（可能为空串） */
  description: string;
}

/** 单条索引行（格式化） */
export function formatIndexEntry(entry: MemoryIndexEntry): string {
  const desc = entry.description.trim();
  return desc
    ? `- [${entry.name}](${entry.file}) ${INDEX_SEPARATOR} ${desc}`
    : `- [${entry.name}](${entry.file})`;
}

/** 解析单条索引行；非索引行 → null */
export function parseIndexLine(line: string): MemoryIndexEntry | null {
  const m = /^\s*-\s*\[(.+?)\]\((.+?)\)\s*(?:[—–]\s*(.*))?\s*$/.exec(line);
  if (!m) return null;
  return { name: m[1]!, file: m[2]!, description: (m[3] ?? '').trim() };
}

/** 读索引全文（缺失/不可读 → 空串） */
export function readMemoryIndex(cwd: string): string {
  try {
    return readFileSync(memoryIndexPath(cwd), 'utf8');
  } catch {
    return '';
  }
}

/** 解析索引全文 → 条目列表（跳过标题/空行/非索引行） */
export function parseMemoryIndex(content: string): MemoryIndexEntry[] {
  const out: MemoryIndexEntry[] = [];
  for (const line of content.split('\n')) {
    const e = parseIndexLine(line);
    if (e) out.push(e);
  }
  return out;
}

/**
 * 增改索引条目（**整文件重写**，见文件头「写入策略决策」）。
 *
 * - 已存在同 `file` 的条目 → 原地替换该行（保留位置与其他行逐字不变）；
 * - 否则 → 追加到末尾（文件缺失/无标题时先补 `# Memory Index` 头）。
 */
export function upsertIndexEntry(cwd: string, entry: MemoryIndexEntry): MemoryWriteResult {
  if (!isSafeFileName(entry.file)) return { ok: false, error: `索引链接非法：${entry.file}` };
  const path = memoryIndexPath(cwd);
  const existing = readMemoryIndex(cwd);
  const lines = existing.length > 0 ? existing.split('\n') : [];

  const newLine = formatIndexEntry(entry);
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseIndexLine(lines[i]!);
    if (parsed && parsed.file === entry.file) {
      lines[i] = newLine;
      replaced = true;
      break;
    }
  }

  let content: string;
  if (replaced) {
    content = lines.join('\n');
    if (!content.endsWith('\n')) content += '\n';
  } else {
    const base = existing.trim().length > 0 ? existing.replace(/\n*$/, '\n') : `${MEMORY_INDEX_HEADER}\n\n`;
    // 已有内容结尾已有换行 → 直接接新行；否则补换行
    const sep = base.endsWith('\n') ? '' : '\n';
    content = `${base}${sep}${newLine}\n`;
  }

  try {
    writeFileAtomic(path, content);
  } catch (e) {
    return { ok: false, error: `写入失败：${e instanceof Error ? e.message : String(e)}` };
  }
  memoryDebug(`STORE_WRITE index updated=${replaced} file=${entry.file}`);
  return { ok: true, path, file: MEMORY_INDEX_FILE };
}

/** 索引文件是否已存在（P1.4 注入判断用） */
export function memoryIndexExists(cwd: string): boolean {
  return existsSync(memoryIndexPath(cwd));
}

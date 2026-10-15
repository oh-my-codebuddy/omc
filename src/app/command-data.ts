/**
 * command-data.ts — custom command 本地发现（custom-commands P2）。
 *
 * 发现面（P1 定论 C：本地扫描为主，频道仅作热更新信号）：
 * - 用户级 `~/.codebuddy/commands`（scope=user）
 * - 项目级 `<cwd>/.codebuddy/commands`（scope=project）
 * 递归收集 `.md`，**子目录层以 `:` 连接**（`a/b/c.md` → `a:b:c`；对齐 CLI
 * `parseCommandFile`：`fullPath` 目录段 `join(":")` + 去 `.md` 的文件名）。
 * 名字取自**路径而非 frontmatter**（CLI 无 `name` 字段语义）。
 *
 * frontmatter（对齐 CLI `parseCommandFile` 字段面）：
 * `description` / `argument-hint` / `allowed-tools`（list 或逗号分隔字符串，
 * 复刻 CLI `MarkdownUtils.parseListField` 的「花括号内逗号不切」语义）/
 * `model` / `disable-model-invocation`。
 * 解析用 `Bun.YAML.parse`（与 skill-system P2 同口径）；非法 YAML 回落旧正则兜底。
 *
 * 去重：**project 覆盖 user**（对齐 CLI `commandMap` 按 `[undefined,'user','project']`
 * 顺序 set，后者胜）。同根内同名不会发生（名字即相对路径，路径唯一）。
 *
 * 全部 best-effort：目录/文件不可读跳过，不抛错。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { Glob } from 'bun';

/**
 * 命令发现来源（`/` 列表来源标注 + 覆盖优先级）。
 * `builtin` = omc 自持模板的 prompt 型内置命令（custom-commands P5 T6；
 * 不来自磁盘扫描，由 `src/commands/prompt-templates.ts` 提供）。
 */
export type CommandScope = 'user' | 'project' | 'builtin';

/** 完整自定义命令条目（P3 渲染/执行用 body + filePath） */
export interface CustomCommandEntry {
  /** `:` 分段的命令名（子目录形态），不含前导 `/` */
  name: string;
  description: string;
  /** frontmatter `argument-hint`（`/` 补全提示） */
  argumentHint?: string;
  scope: CommandScope;
  /** .md 绝对路径（P3 读正文/渲染基准） */
  filePath: string;
  /** 剥 frontmatter 后的正文（P3 渲染输入） */
  body: string;
  /** frontmatter `allowed-tools`；未声明 = [] */
  allowedTools: string[];
  /** frontmatter `model`；未声明 = undefined */
  model?: string;
  /** frontmatter `disable-model-invocation`；未声明 = false */
  disableModelInvocation: boolean;
}

/** frontmatter 解析结果（description 可能为空串） */
export interface CommandFrontmatter {
  description: string;
  argumentHint?: string;
  allowedTools: string[];
  model?: string;
  disableModelInvocation: boolean;
}

/** 递归深度上限（相对扫描根；命令目录通常极浅，防深树炸扫描） */
export const COMMAND_MAX_DEPTH = 5;

/** 单次扫描文件数上限（防巨目录；真实环境远低于此） */
const COMMAND_SCAN_FILE_CAP = 2000;

/**
 * 合法命令名：`:` 分段，每段 `[a-z0-9_-]+` —— **与 `parseSlash` 完全同口径**
 * （deriveCommandName 已 lowercase）。CLI 命令名大小写敏感，omc 统一小写是
 * 有意差异：保证「补全里看得见的名字 ⇒ 输入必能命中」。
 */
const COMMAND_NAME_RE = /^[a-z0-9_-]+(?::[a-z0-9_-]+)*$/;

/** 抽 `---` 包裹的 frontmatter 段（无则 undefined） */
function extractFrontmatter(content: string): string | undefined {
  return /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1];
}

/** 剥 frontmatter 返回正文（与 skill-invoke.stripFrontmatter 同口径） */
export function stripCommandFrontmatter(content: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---/.exec(content);
  if (!m) return content.trim();
  return content.slice(m[0].length).trim();
}

/** 标量转字符串（YAML 可能给出 number/bool；null/undefined → ''） */
function scalarString(v: unknown): string {
  if (v === undefined || v === null) return '';
  return typeof v === 'string' ? v : String(v);
}

/**
 * 列表字段解析（复刻 CLI `MarkdownUtils.parseListField` + `splitByCommaRespectingBraces`）：
 * - 数组 → 逐项 trim 去空
 * - 字符串 → 按逗号切分，但 `{}` 内的逗号不切（工具规格如 `Bash(git add:*)` 无碍，
 *   但 `Bash(echo {a,b})` 形态必须保住）
 * - 其他/空 → []
 */
export function parseListField(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => scalarString(x).trim()).filter(Boolean);
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return [];
    const out: string[] = [];
    let buf = '';
    let brace = 0;
    for (const ch of s) {
      if (ch === '{') {
        brace += 1;
        buf += ch;
      } else if (ch === '}') {
        brace = Math.max(0, brace - 1);
        buf += ch;
      } else if (ch === ',' && brace === 0) {
        const t = buf.trim();
        if (t) out.push(t);
        buf = '';
      } else {
        buf += ch;
      }
    }
    const t = buf.trim();
    if (t) out.push(t);
    return out;
  }
  return [];
}

/** 旧正则兜底 —— 只在 `Bun.YAML.parse` 抛错时用（命令只关心 description 块/行） */
function parseCommandFieldsLegacy(fm: string): CommandFrontmatter {
  const block = /^description:\s*[|>][-+]?\s*\n((?:^[ \t]+.*(?:\n|$))*)/m.exec(fm);
  if (block) {
    return {
      description: block[1]!.replace(/^[ \t]+/gm, '').trim(),
      allowedTools: [],
      disableModelInvocation: false,
    };
  }
  const raw = /^description:\s*(.+)$/m.exec(fm)?.[1]?.trim();
  const description = raw ? raw.replace(/^(['"])(.*)\1$/, '$2') : '';
  return { description, allowedTools: [], disableModelInvocation: false };
}

/**
 * 解析命令 md 的 frontmatter；无 frontmatter → null。
 * 语义对齐 CLI `parseCommandFile`：`disable-model-invocation` 非布尔即不禁止。
 */
export function parseCommandFrontmatter(content: string): CommandFrontmatter | null {
  const fm = extractFrontmatter(content);
  if (!fm) return null;
  let data: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = Bun.YAML.parse(fm);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    return parseCommandFieldsLegacy(fm);
  }
  if (!data) return parseCommandFieldsLegacy(fm); // 非映射（空/标量/数组）→ 兜底
  const out: CommandFrontmatter = {
    description: scalarString(data.description).trim(),
    allowedTools: parseListField(data['allowed-tools']),
    disableModelInvocation: data['disable-model-invocation'] === true,
  };
  const hint = scalarString(data['argument-hint']).trim();
  if (hint) out.argumentHint = hint;
  const model = scalarString(data.model).trim();
  if (model) out.model = model;
  return out;
}

/** 命令扫描根（顺序即收集顺序；project 后收集 ⇒ 覆盖 user） */
export interface CommandScanRoot {
  root: string;
  scope: CommandScope;
}

function commandScanRoots(cwd: string): CommandScanRoot[] {
  return [
    { root: join(homedir(), '.codebuddy', 'commands'), scope: 'user' },
    { root: join(cwd, '.codebuddy', 'commands'), scope: 'project' },
  ];
}

/** 收集单个扫描根下的 `.md` 绝对路径（逐层通配，深度 ≤ COMMAND_MAX_DEPTH） */
function scanCommandFiles(root: string): string[] {
  const files: string[] = [];
  for (let d = 0; d <= COMMAND_MAX_DEPTH; d++) {
    const pattern =
      d === 0 ? join(root, '*.md') : join(root, ...Array<string>(d).fill('*'), '*.md');
    try {
      // followSymlinks：Bun Glob 默认不跟随软链目录（同 context-data 的 skill 扫描），
      // 而命令目录里的软链 .md / 软链子目录会静默漏掉。pattern 深度固定，无环风险。
      for (const file of new Glob(pattern).scanSync({ onlyFiles: true, followSymlinks: true })) {
        files.push(file);
        if (files.length >= COMMAND_SCAN_FILE_CAP) return files;
      }
    } catch {
      // 目录不存在：跳过
    }
  }
  return files;
}

/**
 * 命令名派生：相对扫描根的目录段 + 去 `.md` 的文件名，以 `:` 连接，
 * **整体小写**（对齐 `parseSlash` 的小写归一）。
 * `<root>/a/b/c.md` → `a:b:c`；`<root>/X.md` → `x`。
 */
function deriveCommandName(root: string, filePath: string): string {
  const rel = relative(root, filePath);
  const parts = rel.split(sep).filter(Boolean);
  const last = parts.pop();
  if (!last) return '';
  const stem = basename(last, '.md');
  return [...parts, stem].join(':').toLowerCase();
}

/** 全量收集结果：`entries` 为去重后条目；`shadowed` 为被 project 覆盖的 user 条目数；`skipped` 为非法名跳过数 */
export interface CommandEntriesResult {
  entries: CustomCommandEntry[];
  shadowed: number;
  skipped: number;
}

/**
 * 枚举本地自定义命令完整条目。规则见文件头注释。
 * project 条目覆盖同名 user 条目（后写胜），被覆盖计入 `shadowed`。
 */
export function collectCommandEntriesDetailed(
  cwd: string,
  roots?: CommandScanRoot[],
): CommandEntriesResult {
  const byName = new Map<string, CustomCommandEntry>();
  let shadowed = 0;
  let skipped = 0;
  for (const spec of roots ?? commandScanRoots(cwd)) {
    if (!existsSync(spec.root)) continue;
    for (const file of scanCommandFiles(spec.root)) {
      let entry: CustomCommandEntry;
      try {
        entry = buildEntry(spec, file);
      } catch {
        continue; // 单文件失败跳过
      }
      if (!entry.name || !COMMAND_NAME_RE.test(entry.name)) {
        skipped += 1; // 名不合法的命令进不了 omc 的 `/` 通道，直接丢弃
        continue;
      }
      if (byName.has(entry.name)) shadowed += 1; // 后收集的 project 覆盖 user
      byName.set(entry.name, entry);
    }
  }
  return { entries: [...byName.values()], shadowed, skipped };
}

function buildEntry(spec: CommandScanRoot, file: string): CustomCommandEntry {
  const name = deriveCommandName(spec.root, file);
  const raw = readFileSync(file, 'utf8');
  const fields = parseCommandFrontmatter(raw);
  return {
    name,
    description: fields?.description ?? '',
    argumentHint: fields?.argumentHint,
    scope: spec.scope,
    filePath: file,
    body: stripCommandFrontmatter(raw),
    allowedTools: fields?.allowedTools ?? [],
    model: fields?.model,
    disableModelInvocation: fields?.disableModelInvocation ?? false,
  };
}

/**
 * 枚举本地自定义命令（`collectCommandEntriesDetailed` 的 entries 投影）。
 * 非法名条目已在收集阶段丢弃；如需 `shadowed`/`skipped` 统计用 Detailed 版。
 */
export function collectCommandEntries(cwd: string): CustomCommandEntry[] {
  return collectCommandEntriesDetailed(cwd).entries;
}

/** 命令名是否可被 omc `/` 通道识别（`:` 分段，合法字符集） */
export function isCommandNameValid(name: string): boolean {
  return COMMAND_NAME_RE.test(name);
}

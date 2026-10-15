/**
 * command-invoke.ts — custom command 渲染管道（custom-commands P3 T2）。
 *
 * 复刻 CLI `CustomCommandRenderer.render(command, input)` + `ReferenceService.process`
 * （bundle `dist-server/codebuddy.js` @1831434 / @2633300 / @3997848；T1 定论见
 * docs/plan/custom-commands/p3-render-exec.md）。**命令执行走 `render` 而非
 * `processContent`**（后者只服务 skill 正文加载）。
 *
 * 管道顺序（与 CLI 一致，勿调换）：
 *   extractArguments（剥命令名 + shell-like 引号切分；omc 侧剥前缀已由 `parseSlash`
 *   完成，故此处只做引号切分 `splitArguments`）
 *   → replaceParameters（先 `$1..$N`，再 `$ARGUMENTS`，超出的 args 追加 `ARGUMENTS:`）
 *   → executeInlineBash（`!`cmd`` 真实 shell 执行）
 *   → 文件引用展开（`@path`）
 *
 * 与 skill-invoke.ts 同构：同步实现（readFileSync / shell 同步等待），纯函数化便于单测，
 * 副作用面（shell 执行器）可注入。
 *
 * 已知容差（不影响本机 72 个 gsd 命令，正文均无 `!cmd`/`@ref`…）：
 * - CLI 的 token 截断（`truncateByTokenCap`）未复刻；>256KB 文件直接保留 `@path` 字面。
 * - CLI 的 `${VAR}` 模板渲染（`promptRenderer`）不进本管道（那是 CLI 内部模板变量）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { CommandScope, CustomCommandEntry } from './command-data';

/** 内联 shell（`!`cmd``）匹配：与 CLI `executeInlineBash` 同正则 */
const INLINE_BASH_RE = /!`([^`]+)`/g;

/** `@file` 引用匹配：与 CLI `ImportUtils` 同正则（负向后顾 = 前须空白/行首） */
const IMPORT_RE = /(?<!\S)@([^\s@\n]+)/g;

/** 文件引用递归深度上限（CLI `MAX_IMPORT_DEPTH`） */
export const MAX_IMPORT_DEPTH = 5;
/** 单文件内联上限 256KB（CLI `ImportUtils` 常量 eI=262144）：超限保留 `@path` 字面 */
export const MAX_IMPORT_FILE_SIZE = 262144;
/** 目录引用内联条目上限（CLI `MAX_IMPORT_DIR_ENTRIES`；omc 取同数量级近似值） */
export const MAX_IMPORT_DIR_ENTRIES = 1000;

/** 内联 shell 单条执行默认超时（CLI 无超时；omc 防交互式命令挂死 TUI） */
export const INLINE_BASH_TIMEOUT_MS = 30_000;

/** transcript 命令卡片数据（对齐 pi-tui `SkillPromptDetails` 形态但带命令语义） */
export interface CustomCommandDetails {
  /** `:` 分段的命令名（不含前导 `/`） */
  name: string;
  scope: CommandScope;
  /** 命令 md 绝对路径（卡片可点链接） */
  path: string;
  /** 渲染后注入正文的行数 */
  lineCount: number;
  /** 渲染后正文（不含 `<command-message>` 头；卡片展开展示用） */
  rendered: string;
  /** 用户原始 args（trim 后；空则省略） */
  args?: string;
  /** 提交原文（队列 Alt+↑ 取回草稿用） */
  prompt?: string;
  /** 实际执行过的内联 shell 命令（`!`cmd``，T6 决策 a：无条件执行 + 可审计回显） */
  inlineCommands: string[];
  /**
   * frontmatter `allowed-tools` 声明值（P4 定案：**仅解析展示，不生效**）。
   * 对齐 CLI 现状 —— `parseCommandFile` 存入命令对象但执行链路未消费；omc 只在
   * 命令卡展开体回显声明，**不接** `canUseTool`/权限白名单。空数组 = 未声明。
   */
  allowedTools: string[];
}

export interface BuiltCommandPrompt {
  /** 注入模型的完整消息（CLI `<command-message>` 头 + 渲染后正文） */
  message: string;
  /** transcript 命令卡片数据 */
  details: CustomCommandDetails;
}

export interface RenderCommandOptions {
  /** `@file` 相对路径基准（CLI 回退 `PathUtils.getWorkDir()`） */
  cwd?: string;
  /** 提交原文（用于卡片/草稿恢复） */
  prompt?: string;
  /** 内联 shell 执行器（测试注入；默认 `/bin/sh -c`，失败/超时返回空串） */
  execInline?: (command: string) => string;
}

/**
 * shell-like 引号切分（等价 CLI `extractArguments` 的切分部分，剥命令名前缀由
 * `parseSlash` 完成）：支持 `"…"` / `'…'`，引号内空白不切分、引号字符本身不入参。
 * 无转义处理（与 CLI 一致）。
 */
export function splitArguments(text: string): string[] {
  const rest = text.trim();
  if (!rest) return [];
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  let quoteChar = '';
  for (const ch of rest) {
    if (inQuote && ch === quoteChar) {
      inQuote = false;
      quoteChar = '';
    } else if (!inQuote && (ch === '"' || ch === "'")) {
      inQuote = true;
      quoteChar = ch;
    } else if (!inQuote && /\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * 占位符替换（复刻 CLI `replaceParameters`）：
 * 1. `$1..$N`：N = 正文中出现的最大编号，只替换 `min(argv.length, N)` 个
 * 2. `$ARGUMENTS` → `argv.join(" ")`（**在 `$N` 之后**）
 * 3. `argv.length > N` 时末尾追加 `\n\n\nARGUMENTS: <剩余 join 空格>`
 *
 * ⚠️ CLI 用字符串 replacement（args 含 `$&` 等会二次展开）；omc 用函数式避开该陷阱。
 */
export function replaceParameters(content: string, argv: readonly string[]): string {
  if (!content || argv.length === 0) return content;
  let out = content;
  const matches = content.match(/\$(\d+)\b/g);
  const maxN = matches ? Math.max(...matches.map((m) => parseInt(m.substring(1), 10))) : 0;
  for (let i = 0; i < Math.min(argv.length, maxN); i++) {
    out = out.replace(new RegExp(`\\$${i + 1}\\b`, 'g'), () => argv[i]!);
  }
  out = out.replace(/\$ARGUMENTS\b/g, () => argv.join(' '));
  if (argv.length > maxN) out += '\n\n\nARGUMENTS: ' + argv.slice(maxN).join(' ');
  return out;
}

/** 默认内联 shell 执行器：`/bin/sh -c`，`stdout || stderr || ''`，失败返回空串（对齐 CLI） */
function defaultExecInline(command: string, cwd: string): string {
  try {
    const proc = Bun.spawnSync(['/bin/sh', '-c', command], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: INLINE_BASH_TIMEOUT_MS,
    });
    const stdout = proc.stdout ? proc.stdout.toString() : '';
    const stderr = proc.stderr ? proc.stderr.toString() : '';
    return (stdout || stderr || '').trim();
  } catch {
    return '';
  }
}

/**
 * 内联 shell 执行（复刻 CLI `executeInlineBash`）：逐匹配 `exec`、`s.replace(首个匹配)`；
 * 失败替换为空串。执行过的命令追加进 `executed`（T6 审计回显）。
 */
export function executeInlineBash(
  text: string,
  cwd: string,
  exec: (command: string) => string,
  executed: string[] = [],
): string {
  if (!text) return text;
  let out = text;
  const re = new RegExp(INLINE_BASH_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const command = m[1]!.trim();
    let replacement = '';
    try {
      replacement = exec(command);
    } catch {
      replacement = '';
    }
    executed.push(command);
    out = out.replace(m[0], () => replacement);
  }
  return out;
}

/** 前缀中 ``` 数为奇（在代码块内）或行内反引号数为奇 → 该 `@ref` 不展开（CLI `isInCodeBlock`） */
function isInCodeBlock(text: string, index: number): boolean {
  const prefix = text.substring(0, index);
  const fences = (prefix.match(/```/g) || []).length;
  const inline = (prefix.match(/(?<!`)(`(?!`))/g) || []).length;
  return fences % 2 === 1 || inline % 2 === 1;
}

/** `@file` 路径解析（复刻 CLI `ImportUtils.resolveImportPath`）：`~/` → home；绝对直用；余者以命令文件目录（首层为 cwd）为基准 */
export function resolveImportPath(
  importPath: string,
  baseFileDir: string | undefined,
  cwd: string,
): string {
  if (importPath.startsWith('~/')) return resolve(homedir(), importPath.slice(2));
  if (isAbsolute(importPath)) return resolve(importPath);
  return resolve(baseFileDir ?? cwd, importPath);
}

interface ImportRef {
  fullMatch: string;
  resolvedPath: string;
}

/** 提取 `@ref`（跳过代码块/行内 code）；baseFile = 当前文本所属文件路径（首层 undefined） */
function extractImports(text: string, baseFile: string | undefined, cwd: string): ImportRef[] {
  const out: ImportRef[] = [];
  const re = new RegExp(IMPORT_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (isInCodeBlock(text, m.index)) continue;
    out.push({
      fullMatch: m[0],
      resolvedPath: resolveImportPath(m[1]!, baseFile ? dirname(baseFile) : undefined, cwd),
    });
  }
  return out;
}

/** 目录引用内联（复刻 CLI `getDirectoryListing`） */
function directoryListing(dir: string): string {
  try {
    const entries = readdirSync(dir).sort();
    const shown = entries.slice(0, MAX_IMPORT_DIR_ENTRIES).map((e) => `- ${e}`);
    if (entries.length > MAX_IMPORT_DIR_ENTRIES) {
      shown.push(`… and ${entries.length - MAX_IMPORT_DIR_ENTRIES} more entries`);
    }
    return `Directory listing for ${dir}: ${shown.join('\n')}`;
  } catch {
    return `Failed to read directory: ${dir}`;
  }
}

/**
 * 文件引用展开（复刻 CLI `ReferenceService.processImports`）：递归深度 5、循环引用检测、
 * 目录列清单、>256KB 保留原样、读失败静默跳过。
 */
export function expandFileReferences(
  text: string,
  cwd: string,
  depth = 0,
  seen: Set<string> = new Set(),
  baseFile?: string,
): string {
  if (!text || depth >= MAX_IMPORT_DEPTH) return text;
  let out = text;
  for (const ref of extractImports(text, baseFile, cwd)) {
    try {
      if (seen.has(ref.resolvedPath)) continue; // 循环引用
      seen.add(ref.resolvedPath);
      let content: string;
      if (statSync(ref.resolvedPath).isDirectory()) {
        content = directoryListing(ref.resolvedPath);
      } else {
        const { size } = statSync(ref.resolvedPath);
        if (size > MAX_IMPORT_FILE_SIZE) continue; // 过大：保留 @path 字面
        const raw = readFileSync(ref.resolvedPath, 'utf8');
        content = expandFileReferences(raw, cwd, depth + 1, new Set(seen), ref.resolvedPath);
      }
      // 函数式替换：避免内容中的 `$&` 等被 String.replace 二次解释
      out = out.replace(ref.fullMatch, () => content);
    } catch {
      // ENOENT 等：静默跳过该引用
    }
  }
  return out;
}

/**
 * 完整渲染：正文 → 四步管道 → `<command-message>` 头 + 渲染正文。
 * 抛错面为零（各步失败均降级）；文件读取由 `entry.body`（已读入）避免二次 IO。
 */
export function renderCustomCommand(
  entry: CustomCommandEntry,
  args: string,
  opts: RenderCommandOptions = {},
): BuiltCommandPrompt {
  const cwd = opts.cwd ?? process.cwd();
  const argv = splitArguments(args);
  const executed: string[] = [];
  const exec = opts.execInline ?? ((cmd: string) => defaultExecInline(cmd, cwd));

  let rendered = replaceParameters(entry.body, argv);
  rendered = executeInlineBash(rendered, cwd, exec, executed);
  rendered = expandFileReferences(rendered, cwd);

  const trimmedArgs = args.trim();
  const head =
    `<command-message>${entry.name}</command-message> <command-name>/${entry.name}</command-name>` +
    (trimmedArgs ? ` <command-args>${trimmedArgs}</command-args>` : '');
  const message = `${head}\n${rendered}`;

  return {
    message,
    details: {
      name: entry.name,
      scope: entry.scope,
      path: entry.filePath,
      lineCount: rendered ? rendered.split('\n').length : 0,
      rendered,
      args: trimmedArgs || undefined,
      prompt: opts.prompt,
      inlineCommands: executed,
      allowedTools: [...entry.allowedTools],
    },
  };
}

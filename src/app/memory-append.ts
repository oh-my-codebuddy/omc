/**
 * memory-append.ts — 输入框 `#` 记忆快捷（input-interactions P2）。
 *
 * 语义对齐 codebuddy 的 `#` 前缀（文档 `interactive-mode.md:52`「记忆快捷方式 - 添加到
 * CODEBUDDY.md」；bundle 前缀表 `{"?": HELP, "!": BASH, "#": MEMORY}`），但**实现路径不同**
 * （P2.1 探明，详见 `docs/plan/input-interactions/p2-memory-shortcut.md`）：
 *   - codebuddy：`#` → 构建 `<user-memory-input>/<user-memory-scope>` **用户消息** → **模型**调
 *     `SaveMemory` 工具 → `MemoryManager.addFact` 落盘。
 *   - omc：`#` → **本地直接写盘**（不经模型，更快、更确定）。
 *
 * 写入格式逐字对齐 codebuddy `addFact`：
 *   条目 = `- <内容>`（trim → 去前导连字符/空白 → 加 `- `）；文件首次写入补 section header
 *   `## CodeBuddy Added Memories`；**条目去重**（文件已含该行则跳过）。
 * 与 codebuddy 的唯一差异：其 section 内多条 fact 会以空格拼成一行，omc 一律**每条独立一行**。
 *
 * 硬约束：**只 append、绝不覆盖**（`appendFileSync`，不做「读-改-写整文件」）、**路径白名单校验**
 * （防 `# 内容` 经注入写到候选集外的任意路径）。本文件**不得** import `../ui` / pi-tui（纯逻辑 + node:fs）。
 */
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 测试可观测性：`OMC_DEBUG_MEMORY=<path>` 时追加 SUBMIT/WRITE 事件行
 * （同 `bash-mode.ts` 的 `bashDebug`，供 `scripts/smoke-memory-shortcut-pty.sh` 断言）。
 */
const memoryDebugPath = process.env.OMC_DEBUG_MEMORY;

export function memoryDebug(line: string): void {
  if (!memoryDebugPath) return;
  try {
    appendFileSync(memoryDebugPath, line + '\n');
  } catch {
    // 调试通道失败不影响主流程
  }
}

/**
 * 追加进 memory 文件的 section 标题。
 * 对齐 codebuddy `resolveMemorySectionHeader()` = `## ${productName} Added Memories`
 * （productName 常量 = `"CodeBuddy"`，bundle 模块 86758）。
 */
export const MEMORY_SECTION_HEADER = '## CodeBuddy Added Memories';

/** `#` 前缀解析结果（`content` 已 trim） */
export interface ParsedMemoryInput {
  /** 去掉 `#` 前缀并 trim 后的内容（空串 = 只敲了 `#`） */
  content: string;
}

/**
 * 前缀解析：仅当文本**以 `#` 开头**时命中。
 * 非 `#` 开头 → `null`（落回普通对话 / 斜杠命令路径）。
 */
export function parseMemoryInput(text: string): ParsedMemoryInput | null {
  if (!text.startsWith('#')) return null;
  return { content: text.slice(1).trim() };
}

/**
 * 内容 → memory 条目（`- <内容>`）。
 * 复刻 codebuddy `addFact`：`fact.trim().replace(/^(-+\s*)+/, '').trim()` 后加 `- ` 前缀，
 * 故 `# - foo` / `# --- foo` 都不会写出双重连字符。
 */
export function toMemoryBullet(content: string): string {
  const trimmed = content.trim().replace(/^(-+\s*)+/, '').trim();
  return `- ${trimmed}`;
}

/**
 * 「已有内容」与「待追加块」之间的换行分隔（复刻 codebuddy `ensureNewlineSeparation`）：
 * 空 / 已双换行结尾 → `''`；单换行结尾 → `'\n'`；否则 → `'\n\n'`。
 */
export function ensureNewlineSeparation(content: string): string {
  if (content.length === 0 || content.endsWith('\n\n') || content.endsWith('\r\n\r\n')) return '';
  if (content.endsWith('\n') || content.endsWith('\r\n')) return '\n';
  return '\n\n';
}

export interface AppendMemoryOptions {
  /**
   * 允许写入的路径白名单（= `collectMemoryFileCandidates(cwd)` 的候选集）。
   * 提供且非空时，目标不在集内 → 拒绝写入（realpath 归一，容忍 symlink）。
   */
  allowedPaths?: string[];
}

export interface AppendMemoryResult {
  ok: boolean;
  path: string;
  /** 实际写入的文本（去重 / 失败时为空串） */
  appended: string;
  /** 文件此前不存在（本次创建） */
  created: boolean;
  /** 命中条目去重（已含相同条目 → 未写入） */
  duplicate: boolean;
  error?: string;
}

/** 路径归一（realpath；不可达 → resolve 的绝对路径，容忍「待创建」的新文件） */
function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * 把一条记忆追加到目标 memory 文件（**只 append**）。
 *
 * - 条目 = `- <内容>`；**行级去重**（已含相同条目 → `duplicate:true`，不写）。
 * - 文件不含 section header 时，先追加 `\n…\n## CodeBuddy Added Memories\n` 再写条目。
 * - 文件不存在 → 创建（`created:true`），内容为 header + 条目。
 * - `allowedPaths` 提供时做白名单校验；拒绝写入不触碰文件。
 *
 * 返回值一律不抛错（UI 侧据 `ok` / `error` 提示）。
 */
export function appendMemory(
  filePath: string,
  content: string,
  opts: AppendMemoryOptions = {},
): AppendMemoryResult {
  const fail = (error: string): AppendMemoryResult => ({
    ok: false,
    path: filePath,
    appended: '',
    created: false,
    duplicate: false,
    error,
  });

  const bullet = toMemoryBullet(content);
  if (bullet === '- ') return fail('内容为空');

  if (opts.allowedPaths && opts.allowedPaths.length > 0) {
    const target = canonicalPath(filePath);
    if (!opts.allowedPaths.some((p) => canonicalPath(p) === target)) {
      return fail('路径不在允许的记忆文件候选中');
    }
  }

  let existing = '';
  let created = false;
  try {
    existing = readFileSync(filePath, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') created = true;
    else return fail(`读取失败：${e instanceof Error ? e.message : String(e)}`);
  }

  // 条目去重：行级比较（codebuddy 用子串 `includes`，omc 收紧为「整行匹配」，避免误判）
  if (existing.split('\n').some((line) => line.trim() === bullet)) {
    return { ok: true, path: filePath, appended: '', created: false, duplicate: true };
  }

  let chunk = '';
  if (!existing.includes(MEMORY_SECTION_HEADER)) {
    chunk += `${ensureNewlineSeparation(existing)}${MEMORY_SECTION_HEADER}\n`;
  }
  chunk += `${bullet}\n`;

  try {
    appendFileSync(filePath, chunk, 'utf8');
  } catch (e) {
    return fail(`写入失败：${e instanceof Error ? e.message : String(e)}`);
  }
  return { ok: true, path: filePath, appended: chunk, created, duplicate: false };
}

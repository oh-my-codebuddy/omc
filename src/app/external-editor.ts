/**
 * external-editor.ts — Ctrl+G 外部编辑器（input-interactions P3）。
 *
 * 语义对齐 codebuddy「Ctrl+G 打开外部编辑器编辑提示词」/ omp
 * `coding-agent/src/utils/external-editor.ts`（权威范式，逐条照搬）：
 *   ① `getEditorCommand()`：`$VISUAL` → `$EDITOR` →（POSIX 两者皆空 `undefined`，
 *      提示用户配置；Windows 回退 `notepad`，同 omp）。
 *   ② `openInEditor()`：写临时文件 → spawn 编辑器（**inherit 真 pty**，让 vim 等
 *      TUI 编辑器渲染到可见窗格）→ 退出码 0 读回文本（默认去一个尾换行）、非 0 返回 null。
 *   ③ **调用方负责 `tui.stop()` / `tui.start()` 包夹**（omp `interactive-mode.ts:5503`
 *      `#openPlanInExternalEditor`）—— 本文件不 import ui/pi-tui，只做纯逻辑。
 *
 * `$EDITOR` 可含参数（如 `code -w`）：一律经 `sh -c '<cmd> "$1"' sh <tmpFile>` 传参，
 * 不自行 argv 拼接（omp `resolveEditorSpawnCommand` 同款，避免宿主运行时二次加引号）。
 *
 * 临时文件落 `/tmp/oh-my-codebuddy/`（项目约定目录）。**遵守「禁 rm」**：不物理删除，
 * 用唯一名（时间戳 + 随机）避免碰撞（同 `clipboard.ts` 的 paste 临时图）。
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 临时文件约定目录（与 clipboard.ts / AGENTS.md 一致） */
export const EDITOR_TMP_DIR = '/tmp/oh-my-codebuddy';

/**
 * 解析用户偏好的编辑器命令，或平台默认。
 * 顺序：`$VISUAL` → `$EDITOR` →（win32 `notepad` / POSIX `undefined`）。
 * POSIX 返回 `undefined` 让调用方给出「请配置 `$VISUAL`/`$EDITOR`」提示（同 omp）。
 */
export function getEditorCommand(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env.VISUAL?.trim() || env.EDITOR?.trim();
  if (configured) return configured;
  if (process.platform === 'win32') return 'notepad';
  return undefined;
}

/** 启动外部编辑器的 argv 与 Windows 引号模式 */
export interface EditorSpawnCommand {
  cmd: string[];
  windowsVerbatimArguments: boolean;
}

/**
 * 解析编辑器启动 argv（复刻 omp `resolveEditorSpawnCommand`）：
 *   · POSIX：`sh -c '<editorCmd> "$1"' sh <tmpFile>` —— `$1` 由 `sh` 定位参数传入，
 *     故 `$EDITOR='code -w'` 这类含参命令无需自行拆分/转义。
 *   · Windows：`cmd.exe /d /s /c "<editorCmd> "<tmpFile>>"`，并让 Bun 逐字传引号。
 */
export function resolveEditorSpawnCommand(
  editorCmd: string,
  tmpFile: string,
  platform: NodeJS.Platform = process.platform,
): EditorSpawnCommand {
  const windows = platform === 'win32';
  const cmd = windows
    ? ['cmd.exe', '/d', '/s', '/c', `"${editorCmd} "${tmpFile}""`]
    : ['sh', '-c', `${editorCmd} "$1"`, 'sh', tmpFile];
  return { cmd, windowsVerbatimArguments: windows };
}

/** 编辑器进程执行结果（测试可注入替换） */
export type EditorRunner = (cmd: string[], verbatim: boolean) => Promise<number>;

/** 默认执行器：`Bun.spawn` + 三路 inherit（真 pty 交给编辑器） */
async function defaultRunner(cmd: string[], verbatim: boolean): Promise<number> {
  const child = Bun.spawn(cmd, {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    windowsVerbatimArguments: verbatim,
  });
  return await child.exited;
}

export interface OpenInEditorOptions {
  /** 临时文件扩展名（默认 `.md`） */
  extension?: string;
  /** 保留尾换行（默认 false：去一个尾部 `\n`，对齐 omp） */
  trimTrailingNewline?: boolean;
  /** 临时目录（测试注入；默认 `EDITOR_TMP_DIR`） */
  tmpDir?: string;
  /** 临时文件名（测试注入；默认 `editor-<ts>-<rand><ext>`） */
  filename?: string;
  /** 进程执行器（测试注入；默认 `Bun.spawn` inherit） */
  run?: EditorRunner;
}

export interface OpenInEditorOutcome {
  /** 退出码 0 时的编辑结果（已按 `trimTrailingNewline` 处理）；非 0 / 异常 → `null` */
  text: string | null;
  /** 编辑器退出码（spawn 抛异常时为 `null`） */
  exitCode: number | null;
  /** 临时文件绝对路径（可观测 / 调试用） */
  tmpFile: string;
  /** spawn 失败等错误信息（成功为 undefined） */
  error?: string;
}

/**
 * 测试可观测性：`OMC_DEBUG_EDITOR=<path>` 时追加事件行
 * （同 `memoryDebug` / `bashDebug`，供 `scripts/smoke-external-editor-pty.sh` 断言）。
 */
const editorDebugPath = process.env.OMC_DEBUG_EDITOR;

export function editorDebug(line: string): void {
  if (!editorDebugPath) return;
  try {
    appendFileSync(editorDebugPath, line + '\n');
  } catch {
    // 调试通道失败不影响主流程
  }
}

/**
 * 在用户外部编辑器里打开 `content` 并返回编辑结果。
 * 退出码 0 → 读回文本（默认 `trimTrailingNewline` 去一个尾换行）；非 0 → `text: null`。
 * **调用方须 `tui.stop()` / `tui.start()` 包夹本调用**。
 * 本函数**不删除**临时文件（遵守「禁 rm」约定）。
 */
export async function openInEditor(
  editorCmd: string,
  content: string,
  options: OpenInEditorOptions = {},
): Promise<OpenInEditorOutcome> {
  const ext = options.extension ?? '.md';
  const tmpDir = options.tmpDir ?? EDITOR_TMP_DIR;
  const filename = options.filename ?? `editor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
  const tmpFile = join(tmpDir, filename);
  const run = options.run ?? defaultRunner;

  try {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(tmpFile, content);
  } catch (err) {
    return { text: null, exitCode: null, tmpFile, error: err instanceof Error ? err.message : String(err) };
  }

  const spawnCommand = resolveEditorSpawnCommand(editorCmd, tmpFile);
  let exitCode: number;
  try {
    exitCode = await run(spawnCommand.cmd, spawnCommand.windowsVerbatimArguments);
  } catch (err) {
    return { text: null, exitCode: null, tmpFile, error: err instanceof Error ? err.message : String(err) };
  }

  if (exitCode !== 0) {
    return { text: null, exitCode, tmpFile };
  }
  try {
    const text = readFileSync(tmpFile, 'utf8');
    const result = options.trimTrailingNewline === false ? text : text.replace(/\n$/, '');
    return { text: result, exitCode, tmpFile };
  } catch (err) {
    return { text: null, exitCode, tmpFile, error: err instanceof Error ? err.message : String(err) };
  }
}

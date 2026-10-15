/**
 * bash-mode.ts — 输入框 `!` / `!!` bash 模式（input-interactions P1）。
 *
 * 语义对齐 **omp**（`packages/coding-agent/src/modes/controllers/input-controller.ts:1141`
 * / `session/bash-runner.ts:278` / `session/messages.ts:1046`）：
 *   `!cmd`   执行 → 命令+输出**进入**下一轮模型上下文
 *   `!!cmd`  执行 → 输出**不进**上下文（本地 shell 逃生门）
 * 两者都只在 transcript 回显，**都不触发模型回复**（omp 与 codebuddy 同为「下一轮请求携带」）。
 *
 * omc 的偏差（README「关键实证」已登记）：SDK 没有「只加历史、不起轮」的 API
 * （`session.send()` 必然起一轮），故「进上下文」由 main.ts 的**待注入缓冲**
 * （`pendingBashContexts`）实现 —— 攒到用户**下次发消息**时拼进那条消息带给模型。
 *
 * 执行层**复刻 omp `executeUserShellPty`**：原生 PTY（`PtySession`）+ **用户自己的
 * shell 交互式启动**（`$SHELL -i -c <cmd>`）→ 加载 `.zshrc`（**别名/函数可用**）、
 * stdout 是 TTY（**颜色保留**）。对比例证：非交互 `/bin/sh -c ll` 会 `command not
 * found`（别名不存在）且输出单色。
 *
 * 分层：本文件**不得** import `../ui` / pi-tui。`output` 一律是 `sanitizeText` 净化后的
 * 纯文本（供模型与落盘）；彩色呈现由 UI 层根据 `onChunk` 的**原始字节**做 vterm 回放。
 */
import { accessSync, appendFileSync, constants } from 'node:fs';
import { basename } from 'node:path';
import { PtySession } from '@oh-my-pi/pi-natives';
import { sanitizeText } from '@oh-my-pi/pi-utils';

/** 单条 bash 命令默认超时（防交互式命令挂死 TUI） */
export const BASH_TIMEOUT_MS = 30_000;

/** 测试可观测性：OMC_DEBUG_BASH=<path> 时追加 RUN/INJECT 事件行
 *（OMC_DEBUG_QUEUE 同款，scripts/smoke-bash-mode-pty.sh 断言用） */
const bashDebugPath = process.env.OMC_DEBUG_BASH;

export function bashDebug(line: string): void {
  if (!bashDebugPath) return;
  try {
    appendFileSync(bashDebugPath, line + '\n');
  } catch {
    // 调试通道失败不影响主流程
  }
}

/**
 * 输出字符上限（超出**保留尾部**并标注，防灌爆上下文）。
 * 与 omp `direction: "tail"` 同向：命令报错通常在末尾。
 */
export const MAX_BASH_OUTPUT_CHARS = 100_000;

/** `!` / `!!` 前缀解析结果（`command` 已 trim；空串 = 只敲了前缀） */
export interface ParsedBashInput {
  /** 去掉前缀并 trim 后的命令（可能为空） */
  command: string;
  /** `!!` = 不进模型上下文（omp `excludeFromContext`） */
  excluded: boolean;
}

/**
 * 前缀解析：仅当文本**以 `!` 开头**时命中。`!!` → excluded；
 * 其余 `!` 后内容一律当命令（`!$`、`!!` 等 shell 字符按 omp 同口径处理）。
 * 非 `!` 开头 → `null`（落回普通对话/斜杠命令路径）。
 */
export function parseBashInput(text: string): ParsedBashInput | null {
  if (!text.startsWith('!')) return null;
  const excluded = text.startsWith('!!');
  const command = (excluded ? text.slice(2) : text.slice(1)).trim();
  return { command, excluded };
}

/** 输出截断结果 */
export interface TruncatedOutput {
  /** 截断后的文本（保留尾部；未超限则原样） */
  text: string;
  truncated: boolean;
  /** 被丢弃的字符数（未截断 = 0） */
  droppedChars: number;
}

/** 保留尾部截断：`text.length > max` 时丢掉头部，返回尾部 max 字符 */
export function truncateBashOutput(text: string, max = MAX_BASH_OUTPUT_CHARS): TruncatedOutput {
  if (text.length <= max) return { text, truncated: false, droppedChars: 0 };
  const droppedChars = text.length - max;
  return { text: text.slice(droppedChars), truncated: true, droppedChars };
}

/** 单条 bash 执行结果（`output` 已净化：ANSI/控制字符剥离；**未**截断） */
export interface BashRunResult {
  /** 净化后的输出（stdout/stderr 按 PTY 交织顺序） */
  output: string;
  /** 退出码（超时/被杀 → `null`） */
  exitCode: number | null;
  /** 超时 */
  timedOut: boolean;
  /** 被取消 / PTY 启动失败 */
  cancelled: boolean;
}

/** 用户 shell 解析结果 */
export interface UserShell {
  /** shell 可执行文件路径 */
  shell: string;
  /**
   * 是否以**交互式**启动（`-i`）。true = 加载 rc（别名/函数可用）；
   * false = 回退 `/bin/sh`（无别名，但仍是一个能跑的 shell）。
   */
  interactive: boolean;
}

/** 支持「交互式启动以加载 rc」的 shell（对齐 omp `supportsAutoUserShell`：zsh / fish） */
const INTERACTIVE_SHELL_NAMES = new Set(['zsh', 'fish']);

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析「用户自己的 shell」（复刻 omp `resolveUserShellConfig`）：`$SHELL` 若是
 * zsh/fish 且可执行 → 用它（**交互式**启动，加载 `.zshrc`/`config.fish` → 别名/函数可用）；
 * 否则回退 `/bin/sh`（非交互）。
 */
export function resolveUserShell(env: Record<string, string | undefined> = process.env): UserShell {
  const envShell = env.SHELL;
  if (
    envShell &&
    envShell.startsWith('/') &&
    INTERACTIVE_SHELL_NAMES.has(basename(envShell)) &&
    isExecutableFile(envShell)
  ) {
    return { shell: envShell, interactive: true };
  }
  return { shell: '/bin/sh', interactive: false };
}

/**
 * 构造子进程环境（复刻 omp `buildUserShellPtyEnv` + 非交互守护）：
 * PTY 已让 stdout 是 TTY，故只有 `TERM`/`NO_COLOR`/`CI` 会让工具变单色 → 复原它们；
 * 同时禁掉分页器/编辑器/凭据提示（`!` 命令**不回灌 stdin**，交互式程序会挂到超时）。
 */
export function bashExecEnv(base: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  env.TERM = 'xterm-256color';
  delete env.NO_COLOR;
  delete env.CI;
  env.PAGER = 'cat';
  env.GIT_PAGER = 'cat';
  env.LESS = 'FRX';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_EDITOR = 'true';
  env.EDITOR = 'true';
  env.VISUAL = 'true';
  return env;
}

export interface BashRunOptions {
  cwd?: string;
  cols?: number;
  rows?: number;
  timeoutMs?: number;
  /** 覆盖 shell 解析（测试注入用；默认走 {@link resolveUserShell}） */
  shell?: UserShell;
  /** 环境覆盖（测试注入用；默认 {@link bashExecEnv}） */
  env?: Record<string, string>;
  /** 原始字节回调（含 ANSI/SGR 与光标控制）——喂 vterm 彩色回放；**不可**用于落盘 */
  onChunk?: (chunk: string) => void;
}

/**
 * 在**原生 PTY** 上执行用户 shell 命令（复刻 omp `executeUserShellPty`）。
 *
 * 为什么必须 PTY + 交互式：别名/函数来自 rc，而 rc 只在交互式 shell 下加载；
 * 且 `ls`/`ggrep` 等只在 stdout 是 TTY 时着色（管道 → 单色）。
 *
 * 返回的 `output` 是 `sanitizeText` 净化后的纯文本 → 供模型与落盘；
 * 彩色呈现走 `onChunk` 的原始字节（UI 层 vterm 回放）。
 */
export async function runBashCommand(command: string, opts: BashRunOptions = {}): Promise<BashRunResult> {
  const { shell, interactive } = opts.shell ?? resolveUserShell();
  const args = interactive ? ['-i', '-c', command] : ['-c', command];
  const session = new PtySession();
  let raw = '';
  const clean = (): string => sanitizeText(raw).replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  try {
    const res = await session.startArgv(
      {
        application: shell,
        args,
        cwd: opts.cwd ?? process.cwd(),
        env: opts.env ?? bashExecEnv(),
        cols: opts.cols ?? 100,
        rows: opts.rows ?? 30,
        timeoutMs: opts.timeoutMs ?? BASH_TIMEOUT_MS,
      },
      (err, chunk) => {
        if (err || !chunk) return;
        raw += chunk;
        opts.onChunk?.(chunk);
      },
    );
    return {
      output: clean(),
      exitCode: res.exitCode ?? null,
      timedOut: res.timedOut === true,
      cancelled: res.cancelled === true,
    };
  } catch (e) {
    // PTY 启动失败（原生模块不可用等）→ 降级为「空输出 + 已取消」，不崩 TUI
    bashDebug(`PTY-ERR ${e instanceof Error ? e.message : String(e)}`);
    return { output: clean(), exitCode: null, timedOut: false, cancelled: true };
  }
}

/**
 * 卡片/上下文共用的「一次执行结果」形态（截断已应用）。
 */
export interface BashOutcome {
  /** 净化后输出（已截断） */
  output: string;
  truncated: boolean;
  /** 被丢弃的字符数 */
  droppedChars: number;
  /** 未截断时的原始字符数 */
  totalChars: number;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
}

/** 执行结果 → 截断后的共用形态（模型上下文 / 落盘 / 卡片同源） */
export function toBashOutcome(result: BashRunResult, maxChars = MAX_BASH_OUTPUT_CHARS): BashOutcome {
  const { text, truncated, droppedChars } = truncateBashOutput(result.output, maxChars);
  return {
    output: text,
    truncated,
    droppedChars,
    totalChars: result.output.length,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
  };
}

/**
 * transcript 回显卡数据（`src/ui/bash-execution.ts` 与落盘/重放共用，故放纯逻辑层）。
 */
export interface BashCardDetails extends BashOutcome {
  /** 用户敲的命令（不含前缀） */
  command: string;
  /** `!!` = 本地执行，未进入模型上下文 */
  excluded: boolean;
}

/** 从「命令 + 结果」构造卡片数据 */
export function toBashCardDetails(
  command: string,
  outcome: BashOutcome,
  excluded: boolean,
): BashCardDetails {
  return { command, excluded, ...outcome };
}

/**
 * 自适应代码围栏：围栏长度 = max(3, 文本中最长反引号串 + 1)。
 * 供 `/export`（Markdown 导出）使用，避免输出自带 ``` 截断围栏。
 */
export function fenceOutput(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  const len = Math.max(3, ...runs.map((r) => r.length + 1));
  const fence = '`'.repeat(len);
  return `${fence}\n${text}\n${fence}`;
}

/**
 * 格式化「命令 + 输出」为**注入模型上下文**的文本（对齐 omp `bashExecutionToText`）：
 *
 *   Ran `cmd`
 *   ```
 *   <output>
 *   ```
 *   Command exited with code N        ← 仅非零退出
 *   (command timed out after Ns)      ← 仅超时
 *
 * 截断时在围栏内首行标注省略了多少字符。
 */
export function formatBashContext(
  command: string,
  outcome: BashOutcome,
  timeoutMs = BASH_TIMEOUT_MS,
): string {
  let text = `Ran \`${command}\`\n`;
  const body = outcome.output
    ? `${outcome.truncated ? `… (输出共 ${outcome.totalChars} 字符，已省略前 ${outcome.droppedChars} 字符)\n` : ''}${outcome.output}`
    : '';
  text += body ? '```\n' + body + '\n```' : '(no output)';
  if (outcome.timedOut) {
    text += `\n\n(command timed out after ${Math.round(timeoutMs / 1000)}s)`;
  } else if (outcome.cancelled) {
    text += '\n\n(command cancelled)';
  } else if (outcome.exitCode !== null && outcome.exitCode !== 0) {
    text += `\n\nCommand exited with code ${outcome.exitCode}`;
  }
  return text;
}

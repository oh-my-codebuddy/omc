/**
 * mode-indicator.ts — 权限模式提示行（照抄 codebuddy cli 的 PermissionModeDisplay）。
 *
 * 文案与配色逐字照抄自 codebuddy（headless.js @10321234 的 switch）：
 *   图标：bypass/accept/auto/dontAsk = `⏵⏵`(U+23F5×2)；plan = `⏸`(U+23F8)；delegate = `⇢`(U+21E2)
 *   后缀：除 dontAsk 外均带 ` (shift+Tab to cycle)`
 * 配色取自 codebuddy dark 主题（同文件 colors 定义）：
 *   warning #fdd663（bypass/auto/dontAsk）、info #8ab4f8（acceptEdits）、
 *   planMode #78d9ec（plan）、delegateMode #DAA520（delegate）
 * default 无提示行（codebuddy 同款返回 null）。
 *
 * 上色走 24-bit 真彩色 ANSI（与 statusline-segments.ts:19 rgb 同范式）——pi-tui 的
 * theme.fg 只认主题 token（theme-class.ts:327 未知 token 抛错），放不下这几个 hex。
 */
import { appendFileSync } from 'node:fs';
import { planModeLabel } from '../permission/plan-mode';

const MODE_INDICATOR_COLORS = {
  warning: '#fdd663',
  info: '#8ab4f8',
  planMode: '#78d9ec',
  delegateMode: '#DAA520',
} as const;

export interface ModeIndicator {
  /** 提示行原文（未上色） */
  text: string;
  /** 前景色 hex（#rrggbb） */
  color: string;
}

/**
 * 当前权限模式 → 提示行；default/未知返回 null（不显示）。
 *
 * `prePlanMode`（plan-mode P1.4，D5）：plan 模式下带上「退出后回哪个模式」的后缀，
 * 对齐 codebuddy `permissionComposeSuffix` 的 `⏸ plan + bypass (shift+Tab to cycle)`。
 * 不传/为 null 时回落原文案（既有调用方与单测零变化）。
 */
export function permissionModeIndicator(mode: string, prePlanMode?: string | null): ModeIndicator | null {
  switch (mode) {
    case 'bypassPermissions':
    case 'fullAccess':
      return { text: '⏵⏵ bypass permissions on (shift+Tab to cycle)', color: MODE_INDICATOR_COLORS.warning };
    case 'acceptEdits':
      return { text: '⏵⏵ accept edits on (shift+Tab to cycle)', color: MODE_INDICATOR_COLORS.info };
    case 'plan':
      return {
        text: `⏸ ${planModeLabel(prePlanMode)} on (shift+Tab to cycle)`,
        color: MODE_INDICATOR_COLORS.planMode,
      };
    case 'delegate':
      return { text: '⇢ delegate mode on (shift+Tab to cycle)', color: MODE_INDICATOR_COLORS.delegateMode };
    case 'dontAsk':
      return { text: "⏵⏵ don't ask on", color: MODE_INDICATOR_COLORS.warning };
    case 'auto':
      return { text: '⏵⏵ auto mode on (shift+Tab to cycle)', color: MODE_INDICATOR_COLORS.warning };
    default:
      return null;
  }
}

/** hex → 24-bit 前景色 ANSI（statusline-segments.ts:19 同款） */
function fgHex(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
}

/** 渲染为带色 ANSI 行；default/未知返回 undefined（调用方据此隐藏该行） */
export function renderModeIndicator(mode: string, prePlanMode?: string | null): string | undefined {
  const ind = permissionModeIndicator(mode, prePlanMode);
  if (!ind) return undefined;
  return `${fgHex(ind.color)}${ind.text}\x1b[39m`;
}

// ---------- 输入区 shell / memory 模式（`!` / `!!` / `#`，input-interactions P1.6 + P2）----------

/** 测试可观测性：OMC_DEBUG_SHELLMODE=<path> 时追加 `MODE <模式> <触发源>` 行（PTY 冒烟断言用） */
const shellModeDebugPath = process.env.OMC_DEBUG_SHELLMODE;

export function shellModeDebug(line: string): void {
  if (!shellModeDebugPath) return;
  try {
    appendFileSync(shellModeDebugPath, line + '\n');
  } catch {
    // 调试通道失败不影响主流程
  }
}

/** shell 模式切换的触发源（调试/冒烟断言用） */
export type ShellModeTrigger = 'sigil' | 'key' | 'esc' | 'clear' | 'backspace' | 'submit';

/** 输入模式：`!` 进上下文 / `!!` 仅本地 / `#` 记忆快捷 / 无 */
export type ShellInputMode = 'none' | 'bash' | 'local' | 'memory';

/**
 * 配色取自 codebuddy dark 主题（同前文来源）：`bashMode #cc00cc`（品红）、
 * `bashLocalMode #00a3a3`（青）、`#` 记忆模式取 `brand #28B894`（codebuddy 对 MEMORY 状态
 * 用 `colors.brand ?? "cyan"`，light/dark 主题 brand 同为 `#28B894`）。
 */
const SHELL_MODE_COLORS = { bash: '#cc00cc', local: '#00a3a3', memory: '#28B894' } as const;

/**
 * 输入区 shell / memory 模式提示行（文案照抄 codebuddy `BashModeHintBox` / `MemoryModeHintBox`：
 * 进入该模式时把权限模式提示行**顶掉**，改显模式提示）。
 *
 * 与 codebuddy 的差异：
 *   ① local 行首用 **`!!`**（omc 的 local 入口就是 `!!` 前缀，提示与输入框里的提示符一致；
 *      codebuddy 的 local 子模式仍显示 `!`）；
 *   ② Shift+Tab 在 omc 里**确实**能切 bash ↔ local（见 app.ts 的同键分支），故提示不是空头支票；
 *   ③ `#` 记忆模式照抄 codebuddy 文案 `# to memorize`（无 `shift+Tab` 后缀 —— 该模式无子模式）。
 */
export function shellModeIndicator(mode: ShellInputMode): ModeIndicator | null {
  if (mode === 'bash') {
    return { text: '! for bash mode  ·  shift+Tab for local (no context)', color: SHELL_MODE_COLORS.bash };
  }
  if (mode === 'local') {
    return {
      text: '!! local shell (not sent to model)  ·  shift+Tab back to bash',
      color: SHELL_MODE_COLORS.local,
    };
  }
  if (mode === 'memory') {
    return { text: '# to memorize', color: SHELL_MODE_COLORS.memory };
  }
  return null;
}

/** 渲染 shell 模式提示行；`none` 返回 undefined（调用方回落到权限模式行） */
export function renderShellModeIndicator(mode: ShellInputMode): string | undefined {
  const ind = shellModeIndicator(mode);
  return ind ? `${fgHex(ind.color)}${ind.text}\x1b[39m` : undefined;
}

/** shell 模式下的边框着色器（输入框变色）；`none` → undefined（调用方用默认边框色） */
export function shellModeBorderColorizer(mode: ShellInputMode): ((str: string) => string) | undefined {
  const ind = shellModeIndicator(mode);
  if (!ind) return undefined;
  const prefix = fgHex(ind.color);
  return (str: string) => `${prefix}${str}\x1b[39m`;
}

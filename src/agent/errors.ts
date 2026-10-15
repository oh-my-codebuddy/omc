/**
 * 错误分层：把消费流时捕获的异常分类为 ErrorEvent。
 * catch 判断顺序固定：ExecutionError → AbortError → CLIStartupError → auth → unknown。
 *
 * 注：当前 SDK 版本（0.3.267）未从包入口导出 AuthenticationError，
 * 认证问题通过 ExecutionError.subtype / message 特征识别。
 */
import { AbortError, CLIStartupError, ExecutionError } from '@tencent-ai/agent-sdk';
import { makeEventId, type ErrorEvent } from './types';

/**
 * CLI 在工具调用被**用户拒绝**时给出的回执前缀（permission-surface P2.4）。
 * 原文形如 `Permission denied for tool(s): Bash, Write`（CLI `dist` 里模板
 * `Permission denied for tool(s): ${names}`）。它不是执行错误 —— 是 `No, and tell … what
 * to do differently` 的等义回执，UI 侧应渲染成中文拒绝提示（见 `ui/bridge.ts`）。
 */
const PERMISSION_DENIED_PREFIX = 'Permission denied for tool(s):';

/** 该错误消息是否是「用户拒绝工具调用」的回执 */
export function isPermissionDenied(message: string): boolean {
  return message.startsWith(PERMISSION_DENIED_PREFIX);
}

/** 从拒绝回执里取出被拒的工具名（取不到 → 空数组） */
export function parseDeniedTools(message: string): string[] {
  if (!isPermissionDenied(message)) return [];
  return message
    .slice(PERMISSION_DENIED_PREFIX.length)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 被拒工具的场景类别（cancel-stops-turn P1.3）：决定 omc 侧回执文案。
 * CLI 合成的拒绝回执只给工具名（`Permission denied for tool(s): X`），故按名字分类：
 * - `ask`  → 问答（`AskUserQuestion`；`AskUserForStructuredInput` 保留 —— P0 实证它走 elicitation
 *   通道而非权限桥，正常不会出现，但名字归入同类以防未来变更）
 * - `plan` → 计划审批（`ExitPlanMode`）
 * - `tool` → 普通工具权限（默认）
 */
export type DeniedToolKind = 'ask' | 'plan' | 'tool';

const ASK_TOOL_NAMES = new Set(['AskUserQuestion', 'AskUserForStructuredInput']);

export function deniedToolKind(message: string): DeniedToolKind {
  const tools = parseDeniedTools(message);
  if (tools.includes('ExitPlanMode')) return 'plan';
  if (tools.some((t) => ASK_TOOL_NAMES.has(t))) return 'ask';
  return 'tool';
}

function looksLikeAuth(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes('auth') || m.includes('unauthorized') || m.includes('401') || m.includes('login');
}

export function classifyError(e: unknown): ErrorEvent {
  const base = { id: makeEventId(), timestamp: Date.now() };

  if (e instanceof ExecutionError) {
    const message = e.errors.join('; ') || e.subtype;
    return {
      ...base,
      type: 'error',
      kind: isPermissionDenied(message) ? 'permission_denied' : looksLikeAuth(`${e.subtype} ${message}`) ? 'auth' : 'execution',
      message,
      detail: `subtype=${e.subtype}`,
    };
  }

  if (e instanceof AbortError) {
    return { ...base, type: 'error', kind: 'abort', message: e.message || 'aborted' };
  }

  if (e instanceof CLIStartupError) {
    return {
      ...base,
      type: 'error',
      kind: 'startup',
      message: e.message,
      detail: `exitCode=${e.exitCode ?? 'null'}${e.stderr ? `\nstderr: ${e.stderr}` : ''}`,
    };
  }

  const message = e instanceof Error ? e.message : String(e);
  return {
    ...base,
    type: 'error',
    kind: looksLikeAuth(message) ? 'auth' : 'unknown',
    message,
  };
}

/**
 * host-reports.ts — 宿主状态 → 宿主事件载荷的纯转换（herdr P1）。
 *
 * main.ts（composition root）负责读状态并 `hostEvents.emit(...)`；本模块只做
 * 「什么变了 → 该发什么」的判定，便于单测（无需装配 main）。
 */
import type { HostEvents, HostPendingKind } from './types';

/** 权限/问答挂起视图（main 由 `PermissionBridge.pending` + `pendingLabel` 映射而来） */
export interface PendingView {
  kind: HostPendingKind;
  label: string;
}

/** `pendingReport` 判定结果：该派发的单个事件（无变化 → null） */
export type PendingReport =
  | { type: 'permission/pending'; payload: HostEvents['permission/pending'] }
  | { type: 'permission/resolved'; payload: HostEvents['permission/resolved'] };

/**
 * 挂起状态迁移 → 事件（边缘触发，防重复刷屏）：
 * - 有 → 无：`permission/resolved`（带被解除的 kind）
 * - 无 → 有 / kind 变化：`permission/pending`
 * - kind 未变（同一类挂起内换请求）：null —— blocked 状态未变，无需重报
 */
export function pendingReport(prev: HostPendingKind | null, next: PendingView | null): PendingReport | null {
  if (next) {
    if (prev === next.kind) return null;
    return { type: 'permission/pending', payload: { kind: next.kind, label: next.label } };
  }
  if (prev) return { type: 'permission/resolved', payload: { kind: prev } };
  return null;
}

/**
 * 会话身份去重（herdr P1）：仅当 sessionId 有效且相对 `lastReported` 有变化时返回载荷。
 * 新会话在 `system_init` 前 sessionId 为 undefined → 不发（herdr 需真实 id 才能生成 resume 命令）。
 */
export function identityReport(
  lastReported: string | null,
  sessionId: string | undefined | null,
  resumed: string | null,
): HostEvents['session/identity'] | null {
  if (!sessionId || sessionId === lastReported) return null;
  return { sessionId, resumed };
}

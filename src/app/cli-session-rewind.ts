/**
 * cli-session-rewind.ts（rewind P1 修复 R2）：对话回退 = **截断 CLI 自己的会话 jsonl** + 普通 `--resume`。
 *
 * 为什么不用 CLI 的 `--resume-session-at`（2026-10-08 实证）：
 * 该 flag 让恢复出的会话带上内部状态 `conversationReverted=true`，而 SessionManager 在
 * 该状态下**不再刷新 `lastMessageId`**（`if (!conversationReverted) { lastMessageId = tip }`），
 * 于是「有效分支」（`CheckpointService.getActiveHistory` 依赖 `lastMessageId`）永远停在截断点 →
 * **回退之后新产生的轮次不在有效分支里** → 它们的新锚点回退必报
 * `No checkpoint associated with user message <id>`（用户真机实测 + `scripts/repro-rewind-stale-anchor.sh` 复现）。
 *
 * 反例对照（`scripts/probe-rewind-truncate.ts` 实证）：直接截断 CLI 会话 jsonl 到目标轮之前、再普通
 * `--resume` —— 历史确实变短，且**新轮锚点回退成功**（`canRewind:true`）。
 *
 * ⚠️ 破坏性：这是**写 CLI 自己拥有的文件**（`~/.codebuddy/projects/<esc-cwd>/<sid>.jsonl`），
 * 仅在用户经 `/rewind` 显式确认后调用；截断 = 只保留前缀（保留的行原样不动）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { mainSessionLogPath } from './subagent-log';

export type TruncateOutcome =
  /** 已截断，保留了非空前缀 */
  | 'truncated'
  /**
   * 已截断且**内容被清空**（锚点 = 第一轮 user item → 没有前缀可留）。
   *
   * ⚠️ 这种状态下**不能用同 id 重启**：实测（`scripts/probe-rewind-truncate-empty.ts`）
   * 会话以「空 history」载入后 `lastMessageId` 建立不起来 → 之后新产生轮次的锚点回退
   * 一律 `No checkpoint associated`。调用方应改用**新会话**（等价于「对话清零」）。
   */
  | 'truncated-empty'
  /** CLI 会话记录里找不到该 user item（锚点不属于当前 CLI 会话记录） */
  | 'not-found'
  /** CLI 会话记录不存在/不可读 */
  | 'no-log'
  /** 写入失败 */
  | 'error';

/**
 * 在 CLI 会话 jsonl 里定位「该 user item」的行号（0-based）；未命中 -1。
 *
 * 锚点 `messageId` = SDK `file-history-snapshot.snapshot.messageId` = 该轮 user item id
 * （P0 探针实证），故按 `type==='message' && role==='user' && id===messageId` 精确匹配。
 */
export function findUserItemLine(lines: readonly string[], messageId: string): number {
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw === undefined) continue;
    const line = raw.trim();
    if (!line) continue;
    try {
      const o = JSON.parse(line) as { type?: string; role?: string; id?: string };
      if (o.type === 'message' && o.role === 'user' && o.id === messageId) return i;
    } catch {
      // 坏行跳过
    }
  }
  return -1;
}

/**
 * 截断 CLI 会话 jsonl：只保留该 user item **之前**的记录
 * （= 「回退到该轮之前」；该轮的起始 `file-history-snapshot` 紧随其后，一并被切掉）。
 * @returns 结果码；`truncated` 表示已成功重写
 */
export function truncateCliSessionAt(cwd: string, sessionId: string, messageId: string): TruncateOutcome {
  return truncateAtPath(mainSessionLogPath(cwd, sessionId), messageId);
}

/**
 * 同上的「按文件路径」实现（供测试注入临时路径；生产走 `truncateCliSessionAt`）。
 * ⚠️ 只重写内容为前缀——保留的行原样不动、不追加任何标记。
 */
export function truncateAtPath(file: string, messageId: string): TruncateOutcome {
  if (!messageId) return 'not-found';
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return 'no-log';
  }
  const lines = raw.split('\n');
  const idx = findUserItemLine(lines, messageId);
  if (idx < 0) return 'not-found';
  // 保留 [0, idx)：idx 行及其后（该轮 user item + 其快照/工具调用…）全部丢弃。
  // idx === 0 → 写成空内容（对话清空；CLI 的 --resume 仍可启动，见 smoke-rewind-stale-anchor-pty.sh）。
  const kept = lines.slice(0, idx).filter((l) => l.trim().length > 0);
  if (kept.length === 0) {
    // 锚点就是第一轮 → 无前缀可留；写空文件（调用方据此改用新会话，见 TruncateOutcome 注释）
    try {
      writeFileSync(file, '');
      return 'truncated-empty';
    } catch {
      return 'error';
    }
  }
  try {
    writeFileSync(file, `${kept.join('\n')}\n`);
    return 'truncated';
  } catch {
    return 'error';
  }
}

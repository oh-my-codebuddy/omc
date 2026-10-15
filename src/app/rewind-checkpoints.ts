/**
 * rewind-checkpoints.ts（rewind P1.0）：`/rewind` 候选（文件检查点锚点）的跟踪与重建。
 *
 * 背景（2026-10-08 P0 探针实证，见 docs/plan/rewind/p0-feasibility-probe.md）：
 * - 有文件改动的轮次会推 `file-history-snapshot`，其 `snapshot.messageId` = 该轮 user item id，
 *   同一轮多条 snapshot 该值相同 → **一轮一个锚点**；
 * - 该 id 可直接作 CLI `rewind` 控制请求的 `user_message_id`（回退到该轮**之前**）；
 * - 无文件改动的轮次既无 snapshot 也无锚点 → **不可回退**（与 codebuddy `/rewind` 只列
 *   有 checkpoint 的轮一致）。
 *
 * 本模块是纯数据层（无 IO、无 UI）：`CheckpointLog` 在 live 时由 main.ts 喂
 * `noteUserInput` + `observe`；`/resume` 重放时由落盘的 `CheckpointRecord[]` 经
 * `fromRecords` 重建。
 */
import type { CheckpointRecord } from '../session-store/jsonl';
import type { CheckpointBackupEntry } from '../agent/types';

/** `/rewind` 候选锚点 */
export interface CheckpointAnchor {
  /** CLI user item id（回退锚点，直接作 `user_message_id`） */
  messageId: string;
  /** 该轮用户消息首行（浮层标签） */
  label: string;
  /** 该轮被跟踪的文件（最新快照口径；工作区内为相对路径） */
  files: string[];
  /** 首次观察时间（epoch ms） */
  at: number;
  /**
   * 该轮 `UserRecord` 的 id（omc 本地 jsonl；对话回退截断转录区用）。
   * 老记录可能缺省（重建的历史锚点无此字段）。
   */
  userRecordId?: string;
  /** 该轮各文件备份记录（最新快照口径；本地恢复兜底用，老记录可缺省） */
  backups?: Record<string, CheckpointBackupEntry>;
}

/** 取首行并截断（浮层标签；对齐 codebuddy 的 checkpoint label 口径） */
export function firstLine(text: string, max = 60): string {
  const line = (text.split('\n').find((l) => l.trim().length > 0) ?? '').trim();
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

export class CheckpointLog {
  #anchors: CheckpointAnchor[] = [];
  /** 当前轮的标签 / 归属（由 noteUserInput 写入，observe 时消费） */
  #pendingLabel = '';
  #pendingUserRecordId: string | undefined;

  /**
   * 记下一条用户输入 = 开启一轮。其后到达的 checkpoint 的 label 取这次输入的首行，
   * 并归属到该 `UserRecord`（对话回退据此截断本地记录）。
   */
  noteUserInput(text: string, userRecordId?: string): void {
    this.#pendingLabel = firstLine(text);
    this.#pendingUserRecordId = userRecordId;
  }

  /**
   * 观察一条 `checkpoint` 事件。同 `messageId` 再次出现（同轮多 snapshot）合并文件列表
   * 与备份记录（增量快照重发全量 map，**以最后一条为准**），保留首次的 label/at
   * （避免同一轮被列成多条候选）。
   * @returns 是否**新建**了候选（false = 同轮增量更新；调用方对带备份数据的更新也应落盘，
   *   由 fromRecords 归并 —— 轮首快照常为空标记，只落首条会丢 files/backups）
   */
  observe(
    messageId: string,
    files: readonly string[],
    at: number,
    backups?: Record<string, CheckpointBackupEntry>,
  ): boolean {
    if (!messageId) return false;
    const existing = this.#anchors.find((a) => a.messageId === messageId);
    if (existing) {
      existing.files = [...files];
      if (backups) existing.backups = { ...backups };
      return false;
    }
    this.#anchors.push({
      messageId,
      label: this.#pendingLabel || '(无标题)',
      files: [...files],
      at,
      ...(this.#pendingUserRecordId ? { userRecordId: this.#pendingUserRecordId } : {}),
      ...(backups ? { backups: { ...backups } } : {}),
    });
    return true;
  }

  /** 候选列表（按出现顺序，最新在后） */
  list(): readonly CheckpointAnchor[] {
    return this.#anchors;
  }

  /** 按 messageId 取锚点 */
  find(messageId: string): CheckpointAnchor | undefined {
    return this.#anchors.find((a) => a.messageId === messageId);
  }

  clear(): void {
    this.#anchors = [];
    this.#pendingLabel = '';
    this.#pendingUserRecordId = undefined;
  }

  /**
   * 从落盘记录重建（`/resume` 重放用；保留文件原始顺序）。
   * 同一 `messageId` 可能有多条记录（轮首空标记 + 增量各落一条）→ 按锚点归并：
   * label/at/userRecordId 取**首条**，files/backups 取**最后非空**。
   */
  static fromRecords(records: readonly CheckpointRecord[]): CheckpointLog {
    const log = new CheckpointLog();
    for (const r of records) {
      const existing = log.#anchors.find((a) => a.messageId === r.messageId);
      if (existing) {
        if (r.files.length > 0) existing.files = [...r.files];
        if (r.backups && Object.keys(r.backups).length > 0) existing.backups = { ...r.backups };
        if (!existing.userRecordId && r.userRecordId) existing.userRecordId = r.userRecordId;
        continue;
      }
      log.#anchors.push({
        messageId: r.messageId,
        label: r.label,
        files: [...r.files],
        at: r.timestamp,
        ...(r.userRecordId ? { userRecordId: r.userRecordId } : {}),
        ...(r.backups ? { backups: { ...r.backups } } : {}),
      });
    }
    return log;
  }
}

/** 把锚点转成落盘记录（id/timestamp 由调用方给定，便于测试确定性） */
export function anchorToRecord(anchor: CheckpointAnchor, id: string, timestamp: number): CheckpointRecord {
  return {
    type: 'checkpoint',
    id,
    timestamp,
    messageId: anchor.messageId,
    label: anchor.label,
    files: [...anchor.files],
    ...(anchor.userRecordId ? { userRecordId: anchor.userRecordId } : {}),
    ...(anchor.backups ? { backups: { ...anchor.backups } } : {}),
  };
}

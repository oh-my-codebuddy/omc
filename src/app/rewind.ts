/**
 * rewind.ts（rewind P1.2）：`/rewind` 的编排纯函数 —— 范围语义、预览与结果文案、参数解析。
 *
 * 为什么单独抽纯函数：`/rewind` 是**破坏性**操作，范围到动作的映射、预览/结果文案、
 * 以及 `scope='Conversation'` 的禁用约束都属于「易错且值得锁死」的逻辑，
 * 用单测覆盖比在 main.ts 里内联可靠。
 *
 * 关键约束（2026-10-08 P0 探针，见 docs/plan/rewind/p0-feasibility-probe.md）：
 * - **文件回退** 走运行时 `rewind` 控制请求（`scope:'Code'`，支持 dry-run）；
 * - **对话回退** 必须走「重启会话 + `--resume-session-at`」，**绝不能**用运行时
 *   `scope:'Conversation'`（当前 CLI 下会把历史清空且不持久）；
 * - 因此本模块的 `scope` 只描述**语义**，具体动作由 main.ts 按 `scopeIncludes*` 编排。
 */
import type { RewindResult } from '../agent/session';
import type { CheckpointAnchor } from './rewind-checkpoints';

/** 回退范围（用户可见三选一，对齐 codebuddy） */
export type RewindScope = 'files' | 'conversation' | 'both';

export const DEFAULT_REWIND_SCOPE: RewindScope = 'both';

export interface RewindScopeOption {
  value: RewindScope;
  label: string;
  description: string;
}

/** 范围选项表（浮层用；顺序即展示顺序） */
export const REWIND_SCOPE_OPTIONS: readonly RewindScopeOption[] = [
  { value: 'both', label: '文件 + 对话', description: '恢复工作区文件并截断该轮及之后的对话（推荐）' },
  { value: 'files', label: '仅文件', description: '只恢复工作区文件，对话保持不变' },
  { value: 'conversation', label: '仅对话', description: '只截断该轮及之后的对话，保留磁盘文件' },
];

export function isRewindScope(v: string): v is RewindScope {
  return v === 'files' || v === 'conversation' || v === 'both';
}

/** 解析范围字符串（大小写不敏感 + 常见别名）；非法返回 null */
export function parseRewindScope(raw: string): RewindScope | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  const alias: Record<string, RewindScope> = {
    files: 'files',
    file: 'files',
    code: 'files',
    conversation: 'conversation',
    conv: 'conversation',
    history: 'conversation',
    both: 'both',
    all: 'both',
  };
  return alias[s] ?? null;
}

export function scopeIncludesFiles(scope: RewindScope): boolean {
  return scope === 'files' || scope === 'both';
}

export function scopeIncludesConversation(scope: RewindScope): boolean {
  return scope === 'conversation' || scope === 'both';
}

/** 候选行的单行标签（浮层 / 文本列表共用） */
export function anchorLabel(index1Based: number, anchor: CheckpointAnchor): string {
  const files = anchor.files.length > 0 ? `${anchor.files.length} 文件` : '无文件';
  return `#${index1Based} ${anchor.label || '(无标题)'} · ${files}`;
}

/** 文本列候选（非 TTY / `/rewind list`） */
export function formatAnchorList(anchors: readonly CheckpointAnchor[]): string[] {
  if (anchors.length === 0) {
    return ['没有可回退的检查点（只有产生过文件改动的轮次才有检查点）'];
  }
  return [
    '可回退的检查点（/rewind <编号> [files|conversation|both] 执行）：',
    ...anchors.map((a, i) => `  ${anchorLabel(i + 1, a)}`),
  ];
}

/** 把绝对路径压成可读模式（保留文件名，去掉本次工作目录前缀） */
function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join('/')}`;
}

/** dry-run 预览文案（文件回退范围） */
export function formatRewindPreview(anchor: CheckpointAnchor, dry: RewindResult): string[] {
  if (!dry.canRewind) {
    return [`无法回退：${dry.error ?? '未知原因'}`];
  }
  const files = dry.filesChanged ?? [];
  const lines = [
    `将回退「${anchor.label || '(无标题)'}」之前的文件改动：`,
    ...files.map((f) => `  • ${shortPath(f)}`),
  ];
  lines.push(`共 ${files.length} 个文件，+${dry.insertions ?? 0}/-${dry.deletions ?? 0} 行`);
  return lines;
}

/** 执行结果文案（分别报文件 / 对话） */
export function formatRewindResult(
  scope: RewindScope,
  fileResp: RewindResult | null,
  conversationDone: boolean,
): string[] {
  const lines: string[] = [];
  if (scopeIncludesFiles(scope)) {
    if (!fileResp) {
      lines.push('文件：未执行');
    } else if (!fileResp.canRewind) {
      // 「无活动会话」是可预期的环境态（新启动/刚回退），给可操作文案而非裸报错
      lines.push(isInactiveSessionError(fileResp) ? FILE_SKIP_INACTIVE_LINE : `文件：回退失败（${fileResp.error ?? '未知原因'}）`);
    } else if (fileResp.fileRewindError) {
      // 部分成功语义（CLI 协议）：历史已回退、文件回退失败
      lines.push(`文件：部分失败（${fileResp.fileRewindError}）—— 对话已回退，文件需手动处理`);
    } else {
      lines.push(`文件：已回退 ${(fileResp.filesChanged ?? []).length} 个文件（+${fileResp.insertions ?? 0}/-${fileResp.deletions ?? 0}）`);
    }
  }
  if (scopeIncludesConversation(scope)) {
    lines.push(conversationDone ? '对话：已回退到该轮之前' : '对话：未回退');
  }
  return lines.length > 0 ? lines : ['（无操作）'];
}

/** 回退后应保留的候选（丢弃目标及其之后；目标自身不可再回退） */
export function survivorsAfterRewind(
  anchors: readonly CheckpointAnchor[],
  targetMessageId: string,
): CheckpointAnchor[] {
  const idx = anchors.findIndex((a) => a.messageId === targetMessageId);
  return idx < 0 ? [...anchors] : anchors.slice(0, idx);
}

/**
 * CLI「无活动会话」判据（rewind P1.3 修复）。
 *
 * 实测（`scripts/probe-rewind-inactive.ts`）：运行时 `rewind`/`rewind_files` 控制请求需要
 * CLI 侧有「当前会话」—— 它只在**跑过至少一轮**后才存在（`sessionManager` 的 ALS/
 * `sessionSubject`，`CheckpointService.getActiveHistory` 依赖 `session.lastMessageId`）。
 * 于是：**新启动**或**刚被对话回退重启**的会话，在任何一轮之前回退文件必然报
 * `No active session`（探针 ①③ 失败 / ②④ 成功）。对话回退（`--resume-session-at` 重启）
 * 不受影响。
 */
export function isInactiveSessionError(resp: { canRewind: boolean; error?: string }): boolean {
  return !resp.canRewind && (resp.error ?? '').trim() === 'No active session';
}

/** 文件步被跳过（会话未激活）时的结果行 */
export const FILE_SKIP_INACTIVE_LINE =
  '文件：跳过（会话刚启动/刚回退，CLI 需先有一条消息才能回退文件）';

/** 会话重启后的一次性提示（main.ts 打印） */
export const INACTIVE_SESSION_NOTE =
  '本次会话已重启：文件回退需先发送任意一条消息（CLI 在此之前拒绝回退请求）';

/** 文件步失败但对话步仍要继续（rewind P1.3 修复：文件失败不阻塞对话） */
export function fileStepSkippable(resp: { canRewind: boolean; error?: string; fileRewindError?: string }): boolean {
  return !resp.canRewind && !resp.fileRewindError;
}

// ---------- 本地恢复兜底（CLI teammate-message 内容嗅探 bug 对策，2026-10-09）----------
/**
 * 背景（真机实证，见 docs/plan/rewind/bug-handoff-rewind-lockup.md §3 修订）：CLI 把项目指令
 * 文件注入**首轮用户消息**的运行时文本；若指令文件含 `<teammate-message` 字面量（例如本仓
 * AGENTS.md 对 teammate 协议的文档），CLI 的 `isRealUserMessageItem` 内容嗅探
 * （`/<teammate-message\b/i.test(用户消息文本)`）会把首轮用户消息误判为「非真实用户消息」，
 * `findCheckpointByUserMessageId` 因此找不到**首轮锚点** → `rewind`/`rewind_files` 报
 * `No checkpoint associated`（后续轮文本干净不受影响；落盘 jsonl 存的是干净文本，磁盘上看不出）。
 *
 * 对策：该错误且锚点确实存在于 CLI 会话记录时，omc 用快照事件透传的 `trackedFileBackups`
 * 自行恢复文件（备份全文在 `~/.codebuddy/file-history/<sid>/`）。
 */

/** CLI 内容嗅探误判的报错判据（rewind/rewind_files 两 handler 共用该模板） */
export function isNoCheckpointError(resp: { canRewind: boolean; error?: string }): boolean {
  return !resp.canRewind && (resp.error ?? '').startsWith('No checkpoint associated');
}

/** 本地恢复计划（纯数据；IO 在 main.ts） */
export interface LocalRestorePlan {
  /** 写回备份内容的文件（path 原样 = 快照口径，工作区内相对路径 / 跨目录绝对路径） */
  restore: Array<{ path: string; backupFileName: string }>;
  /** 回退语义 = 删除的文件（快照时 existedAtTrack=false） */
  remove: string[];
}

/**
 * 由锚点序列计算「回退到 target 之前」的本地恢复计划。
 *
 * 语义与 CLI `revertToCheckpoint(..., 'Code')` 对齐：从 target 锚点（含）向后逐轮看各文件
 * 的**首个**备份记录 —— 该记录即「这轮编辑之前」的文件状态，也就是回退目标态；
 * `existedAtTrack=false` → 当时文件不存在 → 删除。`backupFileName` 缺失且无需删除的
 * （version 0 边缘）无法恢复，跳过。
 *
 * @returns null = 锚点不存在或完全无备份数据（调用方不要走兜底，按原错误如实报）
 */
export function planLocalRestore(
  anchors: readonly CheckpointAnchor[],
  targetMessageId: string,
): LocalRestorePlan | null {
  const idx = anchors.findIndex((a) => a.messageId === targetMessageId);
  if (idx < 0) return null;
  const decided = new Map<string, { backupFileName?: string; existedAtTrack: boolean }>();
  for (let i = idx; i < anchors.length; i++) {
    const backups = anchors[i].backups;
    if (!backups) continue;
    for (const [path, rec] of Object.entries(backups)) {
      if (decided.has(path)) continue;
      decided.set(path, {
        ...(rec.backupFileName ? { backupFileName: rec.backupFileName } : {}),
        existedAtTrack: rec.existedAtTrack ?? true,
      });
    }
  }
  const plan: LocalRestorePlan = { restore: [], remove: [] };
  for (const [path, rec] of decided) {
    if (!rec.existedAtTrack) plan.remove.push(path);
    else if (rec.backupFileName) plan.restore.push({ path, backupFileName: rec.backupFileName });
  }
  return plan.restore.length + plan.remove.length > 0 ? plan : null;
}

/** 本地恢复预览文案（dry-run 兜底；无行数统计，逐文件标注动作） */
export function formatLocalRestorePreview(anchor: CheckpointAnchor, plan: LocalRestorePlan): string[] {
  return [
    `将回退「${anchor.label || '(无标题)'}」之前的文件改动（本地备份恢复，CLI 校验受阻）：`,
    ...plan.restore.map((r) => `  • ${shortPath(r.path)}（恢复备份）`),
    ...plan.remove.map((p) => `  • ${shortPath(p)}（删除）`),
    `共 ${plan.restore.length + plan.remove.length} 个文件`,
  ];
}

/** 本地恢复执行结果（main.ts IO 层产出） */
export interface LocalRestoreOutcome {
  restored: string[];
  removed: string[];
  failed: Array<{ path: string; error: string }>;
}

/** 本地恢复结果文案（执行兜底） */
export function formatLocalRestoreOutcome(outcome: LocalRestoreOutcome): string[] {
  const lines: string[] = [];
  const ok = outcome.restored.length + outcome.removed.length;
  if (ok > 0) {
    lines.push(`文件：已回退 ${ok} 个文件（本地备份恢复；CLI 因已知内容嗅探问题拒绝该校验）`);
  }
  for (const f of outcome.failed) {
    lines.push(`文件：恢复失败 ${shortPath(f.path)}（${f.error}）`);
  }
  if (lines.length === 0) lines.push('文件：无可恢复内容');
  return lines;
}

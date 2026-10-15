/**
 * jsonl.ts — JSONL 会话持久化（P6.1）。
 *
 * 存储：`~/.omc/projects/<escaped-cwd>/<sessionId>.jsonl`
 * （`OMC_CONFIG_DIR` 可覆盖，见 src/config/paths.ts；目录名 = cwd 绝对路径 escaped，
 *  形如 `Users-you-Projects-demo`，碰撞兜底见 `projectStoreDir`）。
 *
 * 只记定稿事件（text_final/tool_start/tool_result/result）+ user 记录，
 * 不记 delta/status/error/system_init（replay 不需要，且会放大文件）。
 * 每行一条 JSON：UIEvent 原样序列化；user 记录为合成事件 {type:'user', text}。
 *
 * 容错：写盘失败静默（持久化不阻塞对话）；load 跳过坏行。
 * 全程 Node 标准 API（node:fs/node:crypto/node:path/node:os），不用 Bun 专有 API。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sessionsDir as sessionDir } from '../config/paths';
import type { CheckpointBackupEntry, ResultEvent, TextFinal, ToolResult, ToolStart } from '../agent/types';
import type { BashCardDetails } from '../app/bash-mode';

export { sessionDir };

/** 用户消息记录（合成事件，重放时走 chatView.echoUser） */
export interface UserRecord {
  type: 'user';
  id: string;
  timestamp: number;
  text: string;
}

/**
 * 子代理「完成卡」记录（subagent-visibility P2.7）。
 *
 * 为什么要落盘：CLI **不把** teammate 的 inbox 注入与 lead 续话推给 SDK 宿主，omc 只能靠
 * 「读 CLI 落盘记录 + 自己判定完成」来补一张卡。这张卡此前只渲染不落盘 → **事后无法追溯
 * 它到底有没有出现过**（用户与维护者都只能靠回忆/截图）。落盘后：
 * ① `~/.omc/projects/<escaped-cwd>/<sid>.jsonl` 可查；② `resume` 重放会重建这张卡。
 */
export interface SubagentDoneRecord {
  type: 'subagent_done';
  id: string;
  timestamp: number;
  /** 子代理展示名（如 `general-purpose-1`） */
  name: string;
  /** SDK `task_started.task_id`（= CLI `subagents/<taskId>.jsonl` 文件名） */
  taskId: string;
  description: string;
  /** 从观察到子代理首次出现到判定完成的耗时（ms） */
  elapsedMs: number;
  /** 子代理最终产出（已按行截断） */
  outcome: string[];
  /** 缺省 = completed；`failed` = 僵尸判定（工具调用悬空超时，见 `stuckTool`） */
  status?: 'completed' | 'failed';
  /** 僵尸现场：最后一个未配对工具调用的 `name: 入参摘要`（仅 status=failed） */
  stuckTool?: string;
  /** teammate 交付报告**全文**（完成卡只显示 `outcome` 前几行；全文供 /export 与聚焦视图） */
  report?: string;
}

/**
 * 文件检查点锚点记录（rewind P1.0）。
 *
 * 为什么要落盘：`/rewind` 的候选来自 SDK `file-history-snapshot`（一轮一条，见
 * `src/app/rewind-checkpoints.ts`），而该消息只在 live 流里出现；`/resume` 重放的是
 * 本文件的事件流 → 不落盘则恢复会话后候选列表为空、无法回退。
 */
export interface CheckpointRecord {
  type: 'checkpoint';
  id: string;
  timestamp: number;
  /** CLI user item id（= `snapshot.messageId`，回退锚点） */
  messageId: string;
  /** 该轮用户消息首行 */
  label: string;
  /** 该轮被跟踪的文件 */
  files: string[];
  /** 该轮 `UserRecord.id`（对话回退截断转录区用） */
  userRecordId?: string;
  /** 该轮各文件备份记录（rewind 本地恢复兜底；老记录可缺省） */
  backups?: Record<string, CheckpointBackupEntry>;
}

/**
 * `!` / `!!` bash 命令记录（input-interactions P1）。
 *
 * 为什么要落盘：bash 命令**不触发模型轮**（omp/codebuddy 语义），若不落盘，
 * `resume` 重放时这张回显卡会凭空消失（与 subagent_done 同理由）。
 * 存的是 `BashCardDetails` 的**净化文本**（无 ANSI）—— 彩色是 UI 层的 vterm 回放，
 * 不落盘（同 omp `bashExecutionToText` 口径）。
 */
export type BashRecord = { type: 'bash'; id: string; timestamp: number } & BashCardDetails;

export type LogRecord =
  | UserRecord
  | TextFinal
  | ToolStart
  | ToolResult
  | ResultEvent
  | SubagentDoneRecord
  | CheckpointRecord
  | BashRecord;

export interface SessionMeta {
  sessionId: string;
  mtime: number;
  /** 标题（sidecar 优先，回落首条 user 消息首行截断），列表/选择器用 */
  title: string;
}

export function sessionFile(cwd: string, sessionId: string): string {
  return join(sessionDir(cwd), `${sessionId}.jsonl`);
}

/**
 * ux-port-v2 P5.1：标题 sidecar（/rename 写入，纯文本一行）。
 * 不动 jsonl 本体——追加式存储改首行代价大且破坏 replay。
 * 无会话删除命令，孤儿 sidecar 不处理。
 */
export function titleFile(cwd: string, sessionId: string): string {
  return join(sessionDir(cwd), `${sessionId}.title`);
}

/**
 * session-title P1.3：自动标题 sidecar（机器生成，纯文本一行）。
 * **与 `titleFile`（用户手改）分开** —— 保证 auto 永不覆盖 `/rename`（D7）。
 */
export function autoTitleFile(cwd: string, sessionId: string): string {
  return join(sessionDir(cwd), `${sessionId}.autotitle`);
}

/** 读标题 sidecar：文件不存在/首行为空 → null */
function readTitleSidecar(path: string): string | null {
  try {
    const t = readFileSync(path, 'utf8').split('\n')[0].trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

/** 写标题 sidecar（只取首行非空）；失败返回 false（只读目录等），不抛 */
function writeTitleSidecar(path: string, title: string): boolean {
  const first = (title ?? '').split('\n')[0].trim();
  if (!first) return false; // 不写空标题（空文件会被读端判 null，写出来只是噪音）
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${first}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * 读 `/rename` 用户标题：缺失/空 → null（调用方回落 auto/首句）。
 * 导出供「已命名」门禁判定（`main.maybeStartTitle`）—— 用户手改过就不该再花一次 auto 生成。
 */
export function readUserTitle(cwd: string, sessionId: string): string | null {
  return readTitleSidecar(titleFile(cwd, sessionId));
}

/** 读自动标题：缺失/空 → null（调用方回落首句） */
export function readAutoTitle(cwd: string, sessionId: string): string | null {
  return readTitleSidecar(autoTitleFile(cwd, sessionId));
}

/**
 * 会话是否已命名（D6/D7 门禁口径）：用户手改（`.title`）**或** 已自动生成（`.autotitle`）任一存在。
 * 只看 `.autotitle` 会漏掉「用户先 `/rename`、之后才发实质消息」→ 白跑一次旁路生成
 * （2026-10-13 真机数据实证：rename 15s 后仍生成了一条用不上的 `.autotitle`）。
 */
export function isSessionNamed(cwd: string, sessionId: string): boolean {
  return readUserTitle(cwd, sessionId) !== null || readAutoTitle(cwd, sessionId) !== null;
}

/** 写 sidecar 标题（/rename）；失败返回 false（只读目录等），不抛 */
export function writeSidecarTitle(cwd: string, sessionId: string, title: string): boolean {
  return writeTitleSidecar(titleFile(cwd, sessionId), title);
}

/** 写自动标题（session-title P1.3）；失败/空标题返回 false，不抛 */
export function writeAutoTitle(cwd: string, sessionId: string, title: string): boolean {
  return writeTitleSidecar(autoTitleFile(cwd, sessionId), title);
}

/**
 * 会话标题读链（D7）：`/rename` 手改 `.title` > auto `.autotitle` > 首条 user 消息首行。
 * statusline `session_name` 段与 `/resume` 列表**共用**这一条链（后者经 {@link SessionLog.list}）。
 */
export function sessionTitle(cwd: string, sessionId: string): string {
  return resolveTitle(cwd, sessionId, sessionFile(cwd, sessionId));
}

/** 三段落链（单一真源；`file` = 会话 jsonl 路径，供首句回落用） */
function resolveTitle(cwd: string, sessionId: string, file: string): string {
  return readUserTitle(cwd, sessionId) ?? readAutoTitle(cwd, sessionId) ?? firstUserTitle(file);
}

export class SessionLog {
  readonly file: string;
  private dirReady = false;

  constructor(
    readonly cwd: string,
    readonly sessionId: string,
  ) {
    this.file = sessionFile(cwd, sessionId);
  }

  /** 追加一条定稿记录；失败静默（不阻塞对话） */
  append(record: LogRecord): void {
    try {
      if (!this.dirReady) {
        mkdirSync(sessionDir(this.cwd), { recursive: true });
        this.dirReady = true;
      }
      appendFileSync(this.file, JSON.stringify(record) + '\n');
    } catch {
      // 磁盘满/权限等：忽略
    }
  }

  /** 读取会话全部记录（坏行跳过）；文件不存在返回 [] */
  static load(cwd: string, sessionId: string): LogRecord[] {
    return parseFile(sessionFile(cwd, sessionId));
  }

  /**
   * 重写整个记录文件（rewind P1.4）。
   *
   * 为什么必须重写：jsonl 是追加式，但「对话回退」要求把某轮及其之后的记录**永久丢弃**
   * （否则 `/resume` 重放会把已撤销的轮次又渲染出来）。这是破坏性操作，仅在用户经
   * `/rewind` 显式确认后调用。
   * @returns 是否写成功（失败返回 false，不抛）
   */
  static rewrite(cwd: string, sessionId: string, records: readonly LogRecord[]): boolean {
    try {
      mkdirSync(sessionDir(cwd), { recursive: true });
      writeFileSync(sessionFile(cwd, sessionId), records.map((r) => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : ''));
      return true;
    } catch {
      return false;
    }
  }

  /** 当前 cwd 最近一个会话的 sessionId（按 mtime），无则 null */
  static latest(cwd: string): string | null {
    const metas = SessionLog.list(cwd);
    return metas.length > 0 ? metas[0].sessionId : null;
  }

  /** 当前 cwd 的会话列表，mtime 倒序；标题读链同 {@link sessionTitle}（.title > .autotitle > 首句） */
  static list(cwd: string): SessionMeta[] {
    const dir = sessionDir(cwd);
    if (!existsSync(dir)) return [];
    const metas: SessionMeta[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = join(dir, name);
      try {
        const { mtimeMs } = statSync(file);
        const sessionId = name.slice(0, -'.jsonl'.length);
        metas.push({
          sessionId,
          mtime: mtimeMs,
          title: resolveTitle(cwd, sessionId, file),
        });
      } catch {
        // stat 失败跳过
      }
    }
    metas.sort((a, b) => b.mtime - a.mtime);
    return metas;
  }
}

function parseFile(file: string): LogRecord[] {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: LogRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LogRecord);
    } catch {
      // 坏行跳过
    }
  }
  return out;
}

function firstUserTitle(file: string): string {
  for (const rec of parseFile(file)) {
    if (rec.type === 'user') {
      const firstLine = rec.text.split('\n')[0].trim();
      return firstLine.length > 60 ? firstLine.slice(0, 57) + '...' : firstLine;
    }
  }
  return '(无用户消息)';
}

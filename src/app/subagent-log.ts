/**
 * CLI 侧子代理记录读取（subagent-visibility P2.7）。
 *
 * ⚠️ **CLI 耦合点**：路径与行格式是 codebuddy CLI 的**内部布局**（非 SDK 公开契约）。
 * 升级 CLI / SDK 时需复检（见 AGENTS.md「与 CLI 的耦合点」）：
 *   1. 目录布局 `~/.codebuddy/projects/<escaped-cwd>/<sessionId>/subagents/<taskId>.jsonl`
 *   2. `<escaped-cwd>` 规则 = `realpath(cwd)` 去前导 `/`、`/` → `-`
 *   3. 行格式（`message` / `reasoning` / `function_call` / `function_call_result` / `session-meta`）
 *
 * **为什么需要它**：SDK 流**不推送** teammate 的 inbox 注入与 lead 自动续话 ——
 * 2026-10-07 `scripts/probe-teammate-sdk.ts` 实证：子代理完成后 drain 100s 只收到
 * `system/init`，零 `<teammate-message>`；而 CLI 自己的会话日志里该轮完整存在。
 * 故子代理的「过程 + 最终产出」只能从 CLI 落盘文件取。
 *
 * **关联键**：CLI 文件名 `<taskId>.jsonl` 的 `taskId` 与 SDK `task_started.task_id`
 * （形如 `agent-<uuid>`）**完全一致**（2026-10-07 实测），无需启发式配对。
 *
 * 纯逻辑（除路径推导用 `node:fs`/`node:os`），解析函数可单测。
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { makeEventId } from '../agent/types';
import type { ViewRecord } from './view-log';

/** realpath(cwd) 去前导 `/`、`/` → `-`（CLI 的 projects 目录转义规则） */
export function escapeCwd(cwd: string): string {
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {
    // 路径不存在（罕见）→ 用原值，后面 existsSync 会兜底
  }
  return real.replace(/^\//, '').replace(/\//g, '-');
}

/** 该会话的子代理记录目录 */
export function subagentsDir(cwd: string, sessionId: string): string {
  return join(homedir(), '.codebuddy', 'projects', escapeCwd(cwd), sessionId, 'subagents');
}

/** CLI 主会话 jsonl —— teammate 完成注入的权威落盘（见 readTeammateReports） */
export function mainSessionLogPath(cwd: string, sessionId: string): string {
  return join(homedir(), '.codebuddy', 'projects', escapeCwd(cwd), `${sessionId}.jsonl`);
}

/** 单个子代理的记录文件路径（`taskId` = SDK `task_started.task_id`） */
export function subagentLogPath(cwd: string, sessionId: string, taskId: string): string {
  return join(subagentsDir(cwd, sessionId), `${taskId}.jsonl`);
}

/** 列出现存子代理记录（`taskId` ← 文件名），按 mtime 升序 */
export function listSubagentLogs(cwd: string, sessionId: string): { taskId: string; path: string; mtimeMs: number }[] {
  const dir = subagentsDir(cwd, sessionId);
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const out: { taskId: string; path: string; mtimeMs: number }[] = [];
  for (const n of names) {
    const path = join(dir, n);
    try {
      out.push({ taskId: n.slice(0, -'.jsonl'.length), path, mtimeMs: statSync(path).mtimeMs });
    } catch {
      // 竞态：读取中文件消失 → 跳过
    }
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

/**
 * 完成判定（P2.7）：无「未配对的 function_call」（子代理没有正在等的工具）**且**
 * 文件已静止 > {@link DONE_SETTLE_MS}（避开「工具间思考」窗口）**且**已有实质进展。
 *
 * 实证校准（2026-10-07 三个样本）：完成的样本 `function_call` 全部有配对 result；
 * 未完成的样本末尾是 pending `function_call`（等 `git clone` 等命令）→ 判据天然排除
 * 「正在跑长命令」的情况（此时无 result 且 mtime 不更新）。
 *
 * ⚠️ 这只是**回退**判据（2026-10-07 会话 01a1168e 实证翻车）：子代理**思考间隙**
 * （全配对 + 静止 13s，模型在长考）会被误判完成 → 真报告被丢。主信号已改为
 * `readTeammateReports`（CLI 主会话 jsonl 的确定性注入）；本判据只兜「CLI 无注入」
 * 的边角，故 settle 取 20s（实测思考间隙 13.1s，留余量），完成卡稍慢但不杀真报告。
 */
export const DONE_SETTLE_MS = 20_000;

export interface SubagentStatus {
  /** 记录文件是否存在 */
  exists: boolean;
  /** 无未配对的 `function_call`（没有正在执行的工具） */
  settled: boolean;
  /** 已有实质进展（出现过 assistant 文本或工具结果）——避免「刚启动只有任务说明」被误判完成 */
  hasProgress: boolean;
  mtimeMs: number;
}

export function subagentStatus(cwd: string, sessionId: string, taskId: string): SubagentStatus {
  const path = subagentLogPath(cwd, sessionId, taskId);
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return { exists: false, settled: false, hasProgress: false, mtimeMs: 0 };
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { exists: false, settled: false, hasProgress: false, mtimeMs };
  }
  const { settled, hasProgress } = assessSubagentRows(text);
  return { exists: true, settled, hasProgress, mtimeMs };
}

/**
 * 从记录文本判定「无 pending 工具调用 / 已有实质进展」（纯函数，便于单测）。
 * pending = 出现过 `function_call` 但没有配对 `function_call_result` 的 callId。
 */
export function assessSubagentRows(text: string): { settled: boolean; hasProgress: boolean } {
  const pending = new Set<string>();
  let hasProgress = false;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r: SubagentRow;
    try {
      r = JSON.parse(line) as SubagentRow;
    } catch {
      continue;
    }
    if (r.type === 'function_call' && r.callId) pending.add(r.callId);
    else if (r.type === 'function_call_result') {
      if (r.callId) pending.delete(r.callId);
      hasProgress = true;
    } else if (r.type === 'message' && r.role === 'assistant') {
      hasProgress = true;
    }
  }
  return { settled: pending.size === 0, hasProgress };
}

/**
 * 子代理是否已完成（P2.7 口径）：吃已读到的 {@link SubagentStatus}（避免重复读文件）。
 * = 记录存在 ∧ 无 pending 工具调用 ∧ 已有实质进展 ∧ 文件静止 > `settleMs`。
 */
export function isSubagentDone(st: SubagentStatus, now: number, settleMs: number = DONE_SETTLE_MS): boolean {
  return st.exists && st.settled && st.hasProgress && now - st.mtimeMs > settleMs;
}

/**
 * 僵尸判定（2026-10-07 会话 01a1168e 实证）：`function_call` 悬空（子代理在工具里）且
 * 记录静止 > {@link ZOMBIE_MS} → 子代理进程很可能已挂死/被杀（如 `git clone` 卡网络后被杀，
 * 永远不写 `function_call_result`）。**没有它**：完成判定要求 settled → 永不完成；
 * touch 又吃 mtime 25s 窗 → 面板 ~20s 后无声消失，用户看到「卡住→消失→无结果」。
 * 取 5min：正常工具间思考/写入间隔远低于此；合法超长工具（大克隆/构建）可能误伤，
 * 故文案用「疑似中断」而非定论。
 */
export const ZOMBIE_MS = 5 * 60_000;

export function isSubagentZombie(st: SubagentStatus, now: number, zombieMs: number = ZOMBIE_MS): boolean {
  return st.exists && !st.settled && now - st.mtimeMs > zombieMs;
}

/**
 * 读最后一个**未配对**的 `function_call`（子代理卡住时的「现场」），供僵尸卡展示。
 * 无悬空调用 / 文件不可读返回 null。
 */
export function readPendingCall(
  cwd: string,
  sessionId: string,
  taskId: string,
): { name: string; summary: string } | null {
  const path = subagentLogPath(cwd, sessionId, taskId);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const pending = new Map<string, { name: string; summary: string }>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r: SubagentRow;
    try {
      r = JSON.parse(line) as SubagentRow;
    } catch {
      continue;
    }
    if (r.type === 'function_call' && r.callId && r.name) {
      pending.set(r.callId, { name: r.name, summary: firstLine(r.arguments ?? '', 80) });
    } else if (r.type === 'function_call_result' && r.callId) {
      pending.delete(r.callId);
    }
  }
  const last = [...pending.values()].pop();
  return last ?? null;
}

// ---------- teammate 完成注入（确定性主信号） ----------

/**
 * 子代理**真正完成**的确定性信号（2026-10-07 会话 01a1160c / 01a1168e 双样本实证）。
 *
 * 子代理交付结果时，CLI 会往**主会话 jsonl** 注入 `role=user` 的
 * `<teammate-message teammate_id="<名字>" summary="…">报告正文` —— 这只在子代理
 * 真的交付后发生，不受「思考间隙静止」干扰（回退判据 `isSubagentDone` 翻车的根因）。
 * 另有框架自动通知 `teammate_id="system"` 的 `"<名字>" completed`（无正文）。
 *
 * 关联键：`teammate_id` = omc 的 `TaskEntry.name`（`<subagent_type>-<n>`，命名口径
 * 与 CLI 一致，双样本实测命中）。**CLI 耦合点**（AGENTS.md 表⑤同族）。
 */
export interface TeammateReport {
  /** teammate_id（= TaskEntry.name；system 通知已归一化为对应子代理名） */
  name: string;
  /** 注入消息的 summary 属性 */
  summary: string;
  /** 报告正文（system 通知无正文 → 空串，调用方回退 readSubagentOutcome） */
  text: string;
  /** 是否框架自动通知（`teammate_id="system"` 的 completed 消息） */
  system: boolean;
  /**
   * 注入行的落盘时间戳（epoch ms）。**必须用它过滤同名陈旧报告**（2026-10-07 会话
   * 01a116f3 实证）：CLI 对两个同类型子代理都叫 `general-purpose-1`，新任务若命中
   * 主会话 jsonl 里上一个同名报告会**秒判完成、贴错报告** → 只接受
   * `timestamp >= TaskEntry.startedAt` 的注入。
   */
  timestamp: number;
}

const TEAMMATE_TAG_RE = /<teammate-message\s+([^>]*)>/;
const TEAMMATE_ID_RE = /teammate_id="([^"]+)"/;
const TEAMMATE_SUMMARY_RE = /summary="([^"]*)"/;
const SYSTEM_COMPLETED_RE = /^(.+?) completed/;

/** 从一段文本块解析 teammate 注入（无注入返回 null，纯函数便于单测） */
function parseTeammateBlock(text: string): { id: string; summary: string; body: string } | null {
  const m = TEAMMATE_TAG_RE.exec(text);
  if (!m) return null;
  const attrs = m[1] ?? '';
  const id = TEAMMATE_ID_RE.exec(attrs)?.[1];
  if (!id) return null;
  const summary = TEAMMATE_SUMMARY_RE.exec(attrs)?.[1] ?? '';
  const body = text
    .slice(m.index + m[0].length)
    .replace(/<\/teammate-message>/g, '')
    .trim();
  return { id, summary, body };
}

/**
 * 协议 JSON 判定（2026-10-07 会话 01a1168e 实证）：teammate 注入里混着
 * `{"type":"shutdown_response",…}` 这类 SendMessage 协议回执 —— 它不是报告，
 * 且**后到会覆盖真报告**（last-wins 的陷阱）。形态：正文是带 `type` 字段的 JSON。
 */
function isProtocolJson(body: string): boolean {
  if (!body.startsWith('{')) return false;
  try {
    const o = JSON.parse(body) as { type?: unknown };
    return typeof o?.type === 'string';
  } catch {
    return false;
  }
}

/**
 * 扫描主会话 jsonl 文本，返回 `子代理名 → 完成报告`（同名后到的覆盖先到的）。
 * 同时收两类：① `teammate_id="<名字>"` 的交付消息（带正文）；② `teammate_id="system"`
 * 的 `"<名字>" completed` 自动通知（无正文）。非法行 / 非注入块跳过。
 */
export function readTeammateReports(text: string): Map<string, TeammateReport> {
  const out = new Map<string, TeammateReport>();
  for (const line of text.split('\n')) {
    if (!line.includes('teammate-message')) continue;
    let r: SubagentRow;
    try {
      r = JSON.parse(line) as SubagentRow;
    } catch {
      continue;
    }
    if (r.type !== 'message') continue;
    const ts = typeof r.timestamp === 'number' ? r.timestamp : 0;
    for (const b of blockTexts(r.content)) {
      const parsed = parseTeammateBlock(b.text);
      if (!parsed) continue;
      if (parsed.id === 'system') {
        // 框架自动通知：summary = "<名字> completed: <任务描述>" → 归一化为子代理名
        const name = SYSTEM_COMPLETED_RE.exec(parsed.summary)?.[1]?.trim();
        if (name && !out.has(name)) out.set(name, { name, summary: parsed.summary, text: '', system: true, timestamp: ts });
      } else if (!isProtocolJson(parsed.body)) {
        // 交付消息带正文 → 覆盖先前的 system 通知（正文更优）；
        // 协议回执（shutdown_response 等 JSON）跳过 —— 否则会盖掉真报告
        out.set(parsed.id, { name: parsed.id, summary: parsed.summary, text: parsed.body, system: false, timestamp: ts });
      }
    }
  }
  return out;
}

/** 读主会话 jsonl 的 teammate 注入（文件不存在/不可读返回空 Map） */
export function readMainSessionTeammateReports(cwd: string, sessionId: string): Map<string, TeammateReport> {
  try {
    return readTeammateReports(readFileSync(mainSessionLogPath(cwd, sessionId), 'utf8'));
  } catch {
    return new Map();
  }
}

/**
 * 读子代理的**最终产出**（最后一条 assistant `output_text`），供「完成卡」展示。
 * 文件不存在 / 无产出返回 null；超出 `maxLines` 截断并加省略行。
 */
export function readSubagentOutcome(cwd: string, sessionId: string, taskId: string, maxLines = 8): string[] | null {
  const path = subagentLogPath(cwd, sessionId, taskId);
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let last = '';
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r: SubagentRow;
    try {
      r = JSON.parse(line) as SubagentRow;
    } catch {
      continue;
    }
    if (r.type !== 'message') continue;
    for (const b of blockTexts(r.content)) {
      if (b.kind !== 'input_text' && b.text.trim()) last = b.text;
    }
  }
  if (!last) return null;
  const lines = last.replace(/\n+$/, '').split('\n');
  return lines.length > maxLines ? [...lines.slice(0, maxLines), '…'] : lines;
}

/** 读一个子代理记录并解析为视图记录；文件不存在 / 不可读返回 null */
export function readSubagentRecords(cwd: string, sessionId: string, taskId: string): ViewRecord[] | null {
  const path = subagentLogPath(cwd, sessionId, taskId);
  if (!existsSync(path)) return null;
  try {
    return parseSubagentJsonl(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** CLI 子代理记录的一行（宽松类型：只取用到的字段） */
interface SubagentRow {
  type?: string;
  role?: string;
  timestamp?: number;
  content?: unknown;
  name?: string;
  callId?: string;
  arguments?: string;
  status?: string;
  output?: unknown;
}

/** 从 content 块数组里抽 `text`（input_text / output_text / text 三种形态） */
function blockTexts(content: unknown): { kind: string; text: string }[] {
  if (!Array.isArray(content)) return [];
  const out: { kind: string; text: string }[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const b = raw as { type?: unknown; text?: unknown };
    if (typeof b.text !== 'string') continue;
    out.push({ kind: String(b.type ?? 'text'), text: b.text });
  }
  return out;
}

/** 抽 function_call_result 的输出文本（`output.text`） */
function resultText(output: unknown): string {
  if (output && typeof output === 'object') {
    const t = (output as { text?: unknown }).text;
    if (typeof t === 'string') return t;
  }
  return typeof output === 'string' ? output : '';
}

const firstLine = (s: string, max = 100): string => {
  const l = s.split('\n').find((x) => x.trim().length > 0) ?? '';
  return l.length > max ? `${l.slice(0, max - 3)}...` : l;
};

/**
 * 解析 CLI 子代理 jsonl → `ViewRecord[]`（喂给 P2.4 的 `switchView` 重放）。
 *
 * 映射：
 * - 首行 `message`(role=user, input_text `<teammate-message>`) = lead 给子代理的任务说明 → `info`（取正文首行）
 * - `message`(role=assistant, output_text) → `text_final`（子代理的叙述 / 最终产出）
 * - `function_call`(name,callId,arguments) → `tool_start`
 * - `function_call_result`(callId,output.text) → `tool_result`
 * - `reasoning` / `session-meta` → 跳过（实测 reasoning 无文本）
 */
export function parseSubagentJsonl(text: string): ViewRecord[] {
  const rows: ViewRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r: SubagentRow;
    try {
      r = JSON.parse(line) as SubagentRow;
    } catch {
      continue; // 半行 / 非法 JSON → 跳过（tail 追加中常见）
    }
    const ts = typeof r.timestamp === 'number' ? r.timestamp : Date.now();
    if (r.type === 'message') {
      const blocks = blockTexts(r.content);
      for (const b of blocks) {
        if (b.kind === 'input_text') {
          // 首条 teammate-message = 任务说明：剥掉 XML 标签取正文（长任务说明常无闭合标签，
          // 故「去开标签」不能依赖闭合匹配）
          const body =
            b.text
              .replace(/<teammate-message[^>]*>/g, '')
              .replace(/<\/teammate-message>/g, '')
              .trim() || b.text;
          rows.push({ kind: 'info', lines: [body.split('\n').slice(0, 4).join('\n')] });
        } else {
          rows.push({
            kind: 'event',
            ev: { id: makeEventId(), timestamp: ts, type: 'text_final', text: b.text },
          });
        }
      }
    } else if (r.type === 'function_call' && r.name) {
      rows.push({
        kind: 'event',
        ev: {
          id: makeEventId(),
          timestamp: ts,
          type: 'tool_start',
          toolUseId: r.callId ?? makeEventId(),
          toolName: r.name,
          summary: firstLine(r.arguments ?? '', 80),
          ...(r.arguments ? { detail: r.arguments } : {}),
        },
      });
    } else if (r.type === 'function_call_result') {
      const out = resultText(r.output);
      rows.push({
        kind: 'event',
        ev: {
          id: makeEventId(),
          timestamp: ts,
          type: 'tool_result',
          toolUseId: r.callId ?? makeEventId(),
          summary: firstLine(out),
          isError: r.status === 'error',
          ...(out ? { detail: out.length > 2000 ? `${out.slice(0, 2000)}...` : out } : {}),
        },
      });
    }
    // reasoning / session-meta / 其它 → 跳过
  }
  return rows;
}

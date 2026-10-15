/**
 * workflow-journal.ts — 从 CLI 的 workflow journal 读**实时**进度（model-variants-and-workflows P2 修订）。
 *
 * 背景（2026-10-09 用户真机反馈「Workflow Hub 只有耗时变、内容不变」）：
 * stdio 通道上 CLI **只在最初发两三条 `task_progress` 快照**，之后 agent 完成 / 阶段推进
 * **不再发**（`scripts/probe-workflow.ts runtime multi` 实证：2 阶段 2 agent 全程只有 3 条
 * 快照，且都是 `PhaseA + agent:start`；终态只靠 `task_notification`）。
 * 而 CLI 在磁盘上**逐条追加**执行日志：
 *   `<home>/projects/<escCwd>/<sessionId>/subagents/workflows/wf_<runId>/journal.jsonl`
 * 行类型（实测 206 行 = 1 run_started + 102 agent_started + 102 agent_finished + 1 run_finished）：
 *   - `{type:'run_started', runId, name, contentHash, startedAt}`
 *   - `{type:'agent_started', runId, key, prevKey, label, phase, startedAt}`
 *   - `{type:'agent_finished', runId, key, tokens, sessionId, result, endedAt}`
 *   - `{type:'run_finished', runId, status, endedAt, output}`
 * `runId` == `task_started.task_id`（T1 A1）→ omc 可定点读取。
 *
 * 另：同目录的 `wf_<runId>.json`（run record）只在**开始 + 结束**各写一次，运行中不更新，
 * 故不作为实时源（仅终态含 `workflowProgress` 全量 + `result` 报告）。
 *
 * 纯解析函数（`parseWorkflowJournal` / `journalToTimeline`）无 IO，便于单测。
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowTimelineItem } from '../agent/types';
import { escapeCwd, subagentsDir } from './subagent-log';

/** journal 路径（`<projects>/<escCwd>/<sid>/subagents/workflows/wf_<runId>/journal.jsonl`） */
export function workflowJournalPath(cwd: string, sessionId: string, runId: string): string {
  return join(subagentsDir(cwd, sessionId), 'workflows', `wf_${runId}`, 'journal.jsonl');
}

/** run record 路径（`<projects>/<escCwd>/<sid>/workflows/wf_<runId>.json`）——**终态**才有全量 */
export function workflowRunRecordPath(cwd: string, sessionId: string, runId: string): string {
  return join(homedir(), '.codebuddy', 'projects', escapeCwd(cwd), sessionId, 'workflows', `wf_${runId}.json`);
}

export interface WorkflowRunRecord {
  status?: string;
  /** 报告全文（Markdown，**含来源链接**；workflow 的最终交付物） */
  result?: string;
  output?: string;
  name?: string;
  agentCount?: number;
  totalTokens?: number;
  durationMs?: number;
}

/** 解析 run record 文本（非法 / 非对象 → null） */
export function parseWorkflowRunRecord(text: string): WorkflowRunRecord | null {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return null;
  const src = o as Record<string, unknown>;
  const rec: WorkflowRunRecord = {};
  for (const k of ['status', 'result', 'output', 'name'] as const) {
    if (typeof src[k] === 'string') rec[k] = src[k] as string;
  }
  for (const k of ['agentCount', 'totalTokens', 'durationMs'] as const) {
    if (typeof src[k] === 'number') rec[k] = src[k] as number;
  }
  return rec;
}

/** 读 run record（不存在 / 非法 → null）。注意：CLI **只在开始 + 结束**写它，运行中无 `result`。 */
export function readWorkflowRunRecord(cwd: string, sessionId: string, runId: string): WorkflowRunRecord | null {
  try {
    return parseWorkflowRunRecord(readFileSync(workflowRunRecordPath(cwd, sessionId, runId), 'utf8'));
  } catch {
    return null;
  }
}

/** 读报告全文（`result` 优先，回退 `output`）；无 / 空 → null */
export function readWorkflowReport(cwd: string, sessionId: string, runId: string): string | null {
  const rec = readWorkflowRunRecord(cwd, sessionId, runId);
  if (!rec) return null;
  const text = (rec.result ?? rec.output ?? '').trim();
  return text.length > 0 ? text : null;
}

export interface JournalAgent {
  key: string;
  label?: string;
  phase?: string;
  /** `start` = 已启动未收尾；`done` / `error` = 收尾态（run 结束后仍未收尾记为 error） */
  state: 'start' | 'done' | 'error';
  tokens?: number;
  startedAt?: number;
  endedAt?: number;
}

export interface WorkflowJournalSummary {
  runId: string;
  name?: string;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  startedAt?: number;
  endedAt?: number;
  /** 阶段标题（按 agent 首次出现的顺序） */
  phases: string[];
  agentStarted: number;
  agentFinished: number;
  currentPhase?: string;
  /** 已完成 agent 的 tokens 合计 */
  tokens: number;
  agents: JournalAgent[];
}

/** 解析 journal 文本（坏行跳过；无 `run_started` 视为非法 → null） */
export function parseWorkflowJournal(text: string): WorkflowJournalSummary | null {
  const started = new Map<string, JournalAgent>();
  const order: string[] = [];
  const phases: string[] = [];
  let runId = '';
  let name: string | undefined;
  let status: WorkflowJournalSummary['status'] = 'running';
  let startedAt: number | undefined;
  let endedAt: number | undefined;
  let agentFinished = 0;
  let tokens = 0;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // 半写行 / 损坏行：跳过
    }
    const t = o.type;
    if (t === 'run_started') {
      runId = String(o.runId ?? '');
      if (typeof o.name === 'string') name = o.name;
      if (typeof o.startedAt === 'number') startedAt = o.startedAt;
    } else if (t === 'agent_started') {
      const key = String(o.key ?? '');
      if (!key) continue;
      const phase = typeof o.phase === 'string' ? o.phase : undefined;
      if (phase && !phases.includes(phase)) phases.push(phase);
      started.set(key, {
        key,
        ...(typeof o.label === 'string' ? { label: o.label } : {}),
        ...(phase ? { phase } : {}),
        state: 'start',
        ...(typeof o.startedAt === 'number' ? { startedAt: o.startedAt } : {}),
      });
      order.push(key);
    } else if (t === 'agent_finished') {
      const key = String(o.key ?? '');
      const rec = started.get(key);
      agentFinished++;
      if (typeof o.tokens === 'number' && Number.isFinite(o.tokens)) tokens += o.tokens;
      if (rec) {
        rec.state = 'done';
        if (typeof o.endedAt === 'number') rec.endedAt = o.endedAt;
        if (typeof o.tokens === 'number' && Number.isFinite(o.tokens)) rec.tokens = o.tokens;
      } else if (key) {
        // 先 finish 后 start（异常顺序）：补一条 done 记录
        started.set(key, { key, state: 'done', ...(typeof o.tokens === 'number' ? { tokens: o.tokens } : {}) });
        order.push(key);
      }
    } else if (t === 'run_finished') {
      if (typeof o.status === 'string') {
        status = o.status === 'completed' || o.status === 'failed' || o.status === 'aborted' ? o.status : 'completed';
      }
      if (typeof o.endedAt === 'number') endedAt = o.endedAt;
    }
    // 未知 type：忽略（协议加性）
  }

  if (!runId) return null;
  const agents = order.map((k) => started.get(k)!).filter(Boolean);
  // 运行已结束但 agent 未收尾 → 视为 error（被中断/丢弃）
  if (status !== 'running') {
    for (const a of agents) if (a.state === 'start') a.state = 'error';
  }
  const running = [...agents].reverse().find((a) => a.state === 'start');
  const finishedLast = [...agents].reverse().find((a) => a.phase);
  return {
    runId,
    ...(name !== undefined ? { name } : {}),
    status,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    phases,
    agentStarted: agents.length,
    agentFinished,
    ...(running?.phase ?? finishedLast?.phase ?? phases[phases.length - 1]
      ? { currentPhase: running?.phase ?? finishedLast?.phase ?? phases[phases.length - 1] }
      : {}),
    tokens,
    agents,
  };
}

/** 读 journal（不存在 / 非法 → null） */
export function readWorkflowJournal(cwd: string, sessionId: string, runId: string): WorkflowJournalSummary | null {
  try {
    return parseWorkflowJournal(readFileSync(workflowJournalPath(cwd, sessionId, runId), 'utf8'));
  } catch {
    return null;
  }
}

/** 变化签名（`mtimeMs:size`）；不可读 → null（调用方跳过） */
export function workflowJournalSignature(cwd: string, sessionId: string, runId: string): string | null {
  try {
    const st = statSync(workflowJournalPath(cwd, sessionId, runId));
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

/**
 * journal → `WorkflowTimelineItem[]`（与 stdio `workflow_progress` 同构，供
 * `summarizeWorkflowProgress` / 进度视图**直接复用**）。
 */
export function journalToTimeline(j: WorkflowJournalSummary): WorkflowTimelineItem[] {
  const phaseIndex = new Map<string, number>();
  j.phases.forEach((title, i) => phaseIndex.set(title, i + 1));
  const items: WorkflowTimelineItem[] = [...j.phases.map((title, i) => ({ type: 'workflow_phase' as const, index: i + 1, title }))];
  j.agents.forEach((a, i) => {
    items.push({
      type: 'workflow_agent',
      index: i + 1,
      agentId: a.key,
      state: a.state,
      ...(a.label !== undefined ? { label: a.label } : {}),
      ...(a.phase ? { phaseTitle: a.phase, phaseIndex: phaseIndex.get(a.phase) ?? 0 } : {}),
      ...(a.startedAt !== undefined ? { startedAt: a.startedAt } : {}),
      ...(a.endedAt !== undefined ? { endedAt: a.endedAt } : {}),
      ...(a.tokens !== undefined ? { tokens: a.tokens } : {}),
    });
  });
  return items;
}

/**
 * workflow-progress.ts — workflow 进度时间线的聚合（model-variants-and-workflows P2 T5）。
 *
 * 输入 = `task_progress.workflow_progress`（**覆盖式**权威快照，协议 §5.2；T1 A3 实测形态）。
 * 输出 = 可渲染的单行聚合（阶段名 + 子代理计数）。纯函数，便于单测。
 *
 * 协议是**加性演进**的（§8）：未知 `type` 一律忽略，不抛。
 */
import type { WorkflowAgentItem, WorkflowTimelineItem } from '../agent/types';

export interface WorkflowProgressSummary {
  /** 阶段标题（按 index 升序） */
  phases: string[];
  /** 当前阶段（优先「有 agent 在跑」的阶段，其次最后一个 agent 所在阶段，再次最后一个 phase） */
  currentPhase?: string;
  agentsTotal: number;
  agentsDone: number;
  agentsRunning: number;
  agentsFailed: number;
  agentsCached: number;
  /** 各 agent 上报 tokens 的合计（journal 源有；stdio 快照通常为 0） */
  tokens: number;
}

/** 聚合时间线快照（忽略未知 type / 空输入） */
export function summarizeWorkflowProgress(
  items: readonly WorkflowTimelineItem[] | undefined,
): WorkflowProgressSummary {
  const summary: WorkflowProgressSummary = {
    phases: [],
    agentsTotal: 0,
    agentsDone: 0,
    agentsRunning: 0,
    agentsFailed: 0,
    agentsCached: 0,
    tokens: 0,
  };
  if (!items || items.length === 0) return summary;

  const phases: Array<{ index: number; title: string }> = [];
  const agents: WorkflowAgentItem[] = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    if (it.type === 'workflow_phase') {
      phases.push({ index: typeof it.index === 'number' ? it.index : phases.length, title: String(it.title ?? '') });
    } else if (it.type === 'workflow_agent') {
      agents.push(it);
    }
    // 未知 type：忽略（协议加性）
  }
  phases.sort((a, b) => a.index - b.index);
  summary.phases = phases.map((p) => p.title);

  summary.agentsTotal = agents.length;
  for (const a of agents) {
    if (a.state === 'done') summary.agentsDone++;
    else if (a.state === 'error') summary.agentsFailed++;
    else if (a.state === 'cached') summary.agentsCached++;
    else summary.agentsRunning++;
    if (typeof a.tokens === 'number' && Number.isFinite(a.tokens)) summary.tokens += a.tokens;
  }

  const running = [...agents].reverse().find((a) => a.state === 'start' && a.phaseTitle);
  const lastAgent = [...agents].reverse().find((a) => a.phaseTitle);
  summary.currentPhase = running?.phaseTitle ?? lastAgent?.phaseTitle ?? phases[phases.length - 1]?.title;
  return summary;
}

/**
 * 单行聚合文本（无进度 → ''）：
 * - 有 agent：`<阶段> <已完成+缓存>/<总数>[ ✗<失败>]`（如 `Verify 12/25 ✗2`）
 * - 仅 phase：`<n> phases`
 */
export function formatWorkflowProgress(summary: WorkflowProgressSummary): string {
  const finished = summary.agentsDone + summary.agentsCached;
  if (summary.agentsTotal > 0) {
    const phase = summary.currentPhase ? `${summary.currentPhase} ` : '';
    const fail = summary.agentsFailed > 0 ? ` ✗${summary.agentsFailed}` : '';
    return `${phase}${finished}/${summary.agentsTotal}${fail}`;
  }
  if (summary.phases.length > 0) {
    return `${summary.phases.length} phase${summary.phases.length === 1 ? '' : 's'}`;
  }
  return '';
}

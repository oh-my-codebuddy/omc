/**
 * workflow-view.ts — workflow 任务的聚焦视图渲染（model-variants-and-workflows P2 修订）。
 *
 * 背景（用户 2026-10-09 真机验收反馈）：运行中在任务面板聚焦 `local_workflow` 任务 →
 * 原 `focusTaskView` 只处理 Agent / Bash，落到兜底提示
 * 「暂无过程记录可查看（子代理事件未配对…）」——但 workflow **本就不是子代理**：
 * 它派出的子代理在 CLI 侧独立会话，事件不与 workflow task 配对；workflow 的过程记录 =
 * `task_progress.workflow_progress` 时间线快照。
 *
 * 故本视图按阶段分组展示代理时间线，与面板行（`⚙ <名> <进度>`）同源数据，
 * 纯函数（无 pi-tui 依赖），便于单测。
 */
import type { WorkflowAgentItem } from '../agent/types';
import type { TaskEntry } from '../app/task-registry';
import { summarizeWorkflowProgress } from '../app/workflow-progress';
import { formatDuration, formatTokens, taskElapsedMs, taskStateWord } from './task-panel';

/** agent 状态符号（`state`：start → done | error | cached） */
const AGENT_MARK: Record<WorkflowAgentItem['state'], string> = {
  start: '●',
  done: '✓',
  error: '✗',
  cached: '⊘',
};

/** `v2:<sha256>` → `v2:<前 8 位>`（内容寻址 key 太长，只留可辨识前缀） */
function shortAgentId(id: string): string {
  const m = /^(v\d+):([0-9a-f]+)$/i.exec(id);
  return m ? `${m[1]}:${m[2]!.slice(0, 8)}…` : id.slice(0, 14);
}

function clip(s: string, max = 60): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * 生成 workflow 聚焦视图行（无 ANSI；调用方按 info 记录挂到 transcript）。
 * - 无进度快照（`workflowProgress` 为空）→ 提示等待上报
 * - 有进度 → 按阶段分组，每阶段一行计数 + 其下各代理一行（状态 / 名 / tokens / 结果预览）
 */
export function buildWorkflowViewLines(entry: TaskEntry, now: number): string[] {
  const name = entry.workflowName ?? entry.description ?? entry.name;
  const summary = summarizeWorkflowProgress(entry.workflowProgress);
  const finished = summary.agentsDone + summary.agentsCached;
  const progressPart = summary.agentsTotal > 0 ? ` · ${finished}/${summary.agentsTotal} 完成` : '';
  const tokens = Math.max(summary.tokens, entry.tokens);
  const lines = [
    `⚙ ${name}  ${taskStateWord(entry.state)} · ${formatDuration(taskElapsedMs(entry, now))}${progressPart} · ↓${formatTokens(tokens)}`,
    '',
  ];
  const timeline = entry.workflowProgress;
  if (!timeline || timeline.length === 0) {
    lines.push('（等待 workflow 上报进度…）');
    return lines;
  }

  const phaseTitles: string[] = [];
  const agents: WorkflowAgentItem[] = [];
  for (const it of timeline) {
    if (!it || typeof it !== 'object') continue;
    if (it.type === 'workflow_phase') phaseTitles.push(it.title);
    else if (it.type === 'workflow_agent') agents.push(it);
    // 未知 type 忽略（协议加性）
  }

  const byPhase = new Map<string, WorkflowAgentItem[]>();
  for (const a of agents) {
    const key = a.phaseTitle ?? '(未分阶段)';
    const bucket = byPhase.get(key);
    if (bucket) bucket.push(a);
    else byPhase.set(key, [a]);
  }
  const orderedPhases = [...new Set([...phaseTitles, ...byPhase.keys()])];

  lines.push(`阶段 ${orderedPhases.length} · 代理 ${agents.length}：`);
  if (orderedPhases.length === 0) {
    lines.push('  （暂无阶段信息）');
    return lines;
  }
  for (const title of orderedPhases) {
    const list = byPhase.get(title) ?? [];
    const finished = list.filter((a) => a.state === 'done' || a.state === 'cached').length;
    const failed = list.filter((a) => a.state === 'error').length;
    const counting = list.length > 0 ? `  ${finished}/${list.length}${failed > 0 ? ` ✗${failed}` : ''}` : '';
    lines.push(`  ● ${title}${counting}`);
    for (const a of list) {
      const label = a.label ?? shortAgentId(a.agentId);
      const tokens = a.tokens ? `  ${formatTokens(a.tokens)}` : '';
      const preview = a.resultPreview ? `  ${clip(a.resultPreview)}` : '';
      lines.push(`    ${AGENT_MARK[a.state]} ${label}${tokens}${preview}`);
    }
  }
  return lines;
}

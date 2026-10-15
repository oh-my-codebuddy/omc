/**
 * stats-report.ts — /stats 跨会话用量数字视图（ux-port-v2 P5.2）。
 *
 * 纯函数：loadUsageDaily 聚合点 → 三段文本行（今日/近 7 日/累计）。
 * 与 /usage（图形 dashboard）/cost（本会话单行）三角分工：/stats = 数字快查。
 * 空数据优雅：三段全零行，累计段不显示日期区间。
 * tokens 展示用 statusline fmtTokens 同款格式；数字为 result 差分估算口径。
 */
import { fmtTokens } from './statusline';
import { localDay, type UsageDayPoint } from './usage-daily';

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

interface Segment {
  requests: number;
  input: number;
  output: number;
  cost: number;
}

function sum(points: UsageDayPoint[]): Segment {
  const s: Segment = { requests: 0, input: 0, output: 0, cost: 0 };
  for (const p of points) {
    s.requests += p.requests;
    s.input += p.input;
    s.output += p.output;
    s.cost += p.cost;
  }
  return s;
}

function fmtSeg(s: Segment): string {
  // 2026-10-02 用户拍板：本后端 total_cost_usd 恒 0（探针实证协议无积分字段），
  // cost 全 0 时隐藏 $ 段去噪；有非 0 时照常显示
  const base = `${s.requests} 轮 | in ${fmtTokens(s.input)} out ${fmtTokens(s.output)}`;
  return s.cost > 0 ? `${base} | $${s.cost.toFixed(4)}` : base;
}

/** 近 7 日窗口起点（含今天共 7 个本地日历日） */
function weekCutoff(now: Date): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
  return localDay(d);
}

export function buildStatsReport(points: UsageDayPoint[], now: Date = new Date()): string[] {
  const today = localDay(now);
  const cutoff = weekCutoff(now);
  const todayPts = points.filter((p) => p.day === today);
  const weekPts = points.filter((p) => p.day >= cutoff);
  const all = sum(points);
  const activeDays = new Set(weekPts.map((p) => p.day)).size;
  const range =
    points.length > 0 ? `${DIM}（${points[0].day} → ${points[points.length - 1].day}）${RESET}` : '';
  return [
    `用量统计（usage-daily 口径，跨会话；tokens 为估算）：`,
    `  今日    ${fmtSeg(sum(todayPts))}`,
    `  近 7 日 ${fmtSeg(sum(weekPts))}（活跃 ${activeDays} 天）`,
    `  累计    ${fmtSeg(all)}${range}`,
  ];
}

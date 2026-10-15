/**
 * usage-daily.ts — 每日用量持久化（ux-port P4.3）。
 * 每轮 result 追加一行 JSONL 到 `~/.omc/usage-daily.jsonl`（`OMC_CONFIG_DIR` 可覆盖）；
 * 读取时按本地日历日聚合，喂 /usage 热力图（pi-tui DailyActivityPoint{day, cost, requests}）。
 * append-only 无读改写；坏行跳过；文件不存在返回 []；写失败静默（记账不挡主流程）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { usageDailyFile } from '../config/paths';

/**
 * pi-tui usage-dashboard DailyActivityPoint（18.4.4 签名：day/cost/requests）。
 * ux-port-v2 P5.2：聚合返回值扩展 input/output 总量（行格式里已有字段，
 * 纯读取侧扩展，不动落盘格式；喂 pi-tui 时多余字段结构化兼容）。
 */
export interface UsageDayPoint {
  day: string;
  cost: number;
  requests: number;
  input: number;
  output: number;
}

interface UsageDailyLine {
  day: string;
  cost: number;
  input: number;
  output: number;
}

/** 本地日历日 YYYY-MM-DD（与 pi-tui buildHeatmapLayout 的 localIso 对齐；P5.2 /stats 分段复用） */
export function localDay(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 追加一轮 result 用量 */
export function appendUsageDaily(
  usage: { inputTokens: number; outputTokens: number; totalCostUsd?: number },
  file: string = usageDailyFile(),
  now: Date = new Date(),
): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const line: UsageDailyLine = {
      day: localDay(now),
      cost: usage.totalCostUsd ?? 0,
      input: usage.inputTokens,
      output: usage.outputTokens,
    };
    appendFileSync(file, `${JSON.stringify(line)}\n`);
  } catch {
    // 记账失败静默
  }
}

/** 读取并按日聚合（day 升序；坏行/非法行跳过） */
export function loadUsageDaily(file: string = usageDailyFile()): UsageDayPoint[] {
  if (!existsSync(file)) return [];
  const byDay = new Map<string, UsageDayPoint>();
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const t = raw.trim();
    if (!t) continue;
    try {
      const l = JSON.parse(t) as Partial<UsageDailyLine>;
      if (typeof l.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(l.day)) continue;
      const p = byDay.get(l.day) ?? { day: l.day, cost: 0, requests: 0, input: 0, output: 0 };
      p.cost += typeof l.cost === 'number' ? l.cost : 0;
      p.input += typeof l.input === 'number' ? l.input : 0;
      p.output += typeof l.output === 'number' ? l.output : 0;
      p.requests += 1;
      byDay.set(l.day, p);
    } catch {
      // 坏行跳过
    }
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

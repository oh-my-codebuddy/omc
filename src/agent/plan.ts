/**
 * plan.ts — Plan 模式的磁盘产物访问（plan-approval P1.2）。
 *
 * 背景（2026-10-08 P1.1 探针实证，`scripts/probe-plan.ts`）：
 * SDK 0.3.267/0.3.274 的 `SessionOptions.onPlanModeEnter/onPlanModeExit` 是**死选项**
 * （只在 types.d.ts 声明，`lib/session.js` 从未读取，实测 0 次触发）。故计划内容只能
 * 走磁盘：模型在 plan 模式下用 `Write` 工具把计划写入
 * `~/.codebuddy/plans/<形容词-名词-科学家-随机>.md`（该 Write **不经 `canUseTool`**，
 * 被 CLI 在 plan 模式下自动放行）。
 *
 * 本模块只做路径判定 + 文件读取，保持纯/可注入（`home` 参数），便于单测。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, sep } from 'node:path';

/** CLI 计划落盘目录（探针实证，非 omc 的 `~/.omc`） */
export function plansDir(home: string = homedir()): string {
  return join(home, '.codebuddy', 'plans');
}

/** 去掉可能的 `~/` 前缀并规整（工具入参实测为绝对路径，防御性兼容相对形态） */
function absish(p: string): string {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return isAbsolute(p) ? p : p;
}

/**
 * 是否 plan 文件：位于 `plansDir()` 下且以 `.md` 结尾。
 * 用于从流的 `tool_use(Write|Edit).input.file_path` 里认领「本次会话的计划文件」。
 */
export function isPlanFilePath(filePath: string, home: string = homedir()): boolean {
  if (typeof filePath !== 'string' || !filePath.endsWith('.md')) return false;
  const dir = plansDir(home);
  const p = normalize(absish(filePath));
  return p === dir || p.startsWith(dir + sep);
}

/** 读计划文件全文；不存在 / 读失败返回 undefined（绝不抛） */
export function readPlanFile(filePath: string, max = 200_000): string | undefined {
  if (typeof filePath !== 'string' || filePath.length === 0) return undefined;
  try {
    const text = readFileSync(absish(filePath), 'utf8');
    return text.length > max ? `${text.slice(0, max)}\n...(+${text.length - max} chars)` : text;
  } catch {
    return undefined;
  }
}

/**
 * `plansDir()` 下**最新**的 `.md`（按 mtime）——兜底来源：当本次会话未从流里捕获到
 * 计划文件路径时（如模型未用 Write 写文件），取目录里最近写入的一份。
 * 目录不存在 / 无 `.md` 时返回 undefined。
 */
export function latestPlanFilePath(home: string = homedir()): string | undefined {
  const dir = plansDir(home);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  let best: string | undefined;
  let bestMtime = -Infinity;
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
      if (st.mtimeMs > bestMtime) {
        bestMtime = st.mtimeMs;
        best = full;
      }
    } catch {
      // 单文件 stat 失败跳过
    }
  }
  return best;
}

/** 计划快照：交给权限桥/UI 的展示模型 */
export interface PlanSnapshot {
  /** 计划文件路径（可能来自会话流捕获，或目录兜底） */
  planFilePath?: string;
  /** 计划全文（读不到则 undefined） */
  content?: string;
}

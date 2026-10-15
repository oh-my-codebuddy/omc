/**
 * line-diff.ts — 行级 diff 纯函数（tool-render P1.2）。
 *
 * 用途：edit / multiedit / write 工具卡渲染彩色 ± 行。
 * 数据来源只有工具入参（old_string / new_string / content）——P1.1 探针实证
 * SDK 侧 tool_result 只有单行成功文本、`UserMessage.tool_use_result` 恒不填充，
 * 所以 diff 只能本地算（docs/plan/tool-render/p1-diff.md D2）。
 *
 * 算法：裁掉公共前后缀 → 中间段 LCS 回溯；同一变更块内把 del 提到 add 之前
 * （统一「先 − 后 +」版式）。中间段过大时退化为全删全增，防 O(n×m) DP 爆内存
 * （edit 的 old/new 片段通常很小，正常不会走到）。
 *
 * 边界口径：`''` = 0 行；文本按 `\n` 切且**丢弃结尾换行产生的空尾元素**
 * （`'a\nb\n'` → `['a','b']`），避免每个文件尾都多出一对假的 ± 空行。
 */

export type DiffLineType = 'add' | 'del' | 'ctx';

export interface DiffLine {
  type: DiffLineType;
  /** 单行文本（不含换行符） */
  text: string;
}

/** LCS DP 的规模上限（a.length × b.length）；超过则退化全删全增 */
const LCS_CELL_LIMIT = 4_000_000;

/** 文本切行：`''` → `[]`；结尾换行的空尾元素丢弃 */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** 同一变更块内重排为「先 del 后 add」（回溯顺序可能是 add 紧跟 del） */
function normalizeHunks(lines: DiffLine[]): DiffLine[] {
  const out: DiffLine[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.type === 'ctx') {
      out.push(line);
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i]!.type !== 'ctx') {
      const l = lines[i]!;
      (l.type === 'del' ? dels : adds).push(l);
      i++;
    }
    out.push(...dels, ...adds);
  }
  return out;
}

/** 中间段（已裁掉公共前后缀）diff */
function diffMiddle(a: string[], b: string[]): DiffLine[] {
  if (a.length === 0) return b.map((text) => ({ type: 'add' as const, text }));
  if (b.length === 0) return a.map((text) => ({ type: 'del' as const, text }));
  if (a.length * b.length > LCS_CELL_LIMIT) {
    return [
      ...a.map((text) => ({ type: 'del' as const, text })),
      ...b.map((text) => ({ type: 'add' as const, text })),
    ];
  }

  const n = a.length;
  const m = b.length;
  // dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] =
        a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'ctx', text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: 'del', text: a[i]! });
      i++;
    } else {
      out.push({ type: 'add', text: b[j]! });
      j++;
    }
  }
  while (i < n) out.push({ type: 'del', text: a[i++]! });
  while (j < m) out.push({ type: 'add', text: b[j++]! });
  return normalizeHunks(out);
}

/**
 * 计算行级 diff：`oldText → newText`。
 * 纯函数，无副作用；同文本返回全 ctx；old 为空（新建文件）返回全 add。
 */
export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;

  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ type: 'ctx', text: a[i]! });
  out.push(...diffMiddle(a.slice(start, endA), b.slice(start, endB)));
  for (let i = endA; i < a.length; i++) out.push({ type: 'ctx', text: a[i]! });
  return out;
}

/** 统计新增 / 删除行数（工具卡摘要用） */
export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.type === 'add') added++;
    else if (l.type === 'del') removed++;
  }
  return { added, removed };
}

/**
 * workflow-data.ts — 动态工作流的数据层（model-variants-and-workflows P2 T2）。
 *
 * 数据源三源（口径复刻 CLI `WorkflowRegistry.loadAll()`，2026-10-09 探针实证）：
 *   1. project：`<cwd>/.codebuddy/workflows/*.js`
 *   2. user：`~/.codebuddy/workflows/*.js`
 *   3. builtin：`<sdk>/cli/builtin/workflows/*.js`（当前仅 deep-research）
 * 合并优先级 **project > user > builtin**（同名先到者占位，`eA.has(name) || set`），
 * 最终按 name `localeCompare` 排序。
 *
 * 关键实证（`scripts/probe-workflow.ts`，详见 p2-workflows.md「T1 探针补充实证」）：
 * - **name 口径不对称**：builtin 用 `meta.name ?? 文件名`；saved 用**文件名去 .js**
 * - meta 解析 = 脚本**前 8192 字节** → `/\bmeta\s*=\s*\{/` → 括号配平（跳注释/字符串）
 *   → `extractStringField('name'|'description'|'whenToUse')`；**绝不执行脚本**
 * - `extractPhases` 对 JSON 引号 key（deep-research 的 `{"title":…}`）解析不出
 *   → 阶段名请取运行时 `workflow_progress[].workflow_phase.title`（本文件的 phases 仅供展示）
 * - **内置目录定位分运行形态**（D1）：开发态可用（`createRequire.resolve` 等三路），
 *   **编译态（`bun --compile`）全部失效** → 降级为 `BUILTIN_WORKFLOW_FALLBACK` 常量
 * - commands 频道**不含** workflow 命令（E1）→ 本模块自读磁盘，不订阅频道
 *
 * 纯数据层（无 UI 依赖），便于单测。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TaskEntry, TaskState } from './task-registry';

/** CLI 读 meta 的头部字节上限（bundle `parseMetaFromHead(el.slice(0,8192))`） */
export const META_HEAD_BYTES = 8192;

export type WorkflowScope = 'project' | 'user' | 'builtin';

export interface WorkflowMeta {
  name?: string;
  description?: string;
  whenToUse?: string;
  phases?: Array<{ title: string; detail?: string }>;
}

export interface WorkflowEntry {
  /** 命令名（不含 `/`） */
  name: string;
  scope: WorkflowScope;
  /** 脚本绝对路径（builtin 降级常量时为空） */
  file: string;
  description?: string;
  whenToUse?: string;
  phases?: Array<{ title: string; detail?: string }>;
}

// ---------------------------------------------------------------- meta 解析
/** 反斜杠转义表（CLI bundle `eB`） */
const ESC: Record<string, string> = { n: '\n', r: '\r', t: '\t', '"': '"', "'": "'", '`': '`', '\\': '\\' };

/** 从 open 位置找配对的 close，跳过行/块注释与字符串（复刻 `findMatching`） */
function findMatching(src: string, start: number, open: string, close: string): number {
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i + 2);
      i = nl < 0 ? src.length : nl + 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(src, i, ch);
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) return i;
    i++;
  }
  return -1;
}

function skipString(src: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    i++;
  }
  return src.length;
}

/** 取 `field: '<str>'` 的字面量值（复刻 `extractStringField`；含转义还原） */
function extractStringField(src: string, field: string): string | undefined {
  const re = new RegExp(`(?:^|[,{\\s])${field}\\s*:\\s*([\`'"])`, 'm');
  const m = re.exec(src);
  if (!m) return undefined;
  const quote = m[1]!;
  let i = m.index + m[0].length;
  let out = '';
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '\\' && i + 1 < src.length) {
      out += ESC[src[i + 1]!] ?? src[i + 1];
      i += 2;
      continue;
    }
    if (quote === '`' && ch === '$' && src[i + 1] === '{') break;
    if (ch === quote) return out;
    out += ch;
    i++;
  }
  return undefined;
}

/** phases 数组解析（复刻 `extractPhases`；注意：JSON 引号 key 解析不出，见文件头注释） */
function extractPhases(src: string): Array<{ title: string; detail?: string }> | undefined {
  const m = /(?:^|[,{\s])phases\s*:\s*\[/m.exec(src);
  if (!m) return undefined;
  const open = src.indexOf('[', m.index);
  const close = findMatching(src, open, '[', ']');
  if (close < 0) return undefined;
  const inner = src.slice(open + 1, close);
  const out: Array<{ title: string; detail?: string }> = [];
  let i = 0;
  while (i < inner.length) {
    while (i < inner.length && inner[i] !== '{') i++;
    if (i >= inner.length) break;
    const end = findMatching(inner, i, '{', '}');
    if (end < 0) break;
    const body = inner.slice(i + 1, end);
    const title = extractStringField(body, 'title');
    if (title !== undefined) {
      const detail = extractStringField(body, 'detail');
      out.push(detail !== undefined ? { title, detail } : { title });
    }
    i = end + 1;
  }
  return out.length > 0 ? out : undefined;
}

/** 解析 meta（head 应为脚本前 8192 字节）——复刻 CLI `parseMetaFromHead` */
export function parseWorkflowMeta(head: string): WorkflowMeta {
  const out: WorkflowMeta = {};
  const at = head.search(/\bmeta\s*=\s*\{/);
  if (at >= 0) {
    const open = head.indexOf('{', at);
    const close = findMatching(head, open, '{', '}');
    if (close >= 0) {
      const body = head.slice(open + 1, close);
      const name = extractStringField(body, 'name');
      const description = extractStringField(body, 'description');
      const whenToUse = extractStringField(body, 'whenToUse');
      if (name !== undefined) out.name = name;
      if (description !== undefined) out.description = description;
      if (whenToUse !== undefined) out.whenToUse = whenToUse;
    }
  }
  const phases = extractPhases(head);
  if (phases) out.phases = phases;
  return out;
}

/** 读脚本文件前 8192 字节并解析 meta（读失败 → {}，绝不抛） */
export function readWorkflowMeta(file: string): WorkflowMeta {
  try {
    return parseWorkflowMeta(readFileSync(file, 'utf8').slice(0, META_HEAD_BYTES));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------- 目录扫描
/**
 * 扫描一个 workflow 目录（只认 `.js`）。
 * `builtin=true` 时 name = `meta.name ?? 文件名`（CLI `toSource`）；否则 name = 文件名去 `.js`（`scanDir`）。
 */
export function scanWorkflowDir(dir: string, scope: WorkflowScope, builtin = false): WorkflowEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.js'))
    .sort()
    .map((n) => {
      const file = join(dir, n);
      const meta = readWorkflowMeta(file);
      const fallback = basename(n, '.js');
      const entry: WorkflowEntry = { name: builtin ? (meta.name ?? fallback) : fallback, scope, file };
      if (meta.description !== undefined) entry.description = meta.description;
      if (meta.whenToUse !== undefined) entry.whenToUse = meta.whenToUse;
      if (meta.phases !== undefined) entry.phases = meta.phases;
      return entry;
    });
}

/**
 * 编译态降级：内置 workflow 常量（当前 CLI 仅 `deep-research`）。
 * 为什么需要：D1 实证 —— `bun --compile` 下 `import.meta.dir`/`import.meta.resolve`/
 * `createRequire` 全部无法定位 SDK 的 `cli/builtin/workflows`。
 */
export const BUILTIN_WORKFLOW_FALLBACK: readonly WorkflowEntry[] = [
  {
    name: 'deep-research',
    scope: 'builtin',
    file: '',
    description: 'Deep research harness — fan-out web searches, verify claims, synthesize a cited report.',
  },
];

/** 内置 workflow 目录的候选推导（开发态可用；失败返回 null） */
export function resolveBuiltinWorkflowDir(): string | null {
  const cands: string[] = [];
  const envPath = process.env.CODEBUDDY_CODE_PATH;
  if (envPath) cands.push(join(dirname(envPath), '..', 'builtin', 'workflows'));
  try {
    const req = createRequire(import.meta.url);
    cands.push(join(dirname(req.resolve('@tencent-ai/agent-sdk/package.json')), 'cli', 'builtin', 'workflows'));
  } catch {
    // 编译态常见：忽略
  }
  try {
    const resolve = (import.meta as unknown as { resolve?: (s: string) => string }).resolve;
    if (resolve) {
      const url = resolve('@tencent-ai/agent-sdk');
      const p = url.startsWith('file://') ? fileURLToPath(url) : url;
      cands.push(join(dirname(p), '..', 'cli', 'builtin', 'workflows'));
    }
  } catch {
    // 编译态常见：忽略
  }
  for (const c of cands) {
    try {
      if (existsSync(c)) return c;
    } catch {
      // ignore
    }
  }
  return null;
}

// ---------------------------------------------------------------- 合并
export interface CollectWorkflowsOptions {
  cwd?: string;
  home?: string;
  /** 注入内置目录（测试用；`null` = 强制走降级常量，`undefined` = 自动探测） */
  builtinDir?: string | null;
}

/**
 * 合并三源（project > user > builtin），按 name 排序。
 * builtin 目录不可得（编译态）→ 用 `BUILTIN_WORKFLOW_FALLBACK`。
 */
export function collectSavedWorkflows(opts: CollectWorkflowsOptions = {}): WorkflowEntry[] {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const merged = new Map<string, WorkflowEntry>();
  for (const e of scanWorkflowDir(join(cwd, '.codebuddy', 'workflows'), 'project')) {
    if (!merged.has(e.name)) merged.set(e.name, e);
  }
  for (const e of scanWorkflowDir(join(home, '.codebuddy', 'workflows'), 'user')) {
    if (!merged.has(e.name)) merged.set(e.name, e);
  }
  const builtinDir = opts.builtinDir !== undefined ? opts.builtinDir : resolveBuiltinWorkflowDir();
  const builtin = builtinDir ? scanWorkflowDir(builtinDir, 'builtin', true) : [...BUILTIN_WORKFLOW_FALLBACK];
  for (const e of builtin) {
    if (!merged.has(e.name)) merged.set(e.name, e);
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 运行中 workflow（从 `TaskRegistry` 快照过滤 `local_workflow`） */
export interface RunningWorkflow {
  id: string;
  /** workflow 名（`task_started.description` == `workflow_name`，T1 A1 实证） */
  name: string;
  state: TaskState;
  startedAt: number;
  reportedMs?: number;
  endedAt?: number;
}

export function collectRunningWorkflows(tasks: readonly TaskEntry[]): RunningWorkflow[] {
  return tasks
    .filter((t) => t.type === 'local_workflow')
    .map((t) => ({
      id: t.id,
      name: t.description || t.name,
      state: t.state,
      startedAt: t.startedAt,
      ...(t.reportedMs !== undefined ? { reportedMs: t.reportedMs } : {}),
      ...(t.endedAt !== undefined ? { endedAt: t.endedAt } : {}),
    }));
}

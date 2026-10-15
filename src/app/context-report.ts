/**
 * context-report.ts — /context 上下文构成报告（ux-port-v2 P1.2）纯函数。
 *
 * 版式照抄 omp `pi-tui/src/status-line/context-usage.ts`（renderContextUsage）：
 * - 网格 20×10=200 格：分类 ⛁ / messages ⛃ / free ⛶(dim) / autocompact ⛝(黄) 垫底；
 *   每分类至少 1 格（ratioCells max(1,…)），超卖先砍最大分类保小分类可见性；
 *   格子间单空格分隔（视觉正方形）
 * - 图例行：`⛁ Label: 3K tokens (0.3%)`——彩色 glyph + bold tokens + dim 百分比；
 *   formatNumber 风格（10K/2.5K/448/1M，整数无小数位）；<0.05% → <0.1%；
 *   Free space 行无 "tokens" 词（omp 原文如此）
 * - 估算数字沿用 omp 的 `~` 前缀惯例（snapcompact 行同款）；
 *   标题 "Estimated usage by category"（omp 原文）
 *
 * 数据口径（SDK 拿不到 CLI 进程内 tokenize，自建近似）：
 * - system prompt + tools = baseline − memory估算 − skills估算（剩余法，不可再拆）
 * - skills = 本地枚举 SKILL.md name+description，chars/2.5（P1.1 探针实证注入）
 * - memory files = 本地读 AGENTS.md（项目）+ CODEBUDDY.md（全局），chars/2.5
 *   （MEMORY.md 不注入——宿主记忆系统，SDK 模式 CLI 不加载，P1.1 实证）
 * - messages = used − baseline（差值，精确）
 * - free space = window − used − autocompact（精确）
 * - autocompact buffer = window × 8%（CLI 原生口径估算；SDK 模式未观察到触发）
 */
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const CYAN_TITLE = '\x1b[36m';
const BLUE = '\x1b[34m';
const GREEN = '\x1b[32m';
const MAGENTA = '\x1b[35m';
const WHITE = '\x1b[37m';
const YELLOW = '\x1b[33m';

/** P4 实证：代码类文本 token 密度 ≈ chars/2.5（误差 ±15%） */
export const CHARS_PER_TOKEN = 2.5;

export interface MemoryFileInput {
  /** 展示名（含来源标注，如 "AGENTS.md（项目）"） */
  name: string;
  /** 文件内容字符数（调用方已读；缺失文件由调用方跳过不进列表） */
  chars: number;
}

export interface SkillInput {
  name: string;
  description: string;
}

export interface ContextReportInput {
  /** 当前 context 占用（statusline.contextUsage().used）；undefined = 首轮前 */
  used?: number;
  /** 上下文窗口；undefined = 未知（无网格无百分比，free/autocompact 省略） */
  window?: number;
  /** system 基线（statusline.contextBaselineValue()）；与 used 同生共死 */
  baseline?: number;
  /** 当前模型 id（标题行） */
  model?: string;
  memoryFiles: MemoryFileInput[];
  skills: SkillInput[];
  /** 同名 skill 被遮蔽（浅层优先丢弃）的条目数（skill-system P3.4；>0 时报告标注） */
  skillsShadowed?: number;
  /** `<available_skills>` 字符预算估算（skill-system P5；estimateSkillBudget 产物，undefined 时不显示） */
  skillBudget?: SkillBudgetEstimate;
  /** 终端列宽（网格版式选择：并排 / 上下） */
  width: number;
  /** /context all：展开 memory 文件明细 */
  expand?: boolean;
}

// ---- omp 版式常量（context-usage.ts:68-76） ----
const GRID_COLS = 20;
const GRID_ROWS = 10;
const GRID_CELLS = GRID_COLS * GRID_ROWS;
const GRID_GUTTER = '   ';
const CELL_FILLED = '⛁';
const CELL_FILLED_MESSAGES = '⛃';
const CELL_FREE = '⛶';
const CELL_BUFFER = '⛝';

/** 并排版式所需最小宽度：网格 39 + gutter 3 + 图例 ≈45 */
const SIDE_BY_SIDE_MIN_WIDTH = 92;

type CategoryId = 'system' | 'skills' | 'memory' | 'messages';

interface Category {
  id: CategoryId;
  label: string;
  tokens: number;
  color: string;
  glyph: string;
  /** true = 估算数字（`~` 前缀）；false = 精确 */
  estimated: boolean;
}

/** omp pi-utils formatNumber 风格：10K / 2.5K / 448 / 1M（整数去 .0） */
export function formatNumber(n: number): string {
  const trim = (v: number): string => {
    const s = v.toFixed(1);
    return s.endsWith('.0') ? s.slice(0, -2) : s;
  };
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trim(n / 1_000)}K`;
  return String(Math.round(n));
}

/** omp percentString（context-usage.ts:562）：<0.05% → <0.1%，否则 1 位小数 */
function percentString(part: number, whole: number): string {
  if (whole <= 0) return '0%';
  const pct = (part / whole) * 100;
  if (pct > 0 && pct < 0.05) return '<0.1%';
  return `${pct.toFixed(1)}%`;
}

/** skills 注入格式 ≈ `- name: description` 每行（对照宿主 available_skills 版式） */
function skillChars(s: SkillInput): number {
  return s.name.length + s.description.length + 4;
}

// ========================================================================
// skill-system P5：`<available_skills>` 字符预算估算（/context skills 段）
//
// 口径**逐字复刻** codebuddy CLI `ToolManagerImpl.truncateSkillsByCharBudget`
// （`node_modules/@tencent-ai/agent-sdk/cli/dist-server/codebuddy.js` 内
// `truncateSkillsByCharBudget(t){…}`，约文件偏移 3720900）+ 类型声明
// `types/node/tools/tool-protocol.d.ts` / `node/tools/tool-manager.d.ts`。
// ⚠ **CLI 升级后必须复检**：预算常量/公式若变动，估算失准（见 AGENTS.md 耦合点表）。
// ========================================================================

/** `<available_skills>` 列表体硬上限（写死，忽略宿主注入 env）。来源：tool-protocol.d.ts:21 `DEFAULT_SKILL_TOOL_CHAR_BUDGET`；bundle `uK = 8e3` */
export const SKILL_BUDGET_CHARS = 8000;
/** 单条描述硬帽。来源：tool-protocol.d.ts:25 `MAX_SKILL_DESC_CHARS`；bundle `ZX = 200` */
export const MAX_SKILL_DESC_CHARS = 200;
/** 均分后低于此值 → 非 protected 降 names-only。来源：tool-protocol.d.ts:26；bundle `eO = 20` */
export const MIN_SKILL_DESC_LENGTH = 20;
/** 全局条数上限（仅 user 级溢出）。来源：tool-protocol.d.ts:64；bundle `W = 200` */
export const MAX_TOTAL_SKILLS = 200;
/** per-skill 描述帽放宽 env。来源：tool-protocol.d.ts:46 `SKILL_DESC_MAX_OVERRIDES_ENV` */
export const SKILL_DESC_MAX_OVERRIDES_ENV = 'CODEBUDDY_SKILL_DESC_MAX_OVERRIDES';
/** 无文件系统路径的内置 skill 分组名。来源：bundle `eN = "(built-in)"` */
export const SKILL_FOLDER_BUILTIN = '(built-in)';

/** `- ` + `: ` 前缀开销（bundle `entryOverhead = name.length + 4`） */
const ENTRY_OVERHEAD = 4;
/** 每条描述行尾换行（bundle `descChars = desc ? desc.length + 1 : 0`） */
const DESC_LINE_CHARS = 1;
/** 目录分组行：`skills under folder: `(21) + 换行(1)（bundle `folderHeaderChars = folder.length + 22`） */
const FOLDER_HEADER_BASE = 22;
/** `Omitted skills: N.` 行开销（bundle 内联常量 `c = 24`，仅 omitted>0 计入） */
const OMITTED_LINE_CHARS = 24;

/** 预算估算输入：SkillEntry 的结构投影（避免 context-report → context-data 反向 import） */
export interface SkillBudgetEntry {
  name: string;
  description: string;
  /** 发现来源（`'builtin'` 视为 protected；见 {@link estimateSkillBudget}） */
  source: string;
  /** SKILL.md 所在目录（CLI `baseDirectory`；folder 取其父级） */
  baseDir: string;
}

/** 估算结果：占用 / 预算 / 档位 / 截断条数 */
export interface SkillBudgetEstimate {
  /** 未截断（仅 per-entry 200 帽 + 折叠空白）时的全量字符估算 */
  usedChars: number;
  budget: number;
  truncationMode: 'none' | 'trimmed' | 'names-only' | 'overflow';
  /** 非 protected 描述被均分截断的条数（仅 trimmed 有意义） */
  trimmedCount: number;
  /** 被省略（user 级溢出 + names-only 后尾部剔除）的条数 */
  omittedCount: number;
}

export interface SkillBudgetOptions {
  /** 预算覆盖（默认 {@link SKILL_BUDGET_CHARS}）；仅测试用 */
  budget?: number;
  /** per-skill 描述帽覆盖表（默认解析 {@link SKILL_DESC_MAX_OVERRIDES_ENV}）；命中即 protected；仅测试用 */
  descCaps?: Map<string, number>;
  /** folder 推导覆盖（默认 `parentPath(baseDir)`）；仅测试用 */
  folderOf?: (e: SkillBudgetEntry) => string;
}

/** CLI `StringUtils.toSingleLine`：`\s+` → 单空格 + trim */
function toSingleLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** CLI `hardCap`：超出 max 时截到 max-1 再加 `…`（结果长度恰为 max） */
function hardCap(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, max);
  return `${text.slice(0, max - 1)}\u2026`;
}

/** CLI `parentPath`：取路径父级，兼容 `/` 与 `\`；无分隔符返回空串 */
function parentPath(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (idx < 0) return '';
  if (idx === 0) return trimmed.slice(0, 1);
  return trimmed.slice(0, idx);
}

/** CLI `skillFolder`：技能目录的父级；空/根/盘符 → `(built-in)` */
function skillFolderOf(e: SkillBudgetEntry, folderOf?: (e: SkillBudgetEntry) => string): string {
  if (folderOf) return folderOf(e);
  const dir = e.baseDir?.trim() ?? '';
  const folder = dir ? parentPath(dir) : '';
  return !folder || folder === '/' || /^[A-Za-z]:?$/.test(folder) ? SKILL_FOLDER_BUILTIN : folder;
}

/** 解析 `CODEBUDDY_SKILL_DESC_MAX_OVERRIDES`（JSON 对象，值为正整数才生效） */
function parseDescMaxOverrides(raw: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (!raw || !raw.trim()) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return out;
  const banned = new Set(['__proto__', 'constructor', 'prototype']);
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    const name = k.trim();
    if (!name || banned.has(name)) continue;
    if (typeof v === 'number' && Number.isInteger(v) && v > 0) out.set(name, v);
  }
  return out;
}

/**
 * 估算 `<available_skills>` 的字符占用与预计截断档位（纯函数，不读磁盘/env 外副作用）。
 *
 * 复刻 CLI 三阶段收敛（条数裁剪 → 全量试算 → 均分/names-only/尾部省略），
 * `usedChars` 按**未截断**的全量保守估算（含 per-entry 帽），供「离预算还差多少」判断。
 */
export function estimateSkillBudget(
  entries: SkillBudgetEntry[],
  opts: SkillBudgetOptions = {},
): SkillBudgetEstimate {
  const budget = opts.budget ?? SKILL_BUDGET_CHARS;
  const descCaps = opts.descCaps ?? parseDescMaxOverrides(process.env[SKILL_DESC_MAX_OVERRIDES_ENV]);
  const isProtected = (e: SkillBudgetEntry): boolean =>
    e.source === 'builtin' || e.source === 'bundled' || descCaps.has(e.name);

  const total = entries.length;
  if (total === 0) {
    return { usedChars: 0, budget, truncationMode: 'none', trimmedCount: 0, omittedCount: 0 };
  }

  const items = entries.map((skill) => ({
    skill,
    isProtected: isProtected(skill),
    isUser: skill.source === 'user',
    cappedDesc: hardCap(toSingleLine(skill.description || ''), descCaps.get(skill.name) ?? MAX_SKILL_DESC_CHARS),
  }));

  const entryOverhead = (it: { skill: SkillBudgetEntry }): number => (it.skill.name?.length ?? 0) + ENTRY_OVERHEAD;
  const descChars = (d: string): number => (d ? d.length + DESC_LINE_CHARS : 0);
  const charsFor = (it: { skill: SkillBudgetEntry }, d: string): number => entryOverhead(it) + descChars(d);
  const folderHeaderChars = (folder: string): number => folder.length + FOLDER_HEADER_BASE;
  const structuralChars = (list: typeof items): number => {
    const folders = new Set(list.map((it) => skillFolderOf(it.skill, opts.folderOf)));
    let sum = 0;
    for (const f of folders) sum += folderHeaderChars(f);
    return sum;
  };
  const totalCharsFor = (list: typeof items, descOf: (it: (typeof items)[number]) => string, omitted: number): number => {
    const body = list.reduce((sum, it) => sum + charsFor(it, descOf(it)), 0);
    return structuralChars(list) + body + (omitted > 0 ? OMITTED_LINE_CHARS : 0);
  };

  // ---- 阶段 1：条数裁剪（仅 user 级受 MAX_TOTAL_SKILLS 限制） ----
  const nonUser = items.filter((it) => !it.isUser);
  const user = items.filter((it) => it.isUser);
  const userCap = Math.max(0, MAX_TOTAL_SKILLS - nonUser.length);
  const admittedUser = user.slice(0, userCap);
  const omittedUserNames = user.slice(userCap).map((it) => it.skill.name);
  const admitted = new Set(admittedUser.map((it) => it.skill.name));
  const rendered = items.filter((it) => !it.isUser || admitted.has(it.skill.name));
  const nonProtected = rendered.filter((it) => !it.isProtected);

  const fullDescOf = (it: (typeof items)[number]): string => it.cappedDesc;

  // ---- 阶段 2：全量试算 ----
  const omittedBase = omittedUserNames.length;
  if (totalCharsFor(rendered, fullDescOf, omittedBase) <= budget || nonProtected.length === 0) {
    return {
      usedChars: totalCharsFor(rendered, fullDescOf, omittedBase),
      budget,
      truncationMode: omittedBase > 0 ? 'overflow' : 'none',
      trimmedCount: 0,
      omittedCount: omittedBase,
    };
  }

  // ---- 阶段 3a：均分 ----
  const protectedChars = rendered
    .filter((it) => it.isProtected)
    .reduce((sum, it) => sum + charsFor(it, it.cappedDesc), 0);
  const restOverhead = nonProtected.reduce((sum, it) => sum + charsFor(it, ''), 0);
  const maxDescLen = Math.floor(
    (budget - structuralChars(rendered) - protectedChars - restOverhead - (omittedBase > 0 ? OMITTED_LINE_CHARS : 0)) /
      nonProtected.length,
  );

  const usedChars = totalCharsFor(rendered, fullDescOf, omittedBase);

  if (maxDescLen < MIN_SKILL_DESC_LENGTH) {
    // ---- 阶段 3b：names-only，必要时尾部省略 ----
    const namesOnlyDescOf = (it: (typeof items)[number]): string => (it.isProtected ? it.cappedDesc : '');
    const floor = structuralChars(rendered) + OMITTED_LINE_CHARS;
    if (budget < floor) {
      return {
        usedChars,
        budget,
        truncationMode: omittedBase > 0 ? 'overflow' : 'names-only',
        trimmedCount: 0,
        omittedCount: omittedBase,
      };
    }
    const keep = rendered.map(() => true);
    const folderCounts = new Map<string, number>();
    for (const it of rendered) {
      const f = skillFolderOf(it.skill, opts.folderOf);
      folderCounts.set(f, (folderCounts.get(f) ?? 0) + 1);
    }
    let structural = 0;
    for (const f of folderCounts.keys()) structural += folderHeaderChars(f);
    let bodyChars = rendered.reduce((sum, it) => sum + charsFor(it, namesOnlyDescOf(it)), 0);
    let dropped = 0;
    const trailingIdx = rendered
      .map((it, i) => ({ isProtected: it.isProtected, i }))
      .filter((x) => !x.isProtected)
      .map((x) => x.i);
    const running = (): number => structural + bodyChars + (omittedBase + dropped > 0 ? OMITTED_LINE_CHARS : 0);
    let cursor = trailingIdx.length - 1;
    while (running() > budget && cursor >= 0) {
      const idx = trailingIdx[cursor--]!;
      keep[idx] = false;
      const it = rendered[idx]!;
      bodyChars -= charsFor(it, namesOnlyDescOf(it));
      const f = skillFolderOf(it.skill, opts.folderOf);
      const left = (folderCounts.get(f) ?? 0) - 1;
      folderCounts.set(f, left);
      if (left === 0) structural -= folderHeaderChars(f);
      dropped += 1;
    }
    const omittedCount = omittedBase + dropped;
    return {
      usedChars,
      budget,
      truncationMode: omittedCount > 0 ? 'overflow' : 'names-only',
      trimmedCount: 0,
      omittedCount,
    };
  }

  // ---- 阶段 3c：均分截断 ----
  const trimmedCount = nonProtected.filter((it) => it.cappedDesc.length > maxDescLen).length;
  return {
    usedChars,
    budget,
    truncationMode: omittedBase > 0 ? 'overflow' : trimmedCount > 0 ? 'trimmed' : 'none',
    trimmedCount,
    omittedCount: omittedBase,
  };
}

interface CellSpec {
  glyph: string;
  color: string;
}

/**
 * 网格格子规划（照抄 omp planCells，context-usage.ts:495）：
 * 分类格 → free → buffer 垫底；每分类至少 1 格；超卖先砍最大分类，再砍 buffer。
 */
function planCells(window: number, categories: Category[], bufferTokens: number): CellSpec[] {
  if (window <= 0) {
    return Array.from({ length: GRID_CELLS }, () => ({ glyph: CELL_FREE, color: DIM }));
  }
  const tokensPerCell = window / GRID_CELLS;
  const ratioCells = (tokens: number): number =>
    tokens <= 0 ? 0 : Math.max(1, Math.round(tokens / tokensPerCell));

  const counts = categories.map((c) => ({ category: c, count: ratioCells(c.tokens) }));
  let bufferCount = ratioCells(bufferTokens);
  let usedCount = counts.reduce((sum, c) => sum + c.count, 0);

  // 防溢出：先按从大到小砍分类（保小分类至少 1 格），仍超再砍 buffer
  const maxUsable = GRID_CELLS - bufferCount;
  if (usedCount > maxUsable) {
    let overflow = usedCount - maxUsable;
    const order = [...counts].sort((a, b) => b.count - a.count);
    for (const entry of order) {
      while (overflow > 0 && entry.count > 1) {
        entry.count -= 1;
        overflow -= 1;
      }
    }
    usedCount = counts.reduce((sum, c) => sum + c.count, 0);
    if (usedCount + bufferCount > GRID_CELLS) {
      bufferCount = Math.max(0, GRID_CELLS - usedCount);
    }
  }

  const cells: CellSpec[] = [];
  for (const { category, count } of counts) {
    for (let i = 0; i < count; i++) cells.push({ glyph: category.glyph, color: category.color });
  }
  const freeCount = Math.max(0, GRID_CELLS - cells.length - bufferCount);
  for (let i = 0; i < freeCount; i++) cells.push({ glyph: CELL_FREE, color: DIM });
  for (let i = 0; i < bufferCount; i++) cells.push({ glyph: CELL_BUFFER, color: YELLOW });
  while (cells.length < GRID_CELLS) cells.push({ glyph: CELL_FREE, color: DIM });
  return cells.slice(0, GRID_CELLS);
}

/**
 * 组装 /context 报告文本行（ANSI 着色，ctx.print 定稿入 scrollback）。
 * 退化：
 * - used undefined（首轮前）→ 单行提示
 * - window undefined → 无网格无百分比，free/autocompact 行省略
 */
export function buildContextReport(input: ContextReportInput): string[] {
  if (input.used === undefined) {
    return [`${DIM}[context] 尚无上下文数据——先进行一轮对话再试${RESET}`];
  }
  const used = input.used;
  const window = input.window ?? 0;

  const memoryTokens = Math.round(
    input.memoryFiles.reduce((acc, f) => acc + f.chars / CHARS_PER_TOKEN, 0),
  );
  const skillsTokens = Math.round(
    input.skills.reduce((acc, s) => acc + skillChars(s) / CHARS_PER_TOKEN, 0),
  );

  // 分类（omp 五分类的可得子集：system prompt+tools 剩余法合一，system context 拆不出）
  const categories: Category[] = [];
  if (input.baseline !== undefined) {
    const systemTools = Math.max(0, Math.round(input.baseline) - memoryTokens - skillsTokens);
    categories.push({
      id: 'system',
      label: 'System prompt + tools',
      tokens: systemTools,
      color: BLUE,
      glyph: CELL_FILLED,
      estimated: true,
    });
  }
  categories.push({
    id: 'skills',
    label: 'Skills',
    tokens: skillsTokens,
    color: GREEN,
    glyph: CELL_FILLED,
    estimated: true,
  });
  categories.push({
    id: 'memory',
    label: 'Memory files',
    tokens: memoryTokens,
    color: MAGENTA,
    glyph: CELL_FILLED,
    estimated: true,
  });
  if (input.baseline !== undefined) {
    categories.push({
      id: 'messages',
      label: 'Messages',
      tokens: Math.max(0, Math.round(used - input.baseline)),
      color: WHITE,
      glyph: CELL_FILLED_MESSAGES,
      estimated: false,
    });
  }

  const bufferTokens = window > 0 ? Math.round(window * 0.08) : 0;
  const freeTokens = window > 0 ? Math.max(0, window - used - bufferTokens) : 0;

  // ---- 图例行（照 omp buildLegendLines） ----
  const legend: string[] = [];
  const windowLabel = formatNumber(window).toLowerCase();
  const modelLabel = input.model ?? 'unknown model';
  legend.push(`${BOLD}${modelLabel}${RESET}${DIM} (${windowLabel} context)${RESET}`);
  legend.push(
    `${BOLD}${formatNumber(used)}${RESET}${DIM}/${windowLabel} tokens${RESET}` +
      (window > 0 ? `${DIM} (${percentString(used, window)})${RESET}` : ''),
  );
  legend.push('');
  legend.push(`${DIM}Estimated usage by category${RESET}`);
  for (const c of categories) {
    const dot = `${c.color}${c.glyph}${RESET}`;
    const est = c.estimated ? '~' : '';
    const pct =
      window > 0
        ? `${DIM} tokens (${percentString(c.tokens, window)})${RESET}`
        : `${DIM} tokens${RESET}`;
    legend.push(`${dot} ${c.label}: ${BOLD}${est}${formatNumber(c.tokens)}${RESET}${pct}`);
  }
  if (window > 0) {
    legend.push(
      `${DIM}${CELL_FREE}${RESET} Free space: ${BOLD}${formatNumber(freeTokens)}${RESET}` +
        `${DIM} (${percentString(freeTokens, window)})${RESET}`,
    );
    legend.push(
      `${YELLOW}${CELL_BUFFER}${RESET} Autocompact buffer: ${BOLD}~${formatNumber(bufferTokens)}${RESET}` +
        `${DIM} tokens (${percentString(bufferTokens, window)})${RESET}`,
    );
  }

  // ---- 网格 + 图例拼接（照 omp renderContextUsage） ----
  const lines: string[] = [`${CYAN_TITLE}${BOLD}Context Usage${RESET}`];
  if (window > 0) {
    const cells = planCells(window, categories, bufferTokens);
    const gridLines: string[] = [];
    for (let r = 0; r < GRID_ROWS; r++) {
      const row = cells.slice(r * GRID_COLS, (r + 1) * GRID_COLS);
      gridLines.push(row.map((c) => `${c.color}${c.glyph}${RESET}`).join(' '));
    }
    const gridWidth = GRID_COLS * 2 - 1;
    if (input.width >= SIDE_BY_SIDE_MIN_WIDTH) {
      const total = Math.max(GRID_ROWS, legend.length);
      for (let r = 0; r < total; r++) {
        const g = gridLines[r] ?? ' '.repeat(gridWidth);
        const l = legend[r] ?? '';
        lines.push(l ? `${g}${GRID_GUTTER}${l}` : g);
      }
    } else {
      lines.push(...gridLines, ...legend);
    }
  } else {
    lines.push(...legend);
  }

  // ---- skill 同名遮蔽提示（skill-system P3.4：只读统计，不做交互选择） ----
  if (input.skillsShadowed && input.skillsShadowed > 0) {
    lines.push(
      `${DIM}${input.skillsShadowed} skill(s) shadowed by same-name at shallower depth${RESET}`,
    );
  }

  // ---- skill 清单预算可见性（skill-system P5：CLI 同口径估算占用与预计档位） ----
  if (input.skillBudget) {
    const b = input.skillBudget;
    const pct = b.budget > 0 ? Math.round((b.usedChars / b.budget) * 100) : 0;
    const detail: string[] = [];
    if (b.trimmedCount > 0) detail.push(`约 ${b.trimmedCount} 条描述被截`);
    if (b.omittedCount > 0) detail.push(`${b.omittedCount} 条被省略`);
    const tail = detail.length > 0 ? `（${detail.join('，')}）` : '';
    lines.push(
      `${DIM}Skills budget: 估算占用 ${b.usedChars.toLocaleString()} / ${b.budget.toLocaleString()} 字符` +
        `（${pct}%）；预计档位 ${b.truncationMode}${tail}${RESET}`,
    );
    if (b.usedChars > b.budget) {
      lines.push(
        `${YELLOW}建议：精简 description / 用 CODEBUDDY_SKILL_DESC_MAX_OVERRIDES 给重点 skill 放宽 / 收敛 skill 数量${RESET}`,
      );
    }
  }

  // ---- /context all：memory 明细（omp 无此区，我们的增量） ----
  if (input.expand && input.memoryFiles.length > 0) {
    lines.push(`${DIM}Memory files:${RESET}`);
    const nameWidth = Math.max(...input.memoryFiles.map((f) => f.name.length));
    for (const f of input.memoryFiles) {
      const tok = formatNumber(Math.round(f.chars / CHARS_PER_TOKEN));
      lines.push(
        `  ${f.name.padEnd(nameWidth)}  ${f.chars.toLocaleString()} chars ≈ ~${tok} tokens`,
      );
    }
  }
  if (!input.expand && input.memoryFiles.length > 0) {
    lines.push(`${DIM}/context all 展开 memory 文件明细${RESET}`);
  }

  return lines;
}

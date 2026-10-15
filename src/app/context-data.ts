/**
 * context-data.ts — /context 报告的数据组装（ux-port-v2 P1.3）。
 *
 * 本地枚举报告所需的两个外部数据源：
 * - memory files：**CLI 实测生效口径**（`scripts/probe-memory-files.ts`，2026-10-09）——
 *   全局 `~/.codebuddy/CODEBUDDY.md`；项目 `CODEBUDDY.md` / `CODEBUDDY.local.md`；
 *   项目 `AGENTS.md` **仅在项目无 CODEBUDDY 系列时回落生效**（见 `collectMemoryFileCandidates`）。
 *   缺失文件跳过（不进列表），读取失败同样跳过。MEMORY.md 是宿主记忆系统、
 *   SDK 模式 CLI 不加载，不枚举。
 * - skills：SKILL.md frontmatter 的 name + description + 可见性语义（P1.1 实证注入格式；
 *   skill-system P2 起用 `Bun.YAML.parse` 解析，不再自写正则；非法 YAML 回落旧正则兜底）。
 *   来源目录：项目 .codebuddy/skills/、用户级 ~/.codebuddy/skills/、
 *   插件 ~/.codebuddy/plugins/cache/（<marketplace>/<plugin>/<version>/ 下：<version>/SKILL.md 直连
 *   与 <version>/skills/<name>/SKILL.md 两种布局）、
 *   .agent/.agents（项目 walk-up .agent/skills 与 .agents/skills + 用户级 ~/.agent[s]/skills/，
 *   对齐 omp agents provider）、以及宿主注入的 builtin 目录（CODEBUDDY_BUILTIN_SKILLS_DIR）。
 *   P3 起每个扫描根**递归到 5 层**（对齐 CLI MAX_SCAN_DEPTH），嵌套 skill 名按相对目录用 `/` 连接。
 *   与 CLI 实际加载清单仍有出入——CLI 的 built-in（如 `loop`）是 bundle 内嵌、无文件系统路径
 *   （P3.1 探针实证），omc 扫不到；估算口径容差内。
 *
 * 全部 best-effort：任何目录/文件不可读都返回空，不抛错。
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { Glob } from 'bun';
import type { MemoryFileInput, SkillInput } from './context-report';

/** skill 发现来源（skill-system P2/P3：/context 归类与同名消歧依据） */
export type SkillSource = 'project' | 'user' | 'plugin' | 'agents' | 'builtin';

/** frontmatter 解析结果：name/description + 可见性语义（对齐 CLI node/utils/skill-frontmatter.d.ts） */
export interface SkillFrontmatter {
  name: string;
  description: string;
  /** frontmatter `user-invocable` 显式值；undefined = 默认可见 */
  userInvocable?: boolean;
  /** `disable-model-invocation` 显式值，或 `disable: true` 派生；undefined = 不禁止 */
  disableModelInvocation?: boolean;
  /** frontmatter `argument-hint`（`/` 补全提示） */
  argumentHint?: string;
}

/** 完整 skill 条目：name/description + SKILL.md 绝对路径与其所在目录（skill-invoke P1）+ 可见性（P2） */
export interface SkillEntry {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  /** 用户可否经 `/` 补全或 `/skill:<name>` 调用（frontmatter `user-invocable`，默认 true） */
  userInvocable: boolean;
  /** 是否禁止模型侧清单注入（frontmatter 派生；omc 只记录不拦截——清单由 CLI 生成） */
  disableModelInvocation: boolean;
  /** frontmatter `argument-hint` */
  argumentHint?: string;
  /** 发现来源（P3 发现面/同名消歧用） */
  source: SkillSource;
}

/**
 * memory 文件候选（含**未生效**项，供 `/memory` 说明「为什么没进上下文」）。
 *
 * 生效口径沿用 CLI **实测**结论（`scripts/probe-memory-files.ts`，2026-10-09 三场景；
 * CLI bundle（文件名见 AGENTS.md「内部标识对照」）hot-reload `memoryFileFilter` 只是文件监视名单，不等于加载名单）：
 *   - 全局：仅 `~/.codebuddy/CODEBUDDY.md`（全局 `AGENTS.md` / `CODEBUDDY.local.md` /
 *     `*.mdc` 实测均**不进**上下文）
 *   - 项目：`CODEBUDDY.md` 与 `CODEBUDDY.local.md` 存在即注入（两者并存都进）
 *   - 项目 `AGENTS.md`：**仅当项目没有 CODEBUDDY 系列时回落生效**；有 CODEBUDDY.md
 *     时被遮蔽（与 `/init` 模板「有 AGENTS.md 则不建 CODEBUDDY.md」互为表里 ——
 *     一旦建了 CODEBUDDY.md，AGENTS.md 就静默失活，故此处必须显式标出）
 *   - `*.mdc` 变体**不列**（实测不加载，列出来只会误导）
 */
export interface MemoryFileCandidate {
  /** 展示名（含层标注） */
  label: string;
  /** 绝对路径 */
  path: string;
  layer: 'project' | 'global';
  /** 该文件**若存在**是否进上下文 */
  active: boolean;
  /** `active=false` 的原因（展示用，如遮蔽它的文件名） */
  shadowedBy?: string;
  /**
   * 与另一候选指向**同一文件**（symlink 常见：`CODEBUDDY.md -> AGENTS.md`）。
   * 此时不报「被遮蔽」（内容其实进了上下文），展示为「= 同一文件」即可，也不重复计预算。
   */
  sameAs?: string;
}

type ExistsFn = (p: string) => boolean;

/** 两路径是否同一实体（realpath 比较；任一不可达 → false） */
function isSameEntity(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

export function collectMemoryFileCandidates(
  cwd: string,
  exists: ExistsFn = existsSync,
): MemoryFileCandidate[] {
  const projectCb = join(cwd, 'CODEBUDDY.md');
  const projectCbLocal = join(cwd, 'CODEBUDDY.local.md');
  const projectAgents = join(cwd, 'AGENTS.md');
  const hasProjectCodebuddy = exists(projectCb) || exists(projectCbLocal);
  // symlink 场景（`CODEBUDDY.md -> AGENTS.md`）：同一份内容，不算遮蔽
  const agentsIsSameFile = exists(projectAgents) && exists(projectCb) && isSameEntity(projectAgents, projectCb);
  const agentsActive = !hasProjectCodebuddy || agentsIsSameFile;
  return [
    { label: 'CODEBUDDY.md（项目）', path: projectCb, layer: 'project', active: true },
    { label: 'CODEBUDDY.local.md（项目）', path: projectCbLocal, layer: 'project', active: true },
    {
      label: 'AGENTS.md（项目）',
      path: projectAgents,
      layer: 'project',
      active: agentsActive,
      shadowedBy: agentsIsSameFile || !hasProjectCodebuddy ? undefined : 'CODEBUDDY.md',
      sameAs: agentsIsSameFile ? 'CODEBUDDY.md' : undefined,
    },
    {
      label: 'CODEBUDDY.md（全局）',
      path: join(homedir(), '.codebuddy', 'CODEBUDDY.md'),
      layer: 'global',
      active: true,
    },
  ];
}

/** 读 memory 文件字符数（**只统计生效候选**）；缺失/不可读跳过 */
export function collectMemoryFiles(cwd: string): MemoryFileInput[] {
  const out: MemoryFileInput[] = [];
  for (const c of collectMemoryFileCandidates(cwd)) {
    // 被遮蔽的候选不计入上下文预算；同实体（symlink）也只算一次
    if (!c.active || c.sameAs) continue;
    try {
      out.push({ name: c.label, chars: readFileSync(c.path, 'utf8').length });
    } catch {
      // 缺失/不可读：跳过
    }
  }
  return out;
}

/**
 * 剥 YAML 标量外层成对的单/双引号（`name: "foo"` → foo；未闭合则原样）。
 * 仅供 legacy 兜底路径使用（YAML 路径由 Bun.YAML.parse 剥引号）。
 */
function stripYamlQuotes(v: string): string {
  return v.replace(/^(['"])(.*)\1$/, '$2');
}

/** 抽 `---` 包裹的 frontmatter 段（无则 undefined） */
function extractFrontmatter(content: string): string | undefined {
  return /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1];
}

/** 标量转字符串（YAML 可能给出 number/bool；null/undefined → ''） */
function scalarString(v: unknown): string {
  if (v === undefined || v === null) return '';
  return typeof v === 'string' ? v : String(v);
}

/**
 * 旧正则实现 —— 只在 `Bun.YAML.parse` 抛错时兜底（换解析器前逐字保留）。
 * 保留原因：真实 skill 的 frontmatter 偶有非法 YAML（如未闭合引号），
 * 不应因此丢掉整个 skill；兜底行为与换解析器前完全一致。
 * 返回 `name` 可能为空串（P3：供发现层派生名，仍保留 description）。
 */
function parseSkillFieldsLegacy(fm: string): SkillFrontmatter {
  const rawName = /^name:\s*(.+)$/m.exec(fm)?.[1]?.trim();
  const name = rawName ? stripYamlQuotes(rawName) : '';
  const block = /^description:\s*[|>]\s*\n((?:^[ \t]+.*(?:\n|$))*)/m.exec(fm);
  if (block) {
    return { name, description: block[1]!.replace(/^[ \t]+/gm, '').trim() };
  }
  const rawInline = /^description:\s*(.+)$/m.exec(fm)?.[1]?.trim();
  const inline = rawInline ? stripYamlQuotes(rawInline) : undefined;
  return { name, description: inline ?? '' };
}

/**
 * 解析 SKILL.md frontmatter 全字段（真 YAML，Bun.YAML.parse）。语义对齐 CLI
 * `node/utils/skill-frontmatter.d.ts`：
 * - `disable: true` **仅**派生 `disableModelInvocation`，不影响 `/` 菜单可见性
 *   （不派生 `userInvocable`，与 Claude Code 有意不同）
 * - 显式 `user-invocable` / `disable-model-invocation` 优先于 `disable` 派生
 * - 非法 YAML → legacy 正则兜底（不抛、不丢 skill）
 * 返回 `name` 可能为空串（交由调用方派生）；无 frontmatter → null。
 */
function parseSkillFields(content: string): SkillFrontmatter | null {
  const fm = extractFrontmatter(content);
  if (!fm) return null;
  let data: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = Bun.YAML.parse(fm);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    return parseSkillFieldsLegacy(fm);
  }
  if (!data) return parseSkillFieldsLegacy(fm); // 非映射（空/标量/数组）→ 兜底
  const name = scalarString(data.name).trim();
  const explicitUser = typeof data['user-invocable'] === 'boolean' ? data['user-invocable'] : undefined;
  const explicitDmi =
    typeof data['disable-model-invocation'] === 'boolean' ? data['disable-model-invocation'] : undefined;
  const disableModelInvocation = explicitDmi ?? (data.disable === true ? true : undefined);
  const argumentHint = scalarString(data['argument-hint']).trim();
  const out: SkillFrontmatter = { name, description: scalarString(data.description).trim() };
  if (explicitUser !== undefined) out.userInvocable = explicitUser;
  if (disableModelInvocation !== undefined) out.disableModelInvocation = disableModelInvocation;
  if (argumentHint) out.argumentHint = argumentHint;
  return out;
}

/**
 * 解析 SKILL.md frontmatter（公开契约）：无 frontmatter 或 **无 name** → null
 * （发现层据此派生路径名）。
 */
export function parseSkillFrontmatter(content: string): SkillFrontmatter | null {
  const fields = parseSkillFields(content);
  return fields && fields.name ? fields : null;
}

/** 从 start 向上探测 git 仓库根（含 .git 目录/文件即命中）；到文件系统根未命中返回 undefined */
function findRepoRoot(start: string): string | undefined {
  let cur = start;
  while (true) {
    if (existsSync(join(cur, '.git'))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
}

/**
 * .agent/.agents 项目级 skills 目录（对齐 omp agents provider）：
 * 从 cwd 逐级向上到 repoRoot（无 git 时回退 home）为止，每级收集
 * .agent/skills 与 .agents/skills；跳过 home 自身（它已作为用户级来源）。
 */
function projectAgentSkillDirs(cwd: string): string[] {
  const home = homedir();
  const stop = findRepoRoot(cwd) ?? home;
  const dirs: string[] = [];
  let cur = cwd;
  while (true) {
    if (cur !== home) {
      dirs.push(join(cur, '.agent', 'skills'), join(cur, '.agents', 'skills'));
    }
    if (cur === stop) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return dirs;
}

/** 嵌套扫描最大深度（相对扫描根的 skill 目录层数）；对齐 CLI skill-product-provider `MAX_SCAN_DEPTH=5` */
export const SKILL_MAX_DEPTH = 5;

/** 单次全量扫描的文件数上限（防巨目录/深树炸扫描；真实环境远低于此） */
const SKILL_SCAN_FILE_CAP = 5000;

/**
 * 单个扫描根：其**子目录**被视为独立 skill（`<skill>/SKILL.md`），递归到
 * `maxDepth` 层（默认 {@link SKILL_MAX_DEPTH}）。`includeRoot: true` 时额外收根目录
 * 自身的 `SKILL.md`（插件 cache 的 `<version>/SKILL.md` 直连布局，常配 `maxDepth: 0`）。
 */
interface SkillScanRoot {
  root: string;
  source: SkillSource;
  includeRoot?: boolean;
  maxDepth?: number;
}

/**
 * 插件 cache 每个 `<版本>` 目录（`cache/<marketplace>/<plugin>/<version>`）拆成扫描根：
 * - 有 `<version>/SKILL.md` → 直连布局（仅收根自身，`maxDepth:0`）；
 * - 有 `<version>/skills/` → `skills/<name>/SKILL.md` 布局（根取 `skills/`，名字更干净）；
 * - 都没有 → 兜底扫整段版本目录。
 *
 * 导出（仅测试用）：home 可注入，便于用临时目录覆盖软链场景（生产调用恒传 homedir()）。
 */
export function pluginScanRoots(home: string): SkillScanRoot[] {
  const base = join(home, '.codebuddy', 'plugins', 'cache');
  const roots: SkillScanRoot[] = [];
  let versions: string[];
  try {
    // followSymlinks：Bun Glob 默认不跟随软链目录（同 scanSkillFiles）。cache 的
    // `<marketplace>` / `<plugin>` / `<version>` 任一层若为 symlink 都会静默漏掉整包插件。
    versions = [...new Glob(join(base, '*/*/*')).scanSync({ onlyFiles: false, followSymlinks: true })];
  } catch {
    return roots; // 无 cache 目录
  }
  for (const v of versions) {
    try {
      if (!statSync(v).isDirectory()) continue;
    } catch {
      continue;
    }
    const direct = join(v, 'SKILL.md');
    const skillsDir = join(v, 'skills');
    let matched = false;
    if (existsSync(direct)) {
      roots.push({ root: v, source: 'plugin', includeRoot: true, maxDepth: 0 });
      matched = true;
    }
    if (existsSync(skillsDir)) {
      roots.push({ root: skillsDir, source: 'plugin' });
      matched = true;
    }
    if (!matched) roots.push({ root: v, source: 'plugin' });
  }
  return roots;
}

/** skills 扫描根（顺序即跨源优先级，对齐 CLI 多 scanRoot 语义）与来源标注 */
function skillScanRoots(cwd: string): SkillScanRoot[] {
  const home = homedir();
  const roots: SkillScanRoot[] = [
    { root: join(cwd, '.codebuddy', 'skills'), source: 'project' },
    { root: join(home, '.codebuddy', 'skills'), source: 'user' },
  ];
  // .agent/.agents（对齐 omp agents provider，priority 70）：项目 walk-up + 用户级
  for (const dir of projectAgentSkillDirs(cwd)) roots.push({ root: dir, source: 'agents' });
  roots.push(
    { root: join(home, '.agent', 'skills'), source: 'agents' },
    { root: join(home, '.agents', 'skills'), source: 'agents' },
    ...pluginScanRoots(home),
  );
  // builtin：CLI 官方磁盘扩展点（PathUtils.getBuiltinSkillsDir()）；未设置 = 无（bundle 内嵌 skill 扫不到）
  const builtinDir = process.env.CODEBUDDY_BUILTIN_SKILLS_DIR;
  if (builtinDir) roots.push({ root: builtinDir, source: 'builtin' });
  return roots;
}

/** 收集单个扫描根下的 SKILL.md 绝对路径（逐层通配模式 + 可选根自身） */
function scanSkillFiles(spec: SkillScanRoot): string[] {
  const files: string[] = [];
  // 根自身的 SKILL.md：Bun Glob 对纯字面路径（无通配符）返回空，故用 existsSync 直取
  if (spec.includeRoot) {
    const direct = join(spec.root, 'SKILL.md');
    if (existsSync(direct)) files.push(direct);
  }
  const maxDepth = spec.maxDepth ?? SKILL_MAX_DEPTH;
  for (let d = 1; d <= maxDepth; d++) {
    const pattern = join(spec.root, ...Array<string>(d).fill('*'), 'SKILL.md');
    try {
      // followSymlinks：Bun Glob 默认**不跟随软链目录**（Bun 1.4.1 实测），
      // 而 `.codebuddy/skills/<name>` 常以 symlink 指向真实 skill（如项目内 skills/）。
      // 不开则这类 skill 静默消失（/skill: 搜不到、/context 漏计）。
      // pattern 深度已固定（≤maxDepth），软链环不会导致无限递归。
      for (const file of new Glob(pattern).scanSync({ onlyFiles: true, followSymlinks: true })) {
        files.push(file);
        if (files.length >= SKILL_SCAN_FILE_CAP) return files;
      }
    } catch {
      // 目录不存在：跳过
    }
  }
  return files;
}

/**
 * 嵌套 skill 名派生（frontmatter 无 `name` 时的兜底，对齐 CLI `deriveSkillNameFromPath`）：
 * 相对扫描根的目录路径段用 `/` 连接（omc 约定；CLI 用 `:`）。
 */
function deriveNestedName(root: string, filePath: string): string {
  const dir = dirname(filePath);
  const segments = relative(root, dir).split(sep).filter(Boolean);
  return segments.length > 0 ? segments.join('/') : basename(dir);
}

/** 收集阶段条目（含排序用 depth，不进 SkillEntry） */
interface SkillCandidate extends SkillEntry {
  depth: number;
}

/** 全量收集结果：`entries` 为去重后条目，`shadowed` 为同名被遮蔽（丢弃）数 */
export interface SkillEntriesResult {
  entries: SkillEntry[];
  shadowed: number;
}

/**
 * 枚举本地 skills 完整条目；目录不存在/解析失败跳过。
 *
 * 去重语义（复刻 CLI `sortSkillsByDepth` + 多 scanRoot first-wins）：
 * - **每个扫描根内**先按「深度浅优先 / 同深按 filePath 字典序」排序——同名时根级/就近者胜；
 * - **跨根**按 `skillScanRoots` 顺序 first-wins（project → user → agents → plugin → builtin）；
 * - 同名被丢弃的条目计入 `shadowed`（只读统计，不做交互选择）。
 * 可见性字段按 CLI 默认填充（userInvocable 默认 true、disableModelInvocation 默认 false）。
 */
export function collectSkillEntriesDetailed(cwd: string): SkillEntriesResult {
  const candidates: SkillCandidate[] = [];
  for (const spec of skillScanRoots(cwd)) {
    const perRoot: SkillCandidate[] = [];
    for (const file of scanSkillFiles(spec)) {
      try {
        const fields = parseSkillFields(readFileSync(file, 'utf8'));
        // frontmatter name 优先；缺失时按相对路径派生（对齐 CLI asNonEmptyString(name) || derive）
        const name = fields?.name || deriveNestedName(spec.root, file);
        if (!name) continue;
        perRoot.push({
          name,
          description: fields?.description ?? '',
          filePath: file,
          baseDir: dirname(file),
          userInvocable: fields?.userInvocable ?? true,
          disableModelInvocation: fields?.disableModelInvocation ?? false,
          argumentHint: fields?.argumentHint,
          source: spec.source,
          depth: relative(spec.root, dirname(file)).split(sep).filter(Boolean).length,
        });
      } catch {
        // 单文件失败跳过
      }
    }
    perRoot.sort((a, b) => a.depth - b.depth || a.filePath.localeCompare(b.filePath));
    candidates.push(...perRoot);
  }

  const seen = new Set<string>();
  const entries: SkillEntry[] = [];
  let shadowed = 0;
  for (const c of candidates) {
    if (seen.has(c.name)) {
      shadowed++;
      continue;
    }
    seen.add(c.name);
    entries.push({
      name: c.name,
      description: c.description,
      filePath: c.filePath,
      baseDir: c.baseDir,
      userInvocable: c.userInvocable,
      disableModelInvocation: c.disableModelInvocation,
      argumentHint: c.argumentHint,
      source: c.source,
    });
  }
  return { entries, shadowed };
}

/** 枚举本地 skills 完整条目（`collectSkillEntriesDetailed` 的 entries 投影） */
export function collectSkillEntries(cwd: string): SkillEntry[] {
  return collectSkillEntriesDetailed(cwd).entries;
}

/** 枚举本地 skills（name+description）；collectSkillEntries 的窄投影，保持 /context 契约 */
export function collectSkills(cwd: string): SkillInput[] {
  return collectSkillEntries(cwd).map((e) => ({ name: e.name, description: e.description }));
}

/** /context 用：skills 窄投影 + 同名遮蔽统计 + 完整条目（skill-system P5 预算估算用） */
export function collectSkillsWithStats(cwd: string): {
  skills: SkillInput[];
  shadowed: number;
  entries: SkillEntry[];
} {
  const { entries, shadowed } = collectSkillEntriesDetailed(cwd);
  return { skills: entries.map((e) => ({ name: e.name, description: e.description })), shadowed, entries };
}

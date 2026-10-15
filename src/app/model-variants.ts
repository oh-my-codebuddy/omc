/**
 * model-variants.ts — 模型「场景变体」（`/model:lite` / `/model:reasoning`）数据层。
 *
 * 背景（model-variants-and-workflows P1）：
 * CLI 的 `/model:lite` 语义是「设置 / 列出 **lite 场景**用的模型」（Explore 等轻量子任务），
 * 与切主模型的 `/model` 是**两套**；存储键 = settings 的 `variantModels`，值 = 模型 id
 * 或 `__inherit_default__`（继承主模型）。
 *
 * ⚠️ **本阶段最重要的实证（T1 探针，见 docs/plan/model-variants-and-workflows/p1-model-variants.md V10/V11）**：
 * omc 会话恒用 `settingSources: []`（`src/agent/session.ts`，skill-system 阶段定为不得放开的隔离）
 * → CLI 侧把 settings scope 算成 `none` → **`variantModels` 对 omc 会话完全不加载**。
 * 唯一能穿透该隔离的覆盖层是**解析链第 1 优先的环境变量**：
 *   `CODEBUDDY_SMALL_FAST_MODEL` ↔ lite、`CODEBUDDY_BIG_SLOW_MODEL` ↔ reasoning（CLI 官方文档亦如此声明）。
 * 故本模块的落地方案（用户 2026-10-09 拍板 D1-b）：
 *   `~/.codebuddy/settings.json#variantModels` = **唯一真源**（与 CLI 双向兼容读写）；
 *   omc 会话 spawn 时把该映射翻译成子进程 env（`variantEnvOverrides`）→ 变体在 omc 内真生效，
 *   且不需要放开 settings 隔离。代价 = 改值需重启 omc 会话（env 在 spawn 时固定）。
 *
 * CLI 侧对照实现（`dist-server/codebuddy.js` / `dist/codebuddy-headless.js`）：
 * - `setVariantModel(settings, variant, modelId, scope)`：`scope==='global' → USER`，否则 PROJECT；
 *   **`modelId === '__inherit_default__'` 时 `delete` 键**（不是写入该字符串）；6 个命令一律写 `global`。
 * - `resolveEffectiveVariantModel(variant, session)` 优先级：
 *   ① env（见上）→ ② settings `variantModels[variant]` → ③ 主模型 `relatedModels[variant]` → ④ 继承主模型；
 *   `related` 值等于主模型 id 时记为 `inherit`。
 * - 只有 `lite` / `reasoning` 走这条解析链（`getVariantModelFromSettings` 内 `if (variant==='lite'||'reasoning')`）；
 *   `vision` / `longContext` / `subagent` 仅类型预留，4 个多模态命令读的是另一张 product 模型表
 *   → omc 不做（P1 范围决定）。
 * - settings 读取在 CLI 进程内另有 60s 缓存（`CACHE_TTL=6e4`），只影响真 CLI 会话。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 变体枚举：**只含 CLI 有真实解析链的两个**（见文件头，vision/longContext/subagent 不做） */
export const VARIANT_IDS = ['lite', 'reasoning'] as const;
export type VariantId = (typeof VARIANT_IDS)[number];

/** 「继承主模型」哨兵（与 CLI 常量逐字一致；写入侧语义 = 删键） */
export const INHERIT_SENTINEL = '__inherit_default__';

/** 变体 → 解析链第 1 优先的环境变量（CLI `getModelIdFromEnv` 读的就是这两个） */
export const VARIANT_ENV_KEYS: Record<VariantId, string> = {
  lite: 'CODEBUDDY_SMALL_FAST_MODEL',
  reasoning: 'CODEBUDDY_BIG_SLOW_MODEL',
};

/** 变体用途一句话（与 CLI 面板文案同源：`{lite:{description:…},reasoning:{description:…}}`） */
export const VARIANT_DESCRIPTIONS: Record<VariantId, string> = {
  lite: 'Fast / cheap, used by Explore and other lightweight sub-tasks',
  reasoning: 'Enhanced reasoning, used for complex analysis',
};

export function isVariantId(value: string): value is VariantId {
  return (VARIANT_IDS as readonly string[]).includes(value);
}

/**
 * CLI 用户级 settings 路径（`~/.codebuddy/settings.json`）。
 * 写入目标固定 USER 级：CLI 的 6 个变体命令一律 `scope='global'`（bundle 实证）。
 */
export function cliUserSettingsPath(home: string = homedir()): string {
  return join(home, '.codebuddy', 'settings.json');
}

/**
 * 读 CLI settings 的 `variantModels`（只取值非空的字符串项）。
 * 文件缺失 / 坏 JSON / 顶层非对象 / 字段非对象 → `{}`（**不抛**，与 CLI `readBaseline` 容忍语义一致）。
 */
export function readVariantMap(file: string = cliUserSettingsPath()): Record<string, string> {
  let raw: unknown;
  try {
    if (!existsSync(file)) return {};
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const section = (raw as Record<string, unknown>).variantModels;
  if (section === null || typeof section !== 'object' || Array.isArray(section)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(section as Record<string, unknown>)) {
    if (typeof v === 'string' && v.trim().length > 0) out[k] = v.trim();
  }
  return out;
}

/** 保守写的返回面：失败带可打印原因（调用方据此提示，绝不静默） */
export type WriteVariantResult = { ok: true } | { ok: false; error: string };

/**
 * 保守写 `variantModels.<variantId>`：读全文 → 只改这一个键 → 原子写回（临时文件 + rename）。
 *
 * - `value === INHERIT_SENTINEL` → **删键**（对齐 CLI `setVariantModel` 的 `delete` 语义）
 * - 顶层本无 `variantModels` 时新建该对象；**其余键一律原样保留**
 * - 坏 JSON：**不覆盖**（写盘会丢用户全部配置）→ 直接回报错误
 * - 任一步失败（读/解析/建目录/写临时/rename）→ 原文件不动
 */
export function writeVariant(
  file: string,
  variantId: VariantId,
  value: string,
): WriteVariantResult {
  let raw: Record<string, unknown> = {};
  if (existsSync(file)) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (e) {
      return { ok: false, error: `读取失败：${e instanceof Error ? e.message : String(e)}` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      // 坏 JSON 不覆盖：重写会把用户其他配置全部丢掉
      return { ok: false, error: `settings.json 不是合法 JSON，已放弃写入：${e instanceof Error ? e.message : String(e)}` };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'settings.json 顶层不是对象，已放弃写入' };
    }
    raw = parsed as Record<string, unknown>;
  }

  const existing = raw.variantModels;
  const section: Record<string, unknown> =
    existing !== null && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === INHERIT_SENTINEL) {
    delete section[variantId];
  } else {
    section[variantId] = trimmed;
  }
  if (Object.keys(section).length > 0) {
    raw.variantModels = section;
  } else {
    // 全部删空 → 连带清掉空对象，避免留下 `"variantModels": {}` 噪声
    delete raw.variantModels;
  }

  const tmp = `${file}.omc-${process.pid}-${Date.now()}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`);
    renameSync(tmp, file);
  } catch (e) {
    return { ok: false, error: `写入失败：${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true };
}

/** 变体生效来源（展示用；与 CLI `formatModelSource` 的语义对齐、粒度收窄到 omc 可达的三态） */
export type VariantSource = 'settings' | 'related' | 'inherit';

export interface VariantState {
  id: VariantId;
  /** 生效模型 id；`source === 'inherit'` 时 = 主模型 id */
  modelId: string;
  source: VariantSource;
  /**
   * 本会话的子进程 env 还没跟上 settings（改值后未重启）→ UI 显示「待重启生效」。
   * 由 `needsVariantRestart` 判定；缺省 false。
   */
  pendingRestart?: boolean;
}

/**
 * 判断某变体的**持久化值**是否已落后于「本会话 spawn 时注入的 env」。
 *
 * 依据：omc 会话的变体靠 spawn 时注入的 env 生效（D1-b），故 settings 改完之后、
 * 会话重启之前，运行中的子进程仍在用旧值 —— 此时 `/status` 若只报文件值就是误导。
 *
 * `spawnedEnv` = `AgentSession.variantEnvAtSpawn`（`envKey → 生效值`）。
 */
export function needsVariantRestart(
  id: VariantId,
  variantMap: Record<string, string>,
  spawnedEnv: Record<string, string>,
): boolean {
  const want = variantMap[id]?.trim();
  const wanted = want && want !== INHERIT_SENTINEL ? want : undefined;
  const spawned = spawnedEnv[VARIANT_ENV_KEYS[id]];
  return wanted !== spawned;
}

export interface ResolveVariantInput {
  /** `readVariantMap()` 结果 */
  variantMap: Record<string, string>;
  /** 当前主模型 id（会话 `system_init.model`） */
  mainModelId: string;
  /** 主模型条目的 `relatedModels`（来自 `getAvailableModelsRaw()`，缺省 = 未知） */
  relatedModels?: Record<string, string>;
}

/**
 * 解析某个变体的生效模型（对齐 CLI 解析链的 ②③④ 三步；① env 层不在此展示）。
 *
 * 注：CLI 的 `related` 步在「值 == 主模型 id」时也记 `inherit`（`related.id === primary.id ? 'inherit' : 'related-models'`），
 * 此处照抄。`relatedModels` 未知（未取到模型表）时同样退化为 `inherit`。
 */
export function resolveVariant(id: VariantId, input: ResolveVariantInput): VariantState {
  const fromSettings = input.variantMap[id]?.trim();
  if (fromSettings && fromSettings !== INHERIT_SENTINEL) {
    return { id, modelId: fromSettings, source: 'settings' };
  }
  const related = input.relatedModels?.[id]?.trim();
  if (related && related !== INHERIT_SENTINEL && related !== input.mainModelId) {
    return { id, modelId: related, source: 'related' };
  }
  return { id, modelId: input.mainModelId, source: 'inherit' };
}

/**
 * 子进程 env 覆盖：把持久化真源翻译成 CLI 的 env 层（V11 实证可穿透 `settingSources: []`）。
 *
 * - 用户 shell **已设**同名变量 → 让位（严格对齐 CLI 的「env 优先于 settings」）；
 * - 值为空 / `__inherit_default__` → 不注入（等同「未设置」，CLI 会继续走 related/inherit）。
 */
export function variantEnvOverrides(
  variantMap: Record<string, string>,
  shellEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of VARIANT_IDS) {
    const key = VARIANT_ENV_KEYS[id];
    const shellValue = shellEnv[key];
    if (typeof shellValue === 'string' && shellValue.trim().length > 0) continue;
    const value = variantMap[id]?.trim();
    if (!value || value === INHERIT_SENTINEL) continue;
    out[key] = value;
  }
  return out;
}

/** 来源标签（/status 一行式展示用） */
const SOURCE_LABEL: Record<VariantSource, string> = {
  settings: 'settings',
  related: 'related',
  inherit: '继承',
};

/**
 * `/status` 的变体摘要一行：`lite→hy3（settings，待重启生效） · reasoning→继承`
 * 主模型未知（会话未初始化）时仍可展示（source 一律退化为 inherit）。
 */
export function formatVariantSummary(states: readonly VariantState[]): string {
  if (states.length === 0) return '(无)';
  return states
    .map((s) => {
      const value = s.source === 'inherit' ? '继承' : s.modelId;
      const parts = s.source === 'inherit' ? [] : [SOURCE_LABEL[s.source]];
      if (s.pendingRestart) parts.push('待重启生效');
      const detail = parts.length > 0 ? `（${parts.join('，')}）` : '';
      return `${s.id}→${value}${detail}`;
    })
    .join(' · ');
}

/** 供 `/model:lite list` / 浮层复用的模型条目（RawLanguageModel 的最小子集） */
export interface VariantModelEntry {
  id: string;
  name?: string;
  disabled?: boolean;
  disabledReason?: string;
  /** 该条目自带的 `relatedModels`（解析链第 ③ 步的数据源；仅当前主模型那一行有意义） */
  relatedModels?: Record<string, string>;
}

/**
 * `list` 输出（照抄 CLI 文本骨架）：
 *   Available models for lite variant:
 *     - <name> (<id>) (disabled: reason) ← current
 *   To switch model: /model:lite <model-id-or-name>
 * 显式差异：CLI 的 `list` 是单行长串（历史形态），omc 逐行更可读；文案与优先级一致。
 */
export function formatVariantList(
  variantId: VariantId,
  models: readonly VariantModelEntry[],
  current: VariantState,
  opts: { sourceNote?: string } = {},
): string[] {
  const lines: string[] = [];
  lines.push(`Available models for ${variantId} variant:${opts.sourceNote ? ` ${opts.sourceNote}` : ''}`);
  for (const m of models) {
    const idPart = m.name && m.name !== m.id ? ` (${m.id})` : '';
    const disPart = m.disabled ? ` (disabled: ${m.disabledReason || 'unavailable'})` : '';
    const curPart = m.id === current.modelId ? ' ← current' : '';
    lines.push(`  - ${m.name ?? m.id}${idPart}${disPart}${curPart}`);
  }
  lines.push(`  To switch model: /model:${variantId} <model-id-or-name>`);
  return lines;
}

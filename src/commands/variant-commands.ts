/**
 * variant-commands.ts — 模型「场景变体」命令（model-variants-and-workflows P1 T3）。
 *
 * 语义对齐 CLI 的 `/model:lite` / `/model:reasoning`（**不是**切主模型的 `/model`）：
 * 设置 / 列出某个**子任务场景**用哪个模型。存储 = `~/.codebuddy/settings.json#variantModels`
 * （用户级，对齐 CLI 6 个变体命令一律 `scope='global'`）。
 *
 * 三种用法（对齐 CLI，P1 追加浮层后与 CLI 完全同形）：
 *   无参       → **交互浮层**（复用 `/model` 的 `ModelOverlay` 变体模式；非 TTY 回退文本列表）
 *   `list`     → 文本列表
 *   `<id|name>` / `default|inherit` → 直接写盘（sentinel = 删键）
 *
 * omc 与 CLI 的**唯一显式差异**：变体在 omc 会话内靠启动时注入的 env 生效（D1-b，见
 * src/app/model-variants.ts 头注释）→ 改值后**需重启 omc 会话**；真 CLI 会话读 settings 立即生效。
 *
 * 只做 `lite` / `reasoning`：CLI 另外 4 个命令（`model:text-to-image` 等）读的是另一张
 * product 多模态模型表，不走 `variantModels`，omc 无对应存储 → 登记为不做。
 */
import {
  INHERIT_SENTINEL,
  VARIANT_DESCRIPTIONS,
  VARIANT_IDS,
  formatVariantList,
  readVariantMap,
  resolveVariant,
  type VariantId,
  type VariantModelEntry,
  type VariantSource,
  type VariantState,
} from '../app/model-variants';
import type { CommandRegistry } from './registry';
import type { CommandContext, SlashCommand } from './types';

const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

const RESTART_NOTE = `${DIM}（变体在 omc 会话启动时注入，改值后需重启会话生效；真 CLI 会话立即生效）${RESET}`;

const SOURCE_TEXT: Record<VariantSource, string> = {
  settings: 'settings',
  related: '主模型 relatedModels',
  inherit: '继承主模型',
};

/** 从 `[list | <id|name> | default]` 里取实参（对齐 CLI：多词以空格拼回） */
function parseArg(args: string): string {
  return args.trim().split(/\s+/).filter(Boolean).join(' ');
}

/** 当前指向的来源注解（浮层副标题与列表首行共用）；改值未重启时附「待重启生效」 */
export function sourceNote(state: VariantState): string {
  const restart = state.pendingRestart ? '，待重启生效' : '';
  return `（当前：${state.modelId}，来源 ${SOURCE_TEXT[state.source]}${restart}）`;
}

/**
 * 列表行组装（**`/model:lite list` 与「浮层不可用时的非 TTY 回退」共用**，故是纯函数）。
 * `pendingRestart` 由调用方给（来自 `ctx.variantStates()` / `AgentSession.variantEnvAtSpawn`），
 * 让列表首行也能标注「改了但本会话还没跟上」。
 */
export function buildVariantListLines(
  variantId: VariantId,
  data: {
    models: readonly VariantModelEntry[];
    mainModelId: string;
    variantMap: Record<string, string>;
    pendingRestart?: boolean;
  },
): string[] {
  if (data.models.length === 0) return [`${DIM}No models available.${RESET}`];
  const current = {
    ...resolveVariant(variantId, {
      variantMap: data.variantMap,
      mainModelId: data.mainModelId,
      relatedModels: data.models.find((m) => m.id === data.mainModelId)?.relatedModels,
    }),
    pendingRestart: data.pendingRestart === true,
  };
  return [
    ...formatVariantList(variantId, data.models, current, { sourceNote: sourceNote(current) }),
    RESTART_NOTE,
  ];
}

/** RawLanguageModel → 列表条目（只取展示/判定需要的字段） */
export function toVariantEntry(m: {
  id: string;
  name?: string;
  disabled?: boolean;
  disabledReason?: string;
  relatedModels?: unknown;
}): VariantModelEntry {
  return {
    id: m.id,
    name: m.name,
    disabled: m.disabled,
    disabledReason: m.disabledReason,
    relatedModels: (m.relatedModels ?? undefined) as Record<string, string> | undefined,
  };
}

function makeVariantCommand(variantId: VariantId): SlashCommand {
  return {
    name: `model:${variantId}`,
    description: `设置/查看 ${variantId} 场景模型（${VARIANT_DESCRIPTIONS[variantId]}）；无参打开选择浮层`,
    usage: '[list | <模型 id 或 name> | default]',
    async run(ctx: CommandContext, args: string): Promise<void> {
      const arg = parseArg(args);

      // 无参 → 交互浮层（对齐 /model；非 TTY 时 openVariant 内部回退文本列表）
      if (!arg) {
        ctx.openVariant(variantId);
        return;
      }

      // list → 文本列表（CLI 同款 `list` 语义）
      if (arg.toLowerCase() === 'list') {
        await printList(ctx, variantId);
        return;
      }

      // default / inherit → 删键（对齐 CLI `setVariantModel` 的 delete 语义）
      if (arg === 'default' || arg === 'inherit') {
        const r = ctx.writeVariantModel(variantId, INHERIT_SENTINEL);
        if (!r.ok) {
          ctx.print([`${YELLOW}[model:${variantId}] 写入失败：${r.error}${RESET}`]);
          return;
        }
        ctx.print([
          `${GREEN}✓${RESET} ${variantId} variant reset to default resolution (global)`,
          RESTART_NOTE,
        ]);
        return;
      }

      // <id|name> → 精确匹配后写盘（对齐 CLI `t.name===p || t.id===p`）
      const models = await fetchModels(ctx, variantId);
      if (!models) return;
      const hit = models.find((m) => m.id === arg || m.name === arg);
      if (!hit) {
        ctx.print([
          `${YELLOW}Error: Model "${arg}" is not available.${RESET}`,
          `${DIM}Available models:${RESET}`,
          ...models.map((m) => `  - ${m.name ?? m.id}${m.name && m.name !== m.id ? ` (${m.id})` : ''}`),
        ]);
        return;
      }
      if (hit.disabled) {
        const reason = hit.disabledReason ? ` Reason: ${hit.disabledReason}` : '';
        ctx.print([`${YELLOW}Error: Model "${hit.name ?? hit.id}" is disabled.${reason}${RESET}`]);
        return;
      }

      const r = ctx.writeVariantModel(variantId, hit.id);
      if (!r.ok) {
        ctx.print([`${YELLOW}[model:${variantId}] 写入失败：${r.error}${RESET}`]);
        return;
      }
      ctx.print([
        `${GREEN}✓${RESET} ${variantId} variant set to ${hit.name ?? hit.id} (global)`,
        RESTART_NOTE,
      ]);
    },
  };
}

/** 取模型表（失败已打印提示，返回 null 让调用方直接 return） */
async function fetchModels(
  ctx: CommandContext,
  variantId: VariantId,
): Promise<VariantModelEntry[] | null> {
  try {
    const raw = await ctx.availableModelsRaw();
    return raw.map((m) => toVariantEntry(m));
  } catch (e) {
    ctx.print([
      `${YELLOW}[model:${variantId}] 查询模型列表失败：${e instanceof Error ? e.message : String(e)}${RESET}`,
    ]);
    return null;
  }
}

async function printList(ctx: CommandContext, variantId: VariantId): Promise<void> {
  const models = await fetchModels(ctx, variantId);
  if (!models) return;
  ctx.print(
    buildVariantListLines(variantId, {
      models,
      mainModelId: ctx.currentModel(),
      variantMap: readVariantMap(),
      pendingRestart: ctx.variantStates().find((s) => s.id === variantId)?.pendingRestart ?? false,
    }),
  );
}

export function registerVariantCommands(registry: CommandRegistry): void {
  for (const id of VARIANT_IDS) {
    registry.register(makeVariantCommand(id));
  }
}

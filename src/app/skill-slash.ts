/**
 * skill-slash.ts（skill-invoke P2）：skill → slash 补全条目的映射。
 *
 * pi-tui CombinedAutocompleteProvider 识别 `skill:` 命名空间前缀
 * （autocomplete.ts:461 SKILL_NAMESPACE）：空前缀折叠成一行
 * 「✦ skill: N skills」、输入 `skill:` 展开、裸名分段匹配 breakout。
 * omc 只负责喂条目，不写折叠逻辑。
 *
 * allowArgs 恒 true：skill 调用可带 args（`帮我修 bug /skill:foo 关注鉴权`），
 * 参数解析在 P3 parseSkillInvocation。
 *
 * P6 热更新追加：buildAllSlashCommands（内置+skill 合成）/ refillSkillMap
 * （原地重填 skillMap）抽到这里做纯函数，main.ts refreshSkills 复用。
 */
import type { SlashCommand as PiSlashCommand } from '@oh-my-pi/pi-tui/autocomplete.js';
import { collectCommandEntries, type CustomCommandEntry } from './command-data';
import { collectSkillEntries, type SkillEntry } from './context-data';
import { collectSavedWorkflows, type WorkflowEntry } from './workflow-data';

export function buildSkillSlashCommands(skills: readonly SkillEntry[]): PiSlashCommand[] {
  return skills.map((e) => ({
    name: `skill:${e.name}`,
    description: e.description,
    argumentHint: e.argumentHint,
    allowArgs: true,
  }));
}

/** 内置命令注册表条目的最小结构（CommandRegistry.list() 窄投影，便于单测） */
export interface BuiltinCommandLike {
  name: string;
  description: string;
  usage?: string;
}

export function buildBuiltinSlashCommands(cmds: readonly BuiltinCommandLike[]): PiSlashCommand[] {
  return cmds.map((c) => ({
    name: c.name,
    description: c.description,
    argumentHint: c.usage,
    allowArgs: c.usage !== undefined,
  }));
}

/**
 * custom-commands P2 T3：本地自定义命令（`~/.codebuddy/commands/**.md`）→ slash 条目。
 * 名字已由 command-data 归一为小写（`:` 分段的子目录形态直接可用作命令名）；
 * `allowArgs` 恒 true —— 参数由 P3 的渲染管道消费（`$ARGUMENTS` 等）。
 *
 * **description 追加 ` (user|project)` 来源后缀**：对齐 CLI `parseCommandFile`
 * （`description = (desc || name) + " (scope)"`）。补全项只有 `description` 一个
 * 展示位，不拼则用户无法分辨用户级/项目级同名命令。空 description 用名字兜底。
 */
export function buildCustomCommandSlashCommands(
  commands: readonly CustomCommandEntry[],
): PiSlashCommand[] {
  return commands.map((e) => ({
    name: e.name,
    description: `${e.description || e.name} (${e.scope})`,
    argumentHint: e.argumentHint,
    allowArgs: true,
  }));
}

/**
 * model-variants-and-workflows P2 T3：saved workflow（`~/.codebuddy/workflows` /
 * `<cwd>/.codebuddy/workflows` 的 `.js`）→ slash 条目。
 *
 * description 追加 ` (workflow:<scope>)` 来源后缀（与 custom 命令 `(user|project)` 同款，
 * 补全项唯一展示位）；`allowArgs` 恒 true（参数作为 `Workflow.args` 纯字符串转发）。
 * **builtin 不在此注册** —— `/deep-research` 由专门命令承载（编译态内置目录不可得，见
 * workflow-data.ts）。
 */
export function buildWorkflowSlashCommands(entries: readonly WorkflowEntry[]): PiSlashCommand[] {
  return entries.map((e) => ({
    name: e.name,
    description: `${e.description || e.name} (workflow:${e.scope})`,
    allowArgs: true,
  }));
}

/**
 * skill-invoke P6.3 / custom-commands P2：完整 slash 命令数组合成
 * （内置命令 + skill: 命名空间条目 + 自定义命令 + saved workflow 命令）。
 *
 * 同名覆盖**刻意不在此处做**：内置命令的执行在 omc（`registry.get`），自定义命令
 * 的执行在 P3 渲染管道 —— 列表若先隐藏内置会造成「列表显示自定义、实际执行内置」
 * 的不一致。覆盖语义统一归 P4（须与执行路径同步落地）。
 * workflow 命令的覆盖序见 `routeSlashCommand`（内置 > custom > workflow）。
 */
export function buildAllSlashCommands(
  builtins: readonly BuiltinCommandLike[],
  skills: readonly SkillEntry[],
  commands: readonly CustomCommandEntry[] = [],
  workflows: readonly WorkflowEntry[] = [],
): PiSlashCommand[] {
  return [
    ...buildBuiltinSlashCommands(builtins),
    ...buildSkillSlashCommands(skills),
    ...buildCustomCommandSlashCommands(commands),
    ...buildWorkflowSlashCommands(workflows),
  ];
}

/**
 * custom-commands P2：原地清空 + 重填同一 customCommandMap 实例（对齐 `refillSkillMap`，
 * Map 引用不变，P3 执行侧闭包不漂移）。不做可见性过滤——`disable-model-invocation`
 * 是模型侧语义，与用户 `/` 可见性无关（CLI 同理）。
 */
export function refillCustomCommandMap(cwd: string, map: Map<string, CustomCommandEntry>): void {
  map.clear();
  for (const e of collectCommandEntries(cwd)) map.set(e.name, e);
}

/**
 * skill-invoke P6.3：原地清空 + 重填同一 skillMap 实例。
 * Map 引用不变 → editor.skillFilePath 闭包自动生效，无需重设钩子。
 * skill-system P2：过滤 `user-invocable: false`（用户不可见/不可调）——skillMap 是
 * `/` 补全与 `/skill:` 触发的唯一来源，过滤后两处一并生效；`/context` 走
 * collectSkillEntries 全量，不受影响。
 */
export function refillSkillMap(cwd: string, map: Map<string, SkillEntry>): void {
  map.clear();
  for (const e of collectSkillEntries(cwd)) {
    if (!e.userInvocable) continue;
    map.set(e.name, e);
  }
}

/**
 * model-variants-and-workflows P2 T3：原地清空 + 重填同一 workflowCommandMap 实例
 * （挂 `refreshSkills`；Map 引用不变，执行侧闭包不漂移）。**只收 saved**（project/user），
 * builtin 由 `/deep-research` 专门命令承载。name 口径 = 文件名去 `.js`（CLI `scanDir`）。
 */
export function refillWorkflowCommandMap(cwd: string, home: string, map: Map<string, WorkflowEntry>): void {
  map.clear();
  for (const e of collectSavedWorkflows({ cwd, home })) {
    if (e.scope === 'builtin') continue;
    map.set(e.name, e);
  }
}

/**
 * prompt-commands.ts — prompt 型内置命令注册（custom-commands P5 T6/T7）。
 *
 * 形态：每个命令 = 「模板 + registry 条目」，`run()` 不自己发消息，而是调
 * `ctx.runPromptCommand(def, args)` —— main 侧把它渲染成用户消息并**复用 custom
 * command 的提交路径**（`renderCustomCommand` + `CommandMessageCard` + `QueuedInput → deliver`）。
 *
 * 为什么不直接 `sendToAgent(text)`：那样拿不到命令卡回显、也丢排队/落盘语义。
 *
 * 覆盖语义（P4 定案「内置优先」）：这些命令进 registry → 输入命中即执行，
 * 不会被 `~/.codebuddy/commands/` 的同名自定义命令劫持。
 *
 * 模板正文见 `prompt-templates.ts`（由 `scripts/gen-prompt-templates.ts` 生成）。
 */
import { PROMPT_COMMANDS, type PromptCommandDef } from './prompt-templates';
import type { CommandRegistry } from './registry';
import type { SlashCommand } from './types';

export function registerPromptCommands(registry: CommandRegistry): void {
  for (const def of PROMPT_COMMANDS) {
    const cmd: SlashCommand = {
      name: def.name,
      description: def.description,
      usage: def.argumentHint,
      run(ctx, args) {
        ctx.runPromptCommand(def, args);
      },
    };
    registry.register(cmd);
  }
}

export { PROMPT_COMMANDS };
export type { PromptCommandDef };

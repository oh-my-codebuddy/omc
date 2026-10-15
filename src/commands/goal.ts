/**
 * goal.ts — 内置 `/goal` 命令（goal P1）。
 *
 * 设一个会话级停止条件：每次代理想停时由 Stop hook 判定，未达标拦停续跑、达标放行并自动清除
 * （机制见 docs/plan/goal/）。命令本身只做**解析 + 状态迁移 + 回执**；判定循环由 P1.2 的
 * Stop hook 驱动。子命令语义（对齐 codebuddy）：
 *
 *   /goal <条件>    设条件（多词 join；上限 4000 字符）
 *   /goal           显示当前条件 + 统计
 *   /goal clear     清除（别名 stop/off/reset/none/cancel）
 *   /goal pause     暂停（保留条件）
 *   /goal resume    恢复
 *
 * 保留字优先：单字 `clear` 等一律当子命令，不当条件（与 codebuddy 一致）。
 */
import { applyGoalCommand, formatGoalStatus, parseGoalCommand } from '../app/goal-state';
import type { CommandRegistry } from './registry';
import type { SlashCommand } from './types';

const DIM = '\x1b[2m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

const goal: SlashCommand = {
  name: 'goal',
  description: '设会话级停止条件：未达标自动续跑、达标自动清除（Stop hook 判定）',
  usage: '<条件> | clear | pause | resume',
  run(ctx, args) {
    const cmd = parseGoalCommand(args);
    if (cmd.kind === 'error') {
      ctx.print([`${YELLOW}[goal] ${cmd.message}${RESET}`]);
      return;
    }
    const prev = ctx.session.getGoal();
    const next = applyGoalCommand(prev, cmd, Date.now());
    ctx.session.setGoalState(next);

    switch (cmd.kind) {
      case 'show':
        ctx.print(formatGoalStatus(next));
        return;
      case 'set': {
        const exitNote = cmd.exitOnMet ? '，达标后自动退出' : '';
        ctx.print([
          `${DIM}[goal] 已设条件：${cmd.condition}（未达标自动续跑${exitNote}）${RESET}`,
          `${DIM}       达标后自动清除（/goal 查看 · /goal clear 清除）${RESET}`,
        ]);
        // goal P2：--exit 无人值守提示（不强制拦截，用户 2026-10-10 拍板）
        if (cmd.exitOnMet && ctx.currentMode() !== 'bypassPermissions') {
          ctx.print([
            `${YELLOW}[goal] ⚠ --exit 达标后退出进程；当前权限模式 ${ctx.currentMode()}，无人值守下权限弹窗会挂住（建议 -y / bypassPermissions）${RESET}`,
          ]);
        }
        // kickoff（对齐 codebuddy buildKickoffMessage）：告知模型 Stop hook 已激活，
        // 把条件当指令、达标自动清除。走正常 turn 管线 → 置 running，模型据此开工。
        ctx.sendToAgent(
          `[goal] 会话级停止条件已激活：${cmd.condition}\n` +
            `请把它当作你的指令，持续工作直到满足；达标后会自动清除${exitNote}（成功后无需手动 /goal clear）。`,
        );
        return;
      }
      case 'clear':
        ctx.print([prev ? `${DIM}[goal] 已清除${RESET}` : `${DIM}[goal] 当前无 goal${RESET}`]);
        return;
      case 'pause':
        ctx.print([
          prev ? `${DIM}[goal] 已暂停（/goal resume 恢复）${RESET}` : `${DIM}[goal] 当前无 goal${RESET}`,
        ]);
        return;
      case 'resume':
        ctx.print([prev ? `${DIM}[goal] 已恢复${RESET}` : `${DIM}[goal] 当前无 goal${RESET}`]);
        return;
    }
  },
};

export function registerGoalCommand(registry: CommandRegistry): void {
  registry.register(goal);
}

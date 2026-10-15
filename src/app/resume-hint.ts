/**
 * resume-hint.ts — 退出时的「如何恢复本会话」提示（纯函数，可单测）。
 *
 * 动机：omc 退出后终端只剩 shell，用户想回到刚才那次会话得先知道 sessionId
 * （`omc --resume <id>`，或 `omc -c` 恢复当前目录最近一次）。sessionId 只在
 * 状态栏/`~/.omc/projects/` 里，退出即看不见 —— 故在退出路径把它打出来。
 *
 * 只在**已生成 session** 时输出；无 id（启动即失败/子命令路径未进会话）返回空数组。
 * 命令形态照 omc 自己的解析器（`src/cli-args.ts`）：`--resume/-r` 是**空格分隔**
 * （不支持 `--resume=<id>`），`-c/--continue` 取当前 cwd 最近会话。
 */

/** 输出行（含缩进/标点与否由调用方决定；此处给最终可打印文本） */
export function resumeHintLines(sessionId: string | null | undefined): string[] {
  const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!sid) return [];
  return [`To resume this session: omc --resume ${sid}`, 'or resume last session: omc -c'];
}

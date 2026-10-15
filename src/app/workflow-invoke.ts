/**
 * workflow-invoke.ts — saved workflow 命令的转发载荷构造（model-variants-and-workflows P2 T3）。
 *
 * 语义：omc 无法直接执行 workflow（SDK 无工具调用 API，`Workflow` 是**模型侧**工具），
 * 故 saved workflow 命令 `/<name>` 走**转发型** —— 生成一条指令消息，让模型调用
 * `Workflow({name, args})`。走既有 QueuedInput 通路（排队 / Alt+↑ / 落盘 / 中断全白拿）
 * + 命令卡回显（复用 `CustomCommandDetails` 结构）。
 *
 * 为什么**不复用** `renderCustomCommand`：那条管道会无条件执行 `!`cmd`` 内联 shell 与
 * `@file` 展开（custom-commands P3 定案）；workflow 转发只需纯文本替换，故独立实现
 * （`inlineCommands` 恒空 = 安全边界）。
 *
 * 载荷口径（T1 实证）：`Workflow` 工具的 `args` 参数**必须纯字符串**（schema `.strict()`
 * 拒绝对象/数组），故指令里显式给出 JSON 字符串形式并强调「勿包成对象」。
 */
import type { CustomCommandDetails } from './command-invoke';
import type { WorkflowEntry } from './workflow-data';

/** 转发载荷（结构对齐 `BuiltCommandPrompt`，可直接喂 QueuedEcho `kind:'command'`） */
export interface BuiltWorkflowPrompt {
  /** 注入模型的完整消息（`<command-message>` 头 + 指令正文） */
  message: string;
  details: CustomCommandDetails;
}

/** 生成给模型的指令正文（rendered） */
export function buildWorkflowInstruction(entry: WorkflowEntry, args: string): string {
  const argsValue = args.trim();
  const keys = [`- tool: Workflow`, `- name: ${entry.name}`];
  if (argsValue) keys.push(`- args: ${JSON.stringify(argsValue)}   ← 必须原样作为纯字符串传入（勿包成对象/数组）`);
  const desc = entry.description ? `\n用途：${entry.description}` : '';
  return [
    `调用 Workflow 工具执行已保存的动态工作流「${entry.name}」。${desc}`,
    '参数：',
    ...keys,
    '要求：只调用一次 Workflow 工具，不要用其它工具替代；调用返回后用一句话说明已启动。',
  ].join('\n');
}

/**
 * 构造 saved workflow 命令的转发载荷。
 * `args` = `/name` 之后的参数文本（作为 `Workflow.args` 的纯字符串原样传入）。
 */
export function buildWorkflowInvocation(
  entry: WorkflowEntry,
  args: string,
  opts: { prompt?: string } = {},
): BuiltWorkflowPrompt {
  const rendered = buildWorkflowInstruction(entry, args);
  const trimmedArgs = args.trim();
  const head =
    `<command-message>${entry.name}</command-message> <command-name>/${entry.name}</command-name>` +
    (trimmedArgs ? ` <command-args>${trimmedArgs}</command-args>` : '');
  return {
    message: `${head}\n${rendered}`,
    details: {
      name: entry.name,
      scope: entry.scope,
      path: entry.file,
      lineCount: rendered.split('\n').length,
      rendered,
      args: trimmedArgs || undefined,
      prompt: opts.prompt,
      inlineCommands: [], // 安全边界：workflow 转发绝不执行内联 shell
      allowedTools: [],
    },
  };
}

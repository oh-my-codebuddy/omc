/**
 * CommandMessageCard（custom-commands P3 T5）：自定义命令调用回显卡。
 *
 * 结构照抄 CompactSummaryCard（Disclosure 折叠 + CappedMarkdown 限高）——
 * pi-tui 展开不限高的组件在长正文下会整卡退休冻结（ctrl+o 收不回，2026-10-02
 * 实锤），故**必须限高**。
 *
 * 与本地 `/skill:` 的 SkillMessageComponent 是两条路径：后者 chip 硬编码
 * `skill:` 前缀（`skillToken`/`skillChipLabel`），无法表达 `/name` 语义，
 * 故此处自组一张命令卡。全文另走 `/export`（落盘 prompt）。
 */
import { theme } from '@oh-my-pi/pi-tui';
import { Disclosure } from '@oh-my-pi/pi-tui/components/disclosure';
import { Box } from '@oh-my-pi/pi-tui/components/box';
import { Text } from '@oh-my-pi/pi-tui/components/text';
import type { CustomCommandDetails } from '../app/command-invoke';
import { CappedMarkdown, type DetailRowCap } from './compact-summary-card';

/** 展开详情行数上限（不含提示行）：保证整卡远小于一屏 */
export const COMMAND_CARD_MAX_DETAIL_ROWS = 24;

export interface CommandCardOptions {
  details: CustomCommandDetails;
  maxDetailRows?: DetailRowCap;
}

/** 卡片头：`❯ /name (scope) · N lines` +（可选）args 行 */
export function commandCardHeader(details: CustomCommandDetails): string {
  const name = theme.fg('customMessageLabel', `/${details.name}`);
  const scope = theme.fg('muted', `(${details.scope})`);
  const size = theme.fg('dim', `· ${details.lineCount} ${details.lineCount === 1 ? 'line' : 'lines'}`);
  let head = `❯ ${name} ${scope} ${size}`;
  if (details.args) head += `\n${theme.fg('dim', `args: ${details.args}`)}`;
  return head;
}

export class CommandMessageCard {
  #disclosure: Disclosure;

  constructor(options: CommandCardOptions) {
    const { details } = options;
    const maxRows = options.maxDetailRows ?? COMMAND_CARD_MAX_DETAIL_ROWS;
    this.#disclosure = new Disclosure({
      summary: new Text(commandCardHeader(details), 0, 0),
      body: () => {
        const box = new Box(1, 1, (t: string) => theme.bg('customMessageBg', t));
        box.setIgnoreTight(true);
        // T6 决策 (a)：内联 shell 无条件执行，但**必须**回显执行过的命令（可审计）
        if (details.inlineCommands.length > 0) {
          box.addChild(new Text(theme.fg('muted', 'inline shell:'), 0, 0));
          for (const cmd of details.inlineCommands) {
            box.addChild(new Text(theme.fg('dim', `  $ ${cmd}`), 0, 0));
          }
        }
        // P4 定案：`allowed-tools` 仅展示（对齐 CLI 现状，不生效）；未声明则不渲染
        if (details.allowedTools.length > 0) {
          box.addChild(
            new Text(theme.fg('muted', `allowed-tools: ${details.allowedTools.join(', ')}`), 0, 0),
          );
        }
        box.addChild(
          new CappedMarkdown(
            details.rendered,
            maxRows,
            (hidden) => `… 命令正文还有 ${hidden} 行未显示（完整内容已发给模型；全文见命令文件）`,
          ),
        );
        return box;
      },
      expanded: false,
    });
  }

  /** ctrl+o 批量翻转经 duckCallBool 命中（鸭子类型，与工具卡/摘要卡同口径） */
  setExpanded(expanded: boolean): void {
    this.#disclosure.setExpanded(expanded);
  }

  setIgnoreTight(ignore: boolean): this {
    this.#disclosure.setIgnoreTight(ignore);
    return this;
  }

  invalidate(): void {
    this.#disclosure.invalidate();
  }

  render(width: number): readonly string[] {
    return this.#disclosure.render(width);
  }
}

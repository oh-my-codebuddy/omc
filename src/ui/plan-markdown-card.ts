/**
 * PlanMarkdownCard（plan-approval P2.1）：把「模型写入计划文件」渲染成一张 markdown
 * 计划卡 —— 替代原先的 Write `+/-` diff 卡，复刻 codebuddy「计划进正文」的观感。
 *
 * 为什么限高：计划正文经常超一屏，且 pi-tui 转录区把超屏块整批退休进原生 scrollback
 * （退休行不重绘）——超一屏卡展开后会被「冻结」折不动（项目 × 摘要卡同类教训）。
 * 故正文经 `CappedMarkdown` **真渲染计数**截断（默认视口 − 14，下限 6），全文出口留 `/plan`。
 *
 * 非交互、无 `isTranscriptBlockFinalized`（允许正常退休）。单组件（Box 承载子件），
 * 满足「多行卡必须单组件」约束（块间空行会在逐行 addChild 时断线）。
 */
import { theme } from '@oh-my-pi/pi-tui';
import { Box } from '@oh-my-pi/pi-tui/components/box';
import { Text } from '@oh-my-pi/pi-tui/components/text';
import { CappedMarkdown, type DetailRowCap } from './compact-summary-card';

/** 计划卡正文默认限高（未注入视口函数时的固定值） */
export const PLAN_CARD_MAX_DETAIL_ROWS = 24;

export interface PlanMarkdownCardOptions {
  /** 计划 markdown 全文 */
  markdown: string;
  /** 正文行数上限（固定值或视口函数；缺省 PLAN_CARD_MAX_DETAIL_ROWS） */
  maxDetailRows?: DetailRowCap;
}

export class PlanMarkdownCard {
  #box: Box;
  #body: CappedMarkdown;

  constructor(options: PlanMarkdownCardOptions) {
    this.#box = new Box(1, 1, (t: string) => theme.bg('customMessageBg', t));
    this.#box.setIgnoreTight(true);
    this.#box.addChild(new Text(theme.fg('accent', '⏺ Plan'), 0, 0));
    this.#body = new CappedMarkdown(
      options.markdown,
      options.maxDetailRows ?? PLAN_CARD_MAX_DETAIL_ROWS,
      (hidden) => `… 计划还有 ${hidden} 行，/plan 查看全文`,
    );
    this.#box.addChild(this.#body);
  }

  setIgnoreTight(ignore: boolean): this {
    this.#box.setIgnoreTight(ignore);
    return this;
  }

  invalidate(): void {
    this.#box.invalidate?.();
    this.#body.invalidate();
  }

  render(width: number): readonly string[] {
    return this.#box.render(width);
  }
}

/**
 * summary-overlay.ts（ux-port-v2 P3）：/summary 压缩摘要全文浮层。
 * 摘要卡在 transcript 里限高（展开超一屏会被退休机制冻结，见
 * compact-summary-card.ts 头注），全文出口走 overlay——不占 scrollback、
 * 关掉即还原。ScrollView 内建 ↑↓/PgUp/PgDn/Home/End/Shift+↑↓ 滚动，
 * q/Esc 关闭。双世界强转同 usage-overlay 先例。
 */
import { getMarkdownTheme, theme, type TUI } from '@oh-my-pi/pi-tui';
import { Markdown } from '@oh-my-pi/pi-tui/components/markdown';
import { ScrollView } from '@oh-my-pi/pi-tui/components/scroll-view';
import { matchesKey } from '@oh-my-pi/pi-tui/keys.js';
import { stripCompactSummaryWrapper } from './compact-summary-card';

export interface CompactSummaryInfo {
  /** 摘要原文（可带 XML 包装，浮层内剥） */
  text: string;
  trigger?: 'manual' | 'auto';
  preTokens?: number;
}

export class SummaryOverlayComponent {
  #scroll: ScrollView;
  #onClose: () => void;

  constructor(info: CompactSummaryInfo, viewportRows: number, onClose: () => void) {
    this.#onClose = onClose;
    const tokenLine =
      info.preTokens !== undefined && info.preTokens > 0
        ? `Compacted from ${info.preTokens.toLocaleString()} tokens`
        : 'Compacted context';
    const markdown = `**${tokenLine}**\n\n${stripCompactSummaryWrapper(info.text)}`;
    const md = new Markdown(markdown, 0, 0, getMarkdownTheme(), {
      color: (t: string) => theme.fg('customMessageText', t),
    });
    // fullscreen alt-buffer 浮层：头 1 行 + 滚动区占满其余（合成基底为空白，
    // 无背景拼接错位问题，见 showSummaryOverlay 注释）
    this.#scroll = new ScrollView(md, { height: Math.max(5, viewportRows - 2), scrollbar: 'auto' });
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || data === 'q') {
      this.#onClose();
      return;
    }
    this.#scroll.handleScrollKey(data);
  }

  render(width: number): readonly string[] {
    const header = theme.fg('dim', '── 压缩摘要全文（↑↓/PgUp/PgDn 滚动，q/Esc 关闭）──');
    return [header, ...this.#scroll.render(width)];
  }

  invalidate(): void {
    this.#scroll.invalidate();
  }
}

export function showSummaryOverlay(tui: TUI, info: CompactSummaryInfo): void {
  type SrcComponent = Parameters<typeof tui.showOverlay>[0];
  let handle: { hide(): void } | null = null;
  const component = new SummaryOverlayComponent(info, tui.terminal.rows, () => {
    handle?.hide();
    handle = null;
    tui.requestRender();
  });
  // fullscreen: true → alt buffer 渲染（tui.ts:3886 #renderAltFrame），合成基底
  // 是空白而非 transcript——2026-10-02 用户实测：非 fullscreen 浮层经
  // #compositeLineAt 按列拼接到底层内容上，背景含中文/宽字符时边界处错行
  // （此前各弹窗同病）。alt buffer 下 transcript 完全不被触碰，从根上规避
  handle = tui.showOverlay(component as unknown as SrcComponent, { fullscreen: true });
}

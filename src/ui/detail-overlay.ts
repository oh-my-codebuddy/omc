/**
 * detail-overlay.ts（detail-view P1.2）：**会话详情全屏视图**（`/detail` / `F2`）。
 *
 * 为什么要有它（病灶）：`ctrl+o` 的就地展开只作用于**当前视口内**的块 —— 退休进原生
 * scrollback 的旧 thinking / 旧工具卡折不动也展不开；而「重写整屏历史」代价高、且把
 * 全部工具卡摊开会撑爆 scrollback。thinking 在转录区里又是逐块折叠的（定稿块折成
 * `Thought for Ns`）。→ 读全文另走本视图：**转录区零触碰**、不受退休机制约束、可自由滚动。
 *
 * 机制照 `summary-overlay.ts` 范式：
 * - `fullscreen: true` → alt buffer 渲染（合成基底是空白）；非 fullscreen 浮层按列拼接到
 *   转录区上，背景含中文/宽字符会错行（2026-10-02 实测）
 * - `ScrollView` 内建 ↑↓ / PgUp / PgDn / Home / End / Shift+↑↓，`q` / Esc 关闭
 * - **鼠标**（2026-10-12 用户要求）：alt buffer 期间 pi-tui 自动开 SGR 鼠标追踪
 *   （`tui.ts` `MOUSE_TRACKING_ON`），事件经焦点组件 `handleInput` 送来 → 本组件解析：
 *   滚轮/触控板两指滑动 = 上下滚（{@link WHEEL_SCROLL_LINES} 行/格）；
 *   右侧滚动条**点击或拖动** = 按比例跳转（点哪滚到哪）。
 *   注意主转录区（非浮层）不开鼠标追踪 → 那里滚轮仍是**终端原生 scrollback**，行为不变。
 * - 内容是 Markdown 全文（`/export` 同源渲染 + thinking），由调用方备好
 *
 * 只读：无编辑 / 跳转 / 搜索（D5）。体积护栏见 {@link clampDetailMarkdown}。
 */
import { getMarkdownTheme, theme, type TUI } from '@oh-my-pi/pi-tui';
import { Markdown } from '@oh-my-pi/pi-tui/components/markdown';
import { ScrollView } from '@oh-my-pi/pi-tui/components/scroll-view';
import { matchesKey } from '@oh-my-pi/pi-tui/keys.js';
import { routeSgrMouseInput, type SgrMouseEvent } from '@oh-my-pi/pi-tui/mouse.js';

/**
 * 内容体积上限（D6）：超过则**保留尾部**（最新内容更常用）+ 头部一行省略提示。
 * 会话 markdown 含全部工具输出，长会话可达数百 KB —— 不设护栏会让「打开即卡」。
 */
export const DETAIL_MAX_CHARS = 200_000;

/** 滚轮/触控板一格的滚动行数（pi-tui debug apps 同款 `wheel * 3` 口径） */
export const WHEEL_SCROLL_LINES = 3;

/** 超限时保留尾部 + 头部提示（纯函数，便于单测） */
export function clampDetailMarkdown(markdown: string, max: number = DETAIL_MAX_CHARS): string {
  if (markdown.length <= max) return markdown;
  // 从换行处切开，避免半行/半个 markdown 标记
  const nl = markdown.indexOf('\n', markdown.length - max);
  const tailStart = nl >= 0 ? nl + 1 : markdown.length - max;
  return (
    `> ⚠️ 内容过长：已省略开头 ${tailStart.toLocaleString()} 字符（完整内容用 \`/export\` 导出为文件）\n\n` +
    markdown.slice(tailStart)
  );
}

export class DetailOverlayComponent {
  #scroll: ScrollView;
  #onClose: () => void;
  #title: string;
  /** 滚动区高度（屏幕行数 − 1 行头行） */
  #scrollHeight: number;
  /** 最近一次 render 的宽度（用于判断点击是否落在最右列的滚动条上） */
  #width = 0;
  /** 滚动条拖拽中（左键按下后，motion 事件跟着走） */
  #draggingScrollbar = false;

  constructor(markdown: string, viewportRows: number, onClose: () => void, title = '会话详情') {
    this.#onClose = onClose;
    this.#title = title;
    const md = new Markdown(clampDetailMarkdown(markdown), 0, 0, getMarkdownTheme(), {
      color: (t: string) => theme.fg('customMessageText', t),
    });
    // fullscreen alt-buffer 浮层：头 1 行 + 滚动区占满其余
    this.#scrollHeight = Math.max(5, viewportRows - 2);
    this.#scroll = new ScrollView(md, { height: this.#scrollHeight, scrollbar: 'auto' });
  }

  handleInput(data: string): void {
    // 鼠标先拦（alt buffer 期间追踪自动开启；事件经焦点组件送来）
    if (routeSgrMouseInput(data, (ev) => this.#onMouse(ev))) return;
    if (matchesKey(data, 'escape') || data === 'q') {
      this.#onClose();
      return;
    }
    this.#scroll.handleScrollKey(data);
  }

  render(width: number): readonly string[] {
    this.#width = width;
    const hint = theme.fg(
      'dim',
      `── ${this.#title}（↑↓/PgUp/PgDn/滚轮/拖滚动条 滚动，q/Esc 关闭）──`,
    );
    return [hint, ...this.#scroll.render(width)];
  }

  invalidate(): void {
    this.#scroll.invalidate();
  }

  /**
   * 鼠标：滚轮（含触控板两指滑动）上下滚；点击/拖动**最右列**（滚动条）按比例跳转。
   * 行坐标换算：屏幕第 0 行是头行 → 滚动区局部行 = `ev.row - 1`。
   * 无滚动条（内容不溢出）时 `maxOffset = 0` → 跳转自然退化为空操作。
   */
  #onMouse(ev: SgrMouseEvent): boolean {
    if (ev.wheel !== null) {
      this.#scroll.scroll(ev.wheel * WHEEL_SCROLL_LINES);
      return true;
    }
    const bodyRow = ev.row - 1;
    const inBody = bodyRow >= 0 && bodyRow < this.#scrollHeight;
    const onScrollbar = inBody && this.#width > 0 && ev.col >= this.#width - 1;
    if (ev.motion) {
      // 悬停不动；只有按住左键拖拽时才跟随
      if (this.#draggingScrollbar) {
        if (onScrollbar) this.#jumpToRow(bodyRow);
        else this.#draggingScrollbar = false;
      }
      return true;
    }
    if (ev.release) {
      this.#draggingScrollbar = false;
      return true;
    }
    if (ev.leftClick && onScrollbar) {
      this.#draggingScrollbar = true;
      this.#jumpToRow(bodyRow);
    }
    return true;
  }

  /** 点/拖到滚动条第 `bodyRow` 行 → 按比例映射到滚动偏移（点哪滚到哪） */
  #jumpToRow(bodyRow: number): void {
    const max = this.#scroll.getMaxScrollOffset();
    if (max <= 0) return;
    const ratio = bodyRow / Math.max(1, this.#scrollHeight - 1);
    this.#scroll.setScrollOffset(Math.round(ratio * max));
  }
}

export function showDetailOverlay(tui: TUI, opts: { markdown: string; title?: string }): void {
  type SrcComponent = Parameters<typeof tui.showOverlay>[0];
  let handle: { hide(): void } | null = null;
  const component = new DetailOverlayComponent(opts.markdown, tui.terminal.rows, () => {
    handle?.hide();
    handle = null;
    tui.requestRender();
  }, opts.title);
  // fullscreen: true → alt buffer（同 summary-overlay：转录区完全不被触碰）
  handle = tui.showOverlay(component as unknown as SrcComponent, { fullscreen: true });
}

/**
 * select-overlay.ts — 通用单选浮层（plugin 阶段 P4.4，ctx.ui.select 的渲染载体）。
 *
 * 仿 mode-overlay.ts：内嵌 pi-tui SelectList（↑↓ 导航 + Enter/Esc 内建）。
 * 渲染含中文文案 → **fullscreen alt-buffer**（规避非 fullscreen 浮层按列拼接时
 * 宽字符错行，先例 shape-overlay.ts:100-102 / summary-overlay.ts:66-70），
 * 双世界强转同款（见 mode-overlay.ts 头注释）。
 */
import type { Component, OverlayHandle, TUI } from '@oh-my-pi/pi-tui';
import { SelectList, type SelectItem, type SelectListLayoutOptions } from '@oh-my-pi/pi-tui/components/select-list';
import { getSelectListTheme } from '@oh-my-pi/pi-tui/theme/tui-adapters';
import { theme } from '@oh-my-pi/pi-tui/theme';
import { truncateToWidth } from '@oh-my-pi/pi-tui/utils.js';
import type { PluginSelectItem } from '../plugin/types';
import { buildColumnsRow, computeColumnWidths } from './select-columns';

export interface SelectOverlayOptions {
  title: string;
  items: PluginSelectItem[];
  /** 预选项 value（高亮 + ✓） */
  current?: string;
  /** 底部提示行；缺省「Enter 选择 · Esc 取消」 */
  hint?: string;
  /**
   * label（名称）列**最大**宽度，默认 24。pi-tui 按内容收缩到该上限；
   * label 较长时（如 `CODEBUDDY.local.md（项目）`）调高以免被截断。
   */
  maxPrimaryColumnWidth?: number;
  /**
   * 列头（结构化列模式开关）：存在 → 表头行（不滚动）+ 各行 `fields` 按宽对齐、
   * `description` 不渲染；缺省 → 现有 label+description 双列路径，行为不变。
   * 与 `PluginSelectItem.fields` 配对：`columns[0]` = 名称列头，`columns[1..]` ↔ `fields[0..]`。
   * 窄终端（各列宽度和超内容宽）自动退回双列路径。
   */
  columns?: string[];
}

/** 浮层列表之外固定占用的行（标题 1 + 选中项说明 1 + 提示 1 + 余量 3） */
const OVERLAY_CHROME_ROWS = 6;

/**
 * 列表可见行预算：**尽量全部显示**（条目少时不出滚动条 / 不出现 "Type to search"），
 * 仅当超出终端可用高度时才滚动。
 * @param itemCount 条目数
 * @param terminalRows 终端总行数；0/未定义（非 TTY、PTY 未报尺寸）→ 按 24 行计
 * @param extraChromeRows 额外 chrome 行（columns 模式表头占 1 行）
 */
export function visibleRowBudget(itemCount: number, terminalRows?: number, extraChromeRows = 0): number {
  const rows = terminalRows && terminalRows > 0 ? terminalRows : 24;
  const available = Math.max(1, rows - OVERLAY_CHROME_ROWS - Math.max(0, extraChromeRows));
  return Math.max(1, Math.min(itemCount, available));
}

export interface SelectOverlayCallbacks {
  /** Enter 选中；调用方负责 hide */
  onPick: (value: string) => void;
  /** Esc 取消；调用方负责 hide */
  onCancel: () => void;
}

export class SelectOverlay implements Component {
  #title: string;
  #hint: string;
  #header: string | null = null;
  #list: SelectList;

  constructor(opts: SelectOverlayOptions, callbacks: SelectOverlayCallbacks) {
    this.#title = opts.title;
    this.#hint = opts.hint ?? 'Enter 选择 · Esc 取消';
    const listTheme = getSelectListTheme();
    const maxPrimary = opts.maxPrimaryColumnWidth ?? 24;
    const termCols = process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 80;

    // columns 模式（D1/D3/D6）：列宽构造期一次算好；放不下（窄终端）整体退回双列路径。
    let maxVisible = visibleRowBudget(opts.items.length, process.stdout.rows, opts.columns?.length ? 1 : 0);
    let columnsLayout: ReturnType<typeof computeColumnWidths> = null;
    if (opts.columns?.length) {
      const contentWidth = Math.max(1, termCols - (opts.items.length > maxVisible ? 1 : 0));
      columnsLayout = computeColumnWidths(opts.items, opts.columns, maxPrimary, contentWidth);
      if (!columnsLayout) maxVisible = visibleRowBudget(opts.items.length, process.stdout.rows);
    }

    let items: SelectItem[];
    let layout: SelectListLayoutOptions | undefined;
    if (columnsLayout && opts.columns) {
      // 结构化列：✓ 独立标记列（不并入 label）；description 不渲染，fields 拼 searchText 保持可搜。
      const lw = columnsLayout;
      const fieldsByItem = new Map<SelectItem, readonly string[]>();
      items = opts.items.map((i) => {
        const item: SelectItem = { value: i.value, label: i.label, searchText: (i.fields ?? []).join(' ') };
        fieldsByItem.set(item, i.fields ?? []);
        return item;
      });
      this.#header = theme.fg('dim', buildColumnsRow(lw, opts.columns[0]!, opts.columns.slice(1)));
      const cursor = listTheme.symbols?.cursor ?? '>';
      layout = {
        renderItem: (context) => {
          const row = buildColumnsRow(lw, context.item.label, fieldsByItem.get(context.item) ?? [], {
            cursor: context.selected ? cursor : undefined,
            mark: context.item.value === opts.current,
          });
          const clipped = truncateToWidth(row, Math.max(1, context.width));
          if (context.selected) return [context.theme.selectedText(clipped)];
          if (context.hovered && context.theme.hovered) return [context.theme.hovered(clipped)];
          return [clipped];
        },
        measureItem: () => 1,
      };
    } else {
      // 用 pi-tui 默认双列渲染（label + description 同行）——插件把字段放 description 即
      // 与 `omc codebuddy list` 一样逐行可见；当前项把 ✓ 并入 label（默认渲染不消费 state）。
      items = opts.items.map((i) => ({
        value: i.value,
        label: i.value === opts.current ? `${i.label} ✓` : i.label,
        description: i.description,
      }));
    }
    this.#list = new SelectList(items, maxVisible, listTheme, {
      // 名称列按内容收缩（pi-tui 默认固定 32 列会挤掉 description）
      minPrimaryColumnWidth: 6,
      maxPrimaryColumnWidth: maxPrimary,
      ...layout,
    });
    const idx = items.findIndex((i) => i.value === opts.current);
    if (idx >= 0) this.#list.setSelectedIndex(idx);
    this.#list.onSelect = (item) => callbacks.onPick(item.value);
    this.#list.onCancel = () => callbacks.onCancel();
  }

  render(width: number): readonly string[] {
    const lines = [theme.fg('accent', this.#title)];
    if (this.#header) lines.push(this.#header);
    lines.push(...this.#list.render(width), theme.fg('dim', this.#hint));
    return lines;
  }

  handleInput(data: string): void {
    this.#list.handleInput(data);
  }

  /** 测试可观测性 */
  get selectedValue(): string | undefined {
    return this.#list.getSelectedItem()?.value;
  }

  /** 测试可观测性：list 内部行号 → item 索引（表头在 list 之外，天然不命中） */
  hitTest(line: number): number | undefined {
    return this.#list.hitTest(line);
  }

  /** 测试可观测性：设置 hover 行（验证自绘 hover 着色路径） */
  setHoverIndex(index: number | null): void {
    this.#list.setHoverIndex(index);
  }
}

/**
 * showOverlay 组装：返回 handle（pick/cancel 后统一 hide）。
 *
 * close 顺序 = **先 hide 再跑回调**（rewind 浮层锁死修复，2026-10-09）：回调里若同步
 * 再 `showSelectOverlay` 下一层（/rewind 列表→范围→确认的层叠创建），pi-tui 会把「此刻的
 * 焦点持有者」记成新浮层的 `preFocus`。先跑回调时本浮层尚未出栈、焦点还在本浮层组件上，
 * 于是下一层的 `preFocus` 记到**即将出栈的死组件**；全部出栈后 `hide()` 还焦到
 * `topVisible ?? preFocus` = 死组件 → 编辑器永远拿不回焦点（真机症状：输入框打不进字、
 * Enter 只再弹列表）。先 hide 让焦点先还原到编辑器，后续浮层的 preFocus 链条才指向活组件。
 */
export function showSelectOverlay(
  tui: TUI,
  opts: SelectOverlayOptions,
  callbacks: SelectOverlayCallbacks,
): OverlayHandle {
  type SrcComponent = Parameters<typeof tui.showOverlay>[0];
  let handle: OverlayHandle | null = null;
  const close = (fn: () => void): void => {
    if (handle && !handle.isHidden()) handle.hide();
    handle = null;
    fn();
  };
  const component = new SelectOverlay(opts, {
    onPick: (value) => close(() => callbacks.onPick(value)),
    onCancel: () => close(() => callbacks.onCancel()),
  });
  handle = tui.showOverlay(component as unknown as SrcComponent, { fullscreen: true });
  return handle;
}

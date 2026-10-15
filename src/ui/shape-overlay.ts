/**
 * shape-overlay.ts（composer-shape 阶段 P3）：/shape 输入区形状选择浮层。
 *
 * 内嵌 pi-tui SelectList（↑↓ 导航 + Enter/Esc 内建）；选项表来自 pi-tui
 * overlays/composer-shape-registry（8 种内置 label/description）；光标移动即时预览
 * （render 每帧读当前选中 → renderComposerPreview 自绘，与实况同色同路径）。
 * 含中文文案 → fullscreen alt-buffer（summary-overlay.ts:66-70 先例），双世界强转同款。
 */
import type { Component, OverlayHandle, TUI } from '@oh-my-pi/pi-tui';
import { SelectList, type SelectItem } from '@oh-my-pi/pi-tui/components/select-list';
import { getSelectListTheme } from '@oh-my-pi/pi-tui/theme/tui-adapters';
import { theme } from '@oh-my-pi/pi-tui/theme';
import { getComposerShapeOptions } from '@oh-my-pi/pi-tui/overlays/composer-shape-registry';
import type { Statusline } from '../app/statusline';
import { renderComposerPreview } from './composer-preview';

export interface ShapeOverlayCallbacks {
  /** Enter 选中；调用方负责应用与 hide */
  onPick: (shape: string) => void;
  /** Esc 取消；调用方负责 hide */
  onCancel: () => void;
}

export class ShapeOverlay implements Component {
  #list: SelectList;
  #current: string;
  #statusline?: Statusline;

  constructor(current: string, callbacks: ShapeOverlayCallbacks, statusline?: Statusline) {
    this.#current = current;
    this.#statusline = statusline;
    const items: SelectItem[] = getComposerShapeOptions().map((o) => ({
      value: o.value,
      label: o.label,
      description: o.description,
    }));
    const listTheme = getSelectListTheme();
    this.#list = new SelectList(items, 8, listTheme, {
      // 自绘行：label + 当前形状 ✓（description 放预览下方，避免窄终端溢出）
      renderItem: ({ item, selected }) => {
        const cursor = selected ? listTheme.selectedPrefix('❯') : ' ';
        const mark = item.value === current ? ' ✓' : '';
        const body = ` ${item.label}${mark}`;
        return [cursor + (selected ? listTheme.selectedText(body) : body)];
      },
    });
    const idx = items.findIndex((i) => i.value === current);
    if (idx >= 0) this.#list.setSelectedIndex(idx);
    this.#list.onSelect = (item) => callbacks.onPick(item.value);
    this.#list.onCancel = () => callbacks.onCancel();
  }

  render(width: number): readonly string[] {
    const shape = this.#list.getSelectedItem()?.value ?? this.#current;
    const option = getComposerShapeOptions().find((o) => o.value === shape);
    const lines: string[] = [
      theme.fg('accent', '选择输入区形状'),
      ...this.#list.render(width),
      '',
      theme.fg('muted', '预览：'),
      ...renderComposerPreview(shape, width, this.#statusline),
    ];
    if (option?.description) lines.push(theme.fg('dim', option.description));
    lines.push(theme.fg('dim', 'Enter 应用 · Esc 取消'));
    return lines;
  }

  handleInput(data: string): void {
    this.#list.handleInput(data);
  }

  /** 测试可观测性 */
  get selectedValue(): string | undefined {
    return this.#list.getSelectedItem()?.value;
  }
}

/** showOverlay 组装：返回 handle（pick/cancel 后统一 hide） */
export function showShapeOverlay(
  tui: TUI,
  current: string,
  callbacks: ShapeOverlayCallbacks,
  statusline?: Statusline,
): OverlayHandle {
  type SrcComponent = Parameters<typeof tui.showOverlay>[0];
  let handle: OverlayHandle | null = null;
  const close = (fn: () => void): void => {
    fn();
    if (handle && !handle.isHidden()) handle.hide();
    handle = null;
  };
  const component = new ShapeOverlay(
    current,
    {
      onPick: (shape) => close(() => callbacks.onPick(shape)),
      onCancel: () => close(() => callbacks.onCancel()),
    },
    statusline,
  );
  // fullscreen: true → alt buffer 渲染（合成基底空白，规避非 fullscreen 浮层
  // 按列拼接含中文背景时的错行；见 summary-overlay.ts:66-70）
  handle = tui.showOverlay(component as unknown as SrcComponent, { fullscreen: true });
  return handle;
}

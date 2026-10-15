/**
 * mode-overlay.ts：/mode 权限模式交互式选择浮层（仿 shape-overlay.ts）。
 *
 * 内嵌 pi-tui SelectList（↑↓ 导航 + Enter/Esc 内建）；选项表来自权限模式单一来源
 * PERMISSION_MODES（面市可切换的 5 值 id + 中文说明），当前模式行尾 ✓ 并预选。渲染含中文文案
 * → fullscreen alt-buffer（规避非 fullscreen 浮层按列拼接时宽字符错行，先例
 * shape-overlay.ts:100-102 / summary-overlay.ts:66-70），双世界强转同款。
 */
import type { Component, OverlayHandle, TUI } from '@oh-my-pi/pi-tui';
import { SelectList, type SelectItem } from '@oh-my-pi/pi-tui/components/select-list';
import { getSelectListTheme } from '@oh-my-pi/pi-tui/theme/tui-adapters';
import { theme } from '@oh-my-pi/pi-tui/theme';
import { PERMISSION_MODES } from '../permission/modes';

export interface ModeOverlayCallbacks {
  /** Enter 选中；调用方负责应用与 hide */
  onPick: (mode: string) => void;
  /** Esc 取消；调用方负责 hide */
  onCancel: () => void;
}

export class ModeOverlay implements Component {
  #list: SelectList;
  #current: string;

  constructor(current: string, callbacks: ModeOverlayCallbacks) {
    this.#current = current;
    const items: SelectItem[] = PERMISSION_MODES.map((m) => ({
      value: m.id,
      label: m.id,
      description: m.description,
    }));
    const listTheme = getSelectListTheme();
    this.#list = new SelectList(items, 8, listTheme, {
      // 自绘行：id + 当前模式 ✓（说明放列表下方，避免窄终端溢出，对齐 shape-overlay）
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
    const mode = this.#list.getSelectedItem()?.value ?? this.#current;
    const entry = PERMISSION_MODES.find((m) => m.id === mode);
    const lines: string[] = [theme.fg('accent', '选择权限模式'), ...this.#list.render(width)];
    if (entry?.description) lines.push(theme.fg('dim', entry.description));
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
export function showModeOverlay(tui: TUI, current: string, callbacks: ModeOverlayCallbacks): OverlayHandle {
  type SrcComponent = Parameters<typeof tui.showOverlay>[0];
  let handle: OverlayHandle | null = null;
  const close = (fn: () => void): void => {
    fn();
    if (handle && !handle.isHidden()) handle.hide();
    handle = null;
  };
  const component = new ModeOverlay(current, {
    onPick: (mode) => close(() => callbacks.onPick(mode)),
    onCancel: () => close(() => callbacks.onCancel()),
  });
  handle = tui.showOverlay(component as unknown as SrcComponent, { fullscreen: true });
  return handle;
}

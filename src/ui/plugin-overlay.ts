/**
 * plugin-overlay.ts — `/plugin` 插件管理浮层（plugin 阶段 P5.4）。
 *
 * 单层列表 + 行内操作（比「列表 → 二级动作菜单」少一次 Enter/一次浮层切换）：
 *   Enter 启停（当前选中） · r 重载 · q/Esc 关闭
 * 渲染含中文文案 → **fullscreen alt-buffer**（规避非 fullscreen 按列拼接宽字符错行，
 * 先例 shape/mode/select-overlay），双世界强转同款。
 *
 * 状态经 `manager.entries()` 每次渲染现读 → 操作完成后 `refresh()` 原地重建行，
 * 浮层不关闭（避免 overlay 链式开关的时序问题）。
 */
import type { Component, OverlayHandle, TUI } from '@oh-my-pi/pi-tui';
import { SelectList, type SelectItem } from '@oh-my-pi/pi-tui/components/select-list';
import { getSelectListTheme } from '@oh-my-pi/pi-tui/theme/tui-adapters';
import { matchesKey } from '@oh-my-pi/pi-tui/keys';
import { theme } from '@oh-my-pi/pi-tui/theme';
import { statusText, type PluginStatusEntry } from '../plugin/manage';

/** 浮层依赖的管理动作（由 main.ts 接线到 PluginHost / installer） */
export interface PluginManager {
  /** 当前插件状态（每次渲染现读） */
  entries(): PluginStatusEntry[];
  /** 启停（返回反馈行文本） */
  toggle(name: string): Promise<string>;
  /** 重载（返回反馈行文本） */
  reload(name: string): Promise<string>;
}

export interface PluginOverlayCallbacks {
  onToggle(name: string): void;
  onReload(name: string): void;
  onClose(): void;
}

export class PluginOverlay implements Component {
  #entries: () => PluginStatusEntry[];
  #list: SelectList;
  #callbacks: PluginOverlayCallbacks;
  #message = '';

  constructor(entries: () => PluginStatusEntry[], callbacks: PluginOverlayCallbacks) {
    this.#entries = entries;
    this.#callbacks = callbacks;
    const listTheme = getSelectListTheme();
    this.#list = new SelectList(this.#items(), 10, listTheme, {
      // 自绘行：名称 + 版本 + 状态（来源放下方说明行，避免窄终端溢出）
      renderItem: ({ item, selected }) => {
        const e = this.#entryOf(item.value);
        const cursor = selected ? listTheme.selectedPrefix('❯') : ' ';
        const ver = e?.version ? ` ${theme.fg('dim', `v${e.version}`)}` : '';
        const status = e ? statusText(e) : '';
        const body = ` ${item.label}${ver}  ${theme.fg('dim', status)}`;
        return [cursor + (selected ? listTheme.selectedText(body) : body)];
      },
    });
    this.#list.onSelect = (item) => callbacks.onToggle(item.value);
    this.#list.onCancel = () => callbacks.onClose();
  }

  #entryOf(name: string): PluginStatusEntry | undefined {
    return this.#entries().find((e) => e.name === name);
  }

  #items(): SelectItem[] {
    return this.#entries().map((e) => ({ value: e.name, label: e.name }));
  }

  /** 操作后原地刷新列表（保留选中项） */
  refresh(): void {
    const cur = this.#list.getSelectedItem()?.value;
    this.#list.setItems(this.#items());
    if (cur) this.#list.setSelectedValue(cur);
  }

  /** 底部反馈行（操作结果 / 处理中） */
  setMessage(message: string): void {
    this.#message = message;
  }

  render(width: number): readonly string[] {
    const selected = this.#list.getSelectedItem()?.value;
    const entry = selected ? this.#entryOf(selected) : undefined;
    const lines: string[] = [theme.fg('accent', '插件'), ...this.#list.render(width)];
    if (entry?.issue) lines.push(theme.fg('warning', `⚠ ${entry.issue}`));
    else if (entry) lines.push(theme.fg('dim', entry.source));
    if (this.#message) lines.push(this.#message);
    lines.push(theme.fg('dim', 'Enter 启停 · r 重载 · q/Esc 关闭'));
    return lines;
  }

  handleInput(data: string): void {
    const name = this.#list.getSelectedItem()?.value;
    if (name && matchesKey(data, 'r')) {
      this.#callbacks.onReload(name);
      return;
    }
    // q 关闭（PTY 冒烟无法投递裸 ESC，见 memory project_pty_testing）
    if (matchesKey(data, 'q')) {
      this.#callbacks.onClose();
      return;
    }
    this.#list.handleInput(data);
  }

  /** 测试可观测性 */
  get selectedName(): string | undefined {
    return this.#list.getSelectedItem()?.value;
  }
}

/** showOverlay 组装：动作异步执行 → 反馈行 + 原地刷新，浮层不关闭 */
export function showPluginOverlay(tui: TUI, manager: PluginManager): OverlayHandle {
  type SrcComponent = Parameters<typeof tui.showOverlay>[0];
  let handle: OverlayHandle | null = null;
  let overlay: PluginOverlay;
  const close = (): void => {
    if (handle && !handle.isHidden()) handle.hide();
    handle = null;
  };
  const run = (fn: (name: string) => Promise<string>, name: string): void => {
    overlay.setMessage(theme.fg('dim', `处理中：${name}…`));
    tui.requestRender();
    void fn(name)
      .then((msg) => overlay.setMessage(msg))
      .catch((e: unknown) => overlay.setMessage(theme.fg('warning', `失败：${e instanceof Error ? e.message : String(e)}`)))
      .finally(() => {
        overlay.refresh();
        tui.requestRender(true);
      });
  };
  overlay = new PluginOverlay(
    () => manager.entries(),
    {
      onToggle: (name) => run(manager.toggle, name),
      onReload: (name) => run(manager.reload, name),
      onClose: close,
    },
  );
  handle = tui.showOverlay(overlay as unknown as SrcComponent, { fullscreen: true });
  return handle;
}

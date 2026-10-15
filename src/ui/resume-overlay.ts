/**
 * resume-overlay.ts（M3.3）：/resume 会话选择浮层。
 *
 * 内嵌 pi-tui SelectList（↑↓ 导航 + Enter onSelect + Esc onCancel 内建），
 * 替代 MVP main.ts 的自绘列表 + 键盘模态分支。overlay 模态吞键天然成立。
 */
import type { Component, OverlayHandle, TUI } from '@oh-my-pi/pi-tui';
import { SelectList, type SelectItem } from '@oh-my-pi/pi-tui/components/select-list';
import { getSelectListTheme } from '@oh-my-pi/pi-tui/theme/tui-adapters';
import { theme } from '@oh-my-pi/pi-tui/theme';
import type { SessionMeta } from '../session-store/jsonl';

export interface ResumeOverlayCallbacks {
  /** 选中会话（sessionId）；调用方负责 hide */
  onPick: (sessionId: string) => void;
  /** Esc 取消；调用方负责 hide */
  onCancel: () => void;
}

function formatMtime(mtime: number): string {
  const d = new Date(mtime);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export class ResumeOverlay implements Component {
  #list: SelectList;

  constructor(metas: readonly SessionMeta[], callbacks: ResumeOverlayCallbacks) {
    const items: SelectItem[] = metas.map((m) => ({
      value: m.sessionId,
      label: formatMtime(m.mtime),
      description: m.title,
    }));
    this.#list = new SelectList(items, 10, getSelectListTheme());
    this.#list.onSelect = (item) => callbacks.onPick(item.value);
    this.#list.onCancel = () => callbacks.onCancel();
  }

  render(width: number): readonly string[] {
    return [
      theme.fg('accent', '恢复会话') + theme.fg('dim', '（↑↓ 选择，Enter 确认，Esc 取消）'),
      ...this.#list.render(width),
    ];
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
export function showResumeOverlay(
  tui: TUI,
  metas: readonly SessionMeta[],
  callbacks: ResumeOverlayCallbacks,
): OverlayHandle {
  let handle: OverlayHandle | null = null;
  const close = (fn: () => void): void => {
    fn();
    if (handle && !handle.isHidden()) handle.hide();
    handle = null;
  };
  handle = tui.showOverlay(
    new ResumeOverlay(metas, {
      onPick: (sid) => close(() => callbacks.onPick(sid)),
      onCancel: () => close(() => callbacks.onCancel()),
    }),
    { anchor: 'bottom-center', width: '80%' },
  );
  return handle;
}

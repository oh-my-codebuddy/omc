/**
 * model-overlay.ts：交互式模型选择浮层（对齐 codebuddy /model 观感）。
 *
 * 两个使用方：
 *  - `/model` —— 主模型（Global/Session 双作用域）
 *  - `/model:lite` `/model:reasoning` —— **场景变体**（variant 模式，P1 追加）：
 *    固定写用户级 settings（无作用域页签），首行多一条「继承主模型」条目
 *    （变体的解析链允许落回 `relatedModels`/继承，所以必须能选回来）。
 *
 * 字段与 codebuddy 相同：名称（主列） + [model-id]（描述列） + (xN.NN credits)
 * （state 列右对齐），`currentValue` 行 state 尾加 ✓。Tab/←→ 切域（变体模式无此行为），
 * Enter 应用，Esc 取消。内嵌 pi-tui SelectList（↑↓ 导航 + Enter/Esc 内建），
 * overlay 模态吞键天然成立。
 */
import type { Component, OverlayHandle, TUI } from '@oh-my-pi/pi-tui';
import { SelectList, type SelectItem } from '@oh-my-pi/pi-tui/components/select-list';
import { getSelectListTheme } from '@oh-my-pi/pi-tui/theme/tui-adapters';
import { matchesKey } from '@oh-my-pi/pi-tui/keys';
import { theme } from '@oh-my-pi/pi-tui/theme';
import { INHERIT_SENTINEL } from '../app/model-variants';

export type ModelScope = 'global' | 'session';

export interface ModelEntry {
  id: string;
  name: string;
  /** 已格式化的倍率串（如 "x0.79"）；缺省该行不显示积分列 */
  credits?: string;
  /** id 列显示文本（默认 `[id]`）；变体的「继承」条目用它显示 `[default]` */
  displayId?: string;
}

export interface ModelOverlayCallbacks {
  /** Enter 选中；调用方负责应用与 hide */
  onPick: (modelId: string, scope: ModelScope) => void;
  /** Esc 取消；调用方负责 hide */
  onCancel: () => void;
}

export interface ModelOverlayOptions {
  /** 标题（默认 `Select Model`） */
  title?: string;
  /**
   * **变体模式**（`/model:lite` `/model:reasoning`）：不渲染 Global/Session 页签、
   * 不响应 Tab/←→（变体固定写用户级），首行插入「继承」条目（value = `INHERIT_SENTINEL`）。
   * 此时 `onPick` 的 scope 恒为 `'global'`。
   */
  variant?: {
    /** 副标题（当前指向与来源） */
    hint: string;
    /** 首行「继承」条目文案（默认 `↺ 继承主模型`） */
    inheritLabel?: string;
  };
}

const MAX_VISIBLE = 16;

/** 显示宽度对齐（中文名占 2 列） */
function pad(s: string, width: number): string {
  const w = Bun.stringWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

/** 截到指定显示宽度（超出以 … 收尾，codebuddy 对长 id 同款处理） */
function trunc(s: string, width: number): string {
  if (Bun.stringWidth(s) <= width) return pad(s, width);
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = Bun.stringWidth(ch);
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…${' '.repeat(Math.max(0, width - w - 1))}`;
}

export class ModelOverlay implements Component {
  #list: SelectList;
  #scope: ModelScope = 'global';
  #callbacks: ModelOverlayCallbacks;
  #opts: ModelOverlayOptions;
  #marked: string;
  #values: string[];

  constructor(
    models: readonly ModelEntry[],
    currentModel: string,
    callbacks: ModelOverlayCallbacks,
    opts: ModelOverlayOptions = {},
  ) {
    this.#callbacks = callbacks;
    this.#opts = opts;
    // 变体的「继承」条目与真实模型同列展示，故用 displayId 承载显示文本
    const all: ModelEntry[] = opts.variant
      ? [
          { id: INHERIT_SENTINEL, name: opts.variant.inheritLabel ?? '↺ 继承主模型', displayId: '[default]' },
          ...models,
        ]
      : [...models];
    // `currentModel` 语义 = 「打 ✓ 且预选」的那个 value（变体模式下可能 = INHERIT_SENTINEL）
    this.#marked = currentModel;
    this.#values = all.map((m) => m.id);
    const creditsOf = new Map(all.map((m) => [m.id, m.credits]));
    const displayIdOf = new Map(all.map((m) => [m.id, m.displayId ?? `[${m.id}]`]));
    const items: SelectItem[] = all.map((m) => ({
      value: m.id,
      label: m.name,
      description: displayIdOf.get(m.id) ?? '',
    }));
    // 行版式对齐 codebuddy /model：> 名称  [id]  (xN.NN credits) ✓（积分列右对齐，
    // 当前模型 ✓ 尾随）。自绘行而不依赖 SelectItem.state——state 只在 native
    // describe 路径渲染，overlay 的 ANSI render 路径不可见。
    // 窄终端按名称/id 顺序截断保积分列（80% 宽 overlay 在 80 列终端只有 ~64 列可用）
    const nameW = Math.max(...all.map((m) => Bun.stringWidth(m.name)), 1);
    const idW = Math.max(...all.map((m) => Bun.stringWidth(displayIdOf.get(m.id) ?? '')), 1);
    const rightOf = (id: string): string =>
      (creditsOf.get(id) ? `(${creditsOf.get(id)} credits)` : '') + (id === this.#marked ? ' ✓' : '');
    const rightW = Math.max(...all.map((m) => Bun.stringWidth(rightOf(m.id))), 1);
    const listTheme = getSelectListTheme();
    this.#list = new SelectList(items, MAX_VISIBLE, listTheme, {
      renderItem: ({ item, selected, width }) => {
        const right = rightOf(item.value);
        const avail = Math.max(16, width - 2 - rightW - 2); // 光标+空格 & 与积分列间距
        const idWc = Math.min(idW, Math.max(10, Math.floor(avail * 0.5)));
        const nameWc = Math.max(6, avail - idWc - 2);
        const left = `${trunc(item.label, Math.min(nameW, nameWc))}  ${trunc(displayIdOf.get(item.value) ?? '', idWc)}`;
        const gap = Math.max(2, width - 2 - Bun.stringWidth(left) - Bun.stringWidth(right));
        const cursor = selected ? listTheme.selectedPrefix('❯') : ' ';
        const body = ` ${left}${' '.repeat(gap)}${right}`;
        return [cursor + (selected ? listTheme.selectedText(body) : body)];
      },
    });
    // 预选当前（codebuddy 观感：光标落在当前行）
    const cur = items.findIndex((i) => i.value === this.#marked);
    if (cur >= 0) this.#list.setSelectedIndex(cur);
    this.#list.onSelect = (item) => this.#callbacks.onPick(item.value, this.#scope);
    this.#list.onCancel = () => this.#callbacks.onCancel();
  }

  render(width: number): readonly string[] {
    if (this.#opts.variant) {
      return [
        `${theme.fg('accent', this.#opts.title ?? 'Select Model')}  ${theme.fg('dim', this.#opts.variant.hint)}`,
        ...this.#list.render(width),
        theme.fg('dim', 'Enter to apply · Esc to exit · 改值需重启 omc 会话生效'),
      ];
    }
    const tab = (label: string, active: boolean): string =>
      active ? theme.fg('accent', ` ${label} `) : theme.fg('dim', ` ${label} `);
    return [
      `${theme.fg('accent', this.#opts.title ?? 'Select Model')}  ${tab('Global', this.#scope === 'global')}  ${tab('Session', this.#scope === 'session')}${theme.fg('dim', '  (Tab/←→ to switch)')}`,
      theme.fg(
        'dim',
        this.#scope === 'global'
          ? 'Select a model for all future sessions.'
          : 'Select a model for this session only.',
      ),
      ...this.#list.render(width),
      theme.fg('dim', 'Enter to apply model · Tab to switch scope · Esc to exit'),
    ];
  }

  handleInput(data: string): void {
    // 变体模式无作用域概念（固定写用户级），Tab/←→ 不切域
    if (
      !this.#opts.variant &&
      (matchesKey(data, 'tab') || matchesKey(data, 'left') || matchesKey(data, 'right'))
    ) {
      this.#scope = this.#scope === 'global' ? 'session' : 'global';
      return;
    }
    this.#list.handleInput(data);
  }

  /** 测试可观测性 */
  get selectedValue(): string | undefined {
    return this.#list.getSelectedItem()?.value;
  }

  get scope(): ModelScope {
    return this.#scope;
  }

  /** 列表条目 value（测试可观测性；变体模式含首行「继承」） */
  get values(): string[] {
    return this.#values;
  }
}

/** showOverlay 组装：返回 handle（pick/cancel 后统一 hide） */
export function showModelOverlay(
  tui: TUI,
  models: readonly ModelEntry[],
  currentModel: string,
  callbacks: ModelOverlayCallbacks,
  opts: ModelOverlayOptions = {},
): OverlayHandle {
  let handle: OverlayHandle | null = null;
  const close = (fn: () => void): void => {
    fn();
    if (handle && !handle.isHidden()) handle.hide();
    handle = null;
  };
  handle = tui.showOverlay(
    new ModelOverlay(models, currentModel, {
      onPick: (id, scope) => close(() => callbacks.onPick(id, scope)),
      onCancel: () => close(() => callbacks.onCancel()),
    }, opts),
    { anchor: 'bottom-center', width: '80%' },
  );
  return handle;
}

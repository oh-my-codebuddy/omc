/**
 * skills-overlay.ts — `/skills` 只读列表浮层（skill-system P4.3）。
 *
 * 定位：让用户看到**本机全部 skill 全貌**（含 `user-invocable: false` 的隐藏项），
 * 按发现来源分组。数据源 = `collectSkillEntries()`（全量），区别于 `/` 补全用的
 * `skillMap`（已过滤隐藏项）——这正是它的价值：发现「有但不可 / 调用」的条目。
 *
 * **不是** CLI 的 `skills` slash command（那是 CLI 进程内的管理菜单，omc 会话
 * `settingSources: []` 下命令面也不同步）——本浮层是 omc 自读磁盘的只读视图，
 * 标题与提示行都写明，避免混淆。
 *
 * 复用 select-overlay 范式：内嵌 pi-tui `SelectList`（↑↓ 导航 + 溢出时输入过滤）。
 * 退出键语义在 `handleInput` 里自管：**Esc 两段**（搜索中先退搜索、无过滤词才关闭）、
 * `q` 仅无过滤词时关闭（过滤中要能搜 `q` 开头的 skill）、Ctrl+C 由 `SelectList` cancel 兜底关闭。
 * 渲染含中文 → **fullscreen alt-buffer**（规避非 fullscreen 按列
 * 拼接宽字符错行，先例 shape/mode/summary-overlay），双世界强转同款。
 *
 * 分组渲染：来源表头是 `disabled` 行（导航自动跳过，`MenuSelection.#coerceIndex`），
 * skill 行两行（name + description / 路径）。本浮层只有一层——若未来加「进入某
 * skill 看详情」的第二层，**必须**遵守「先 hide 后回调」（见 select-overlay.ts 头注）。
 */
import type { Component, OverlayHandle, TUI } from '@oh-my-pi/pi-tui';
import { SelectList, type SelectItem } from '@oh-my-pi/pi-tui/components/select-list';
import { getSelectListTheme } from '@oh-my-pi/pi-tui/theme/tui-adapters';
import { matchesKey } from '@oh-my-pi/pi-tui/keys';
import { theme } from '@oh-my-pi/pi-tui/theme';
import { Ellipsis, truncateMiddleToWidth, truncateToWidth } from '@oh-my-pi/pi-tui/render/render-utils.js';
import type { SkillEntry, SkillSource } from '../app/context-data';

/** 来源显示顺序（与 `skillScanRoots` 优先级一致：project → user → agents → plugin → builtin） */
export const SKILL_SOURCE_ORDER: SkillSource[] = ['project', 'user', 'agents', 'plugin', 'builtin'];

const SOURCE_LABEL: Record<SkillSource, string> = {
  project: '项目',
  user: '用户',
  agents: 'agents',
  plugin: '插件',
  builtin: 'builtin',
};

/** 浮层条目：`group` 是来源表头（disabled，导航跳过），`skill` 是可浏览的 skill 行 */
export interface SkillsOverlayItem extends SelectItem {
  kind: 'group' | 'skill';
  /** 来源（group 表头与 skill 行都带） */
  source: SkillSource;
  /** `user-invocable: false`（仅标注灰显，不隐藏、不需过滤） */
  hidden?: boolean;
  /** 绝对路径（skill 行第二行显示） */
  filePath?: string;
}

/** skill 行的稳定 value（避免与 group 的 `__group__:` 冲突） */
function skillValue(name: string): string {
  return `skill:${name}`;
}

/**
 * 纯函数：全量条目 → 浮层条目（按来源分组，来源内保持发现顺序 = 浅层/字典序 first-wins）。
 * 无条目的来源不出现；每条 skill 都有一行（含 `user-invocable:false` 的隐藏项）。
 */
export function buildSkillsOverlayItems(entries: readonly SkillEntry[]): SkillsOverlayItem[] {
  const bySource = new Map<SkillSource, SkillEntry[]>();
  for (const e of entries) {
    const list = bySource.get(e.source);
    if (list) list.push(e);
    else bySource.set(e.source, [e]);
  }
  const out: SkillsOverlayItem[] = [];
  for (const source of SKILL_SOURCE_ORDER) {
    const list = bySource.get(source);
    if (!list || list.length === 0) continue;
    out.push({
      kind: 'group',
      source,
      value: `__group__:${source}`,
      label: `${SOURCE_LABEL[source]}（${list.length}）`,
      description: '',
      disabled: true,
    });
    for (const e of list) {
      out.push({
        kind: 'skill',
        source,
        value: skillValue(e.name),
        label: e.name,
        description: e.description,
        hidden: e.userInvocable === false,
        filePath: e.filePath,
      });
    }
  }
  return out;
}

/** 隐藏项标注（`user-invocable: false`：`/` 补全与 `/skill:` 触发都不可见） */
export const HIDDEN_MARK = ' (user-invocable: false)';

export class SkillsOverlay implements Component {
  #list: SelectList;
  #meta: Map<string, SkillsOverlayItem>;
  #total: number;
  #hidden: number;
  #onClose: () => void;

  constructor(entries: readonly SkillEntry[], onClose: () => void, terminalRows?: number) {
    this.#onClose = onClose;
    const items = buildSkillsOverlayItems(entries);
    this.#total = items.filter((i) => i.kind === 'skill').length;
    this.#hidden = items.filter((i) => i.kind === 'skill' && i.hidden).length;
    this.#meta = new Map(items.map((i) => [i.value, i]));
    this.#list = new SelectList(items, visibleRowBudget(items, terminalRows), getSelectListTheme(), {
      search: 'overflow',
      emptyText: '（未发现 skill）',
      noMatchText: '（无匹配）',
      renderItem: (ctx) => this.#renderRow(ctx.item.value, ctx.width, ctx.selected),
      measureItem: (ctx) => (this.#meta.get(ctx.item.value)?.kind === 'group' ? 1 : 2),
    });
    // 首项是来源表头（disabled）→ 选中落到第一个 skill 行（否则光标停在表头上）
    const first = items.findIndex((i) => i.kind === 'skill');
    if (first >= 0) this.#list.setSelectedIndex(first);
    // 只读：Enter 不触发任何动作（不设 onSelect）；Ctrl+C 由 SelectList 的 cancel 兜底关闭
    this.#list.onCancel = () => this.#onClose();
  }

  #renderRow(value: string, width: number, selected: boolean): readonly string[] {
    const item = this.#meta.get(value);
    if (!item) return [];
    const cursor = selected ? `${theme.fg('accent', '❯')} ` : '  ';
    if (item.kind === 'group') {
      return [theme.fg('accent', `▍${item.label}`)];
    }
    const name = theme.fg('toolTitle', item.label);
    const mark = item.hidden ? theme.fg('dim', HIDDEN_MARK) : '';
    const desc = item.description ? `  ${theme.fg('dim', item.description)}` : '';
    const row = `${cursor}${item.hidden ? theme.fg('dim', item.label) : name}${mark}${desc}`;
    const path = item.filePath ?? '';
    return [
      truncateToWidth(row, width, Ellipsis.Omit),
      path ? `${'  '}${theme.fg('dim', truncateMiddleToWidth(path, Math.max(8, width - 2)))}` : '',
    ];
  }

  render(width: number): readonly string[] {
    const title = theme.fg(
      'accent',
      `Skills — omc 只读列表（共 ${this.#total} 个${this.#hidden > 0 ? `，其中 ${this.#hidden} 个隐藏` : ''}）`,
    );
    return [
      title,
      ...this.#list.render(width),
      theme.fg('dim', '输入过滤 · ↑↓ 导航 · Esc 退出搜索/关闭 · q 关闭 · 本地调用用 /skill:<name>'),
    ];
  }

  handleInput(data: string): void {
    // Esc **两段语义**（用户 2026-10-09 验收反馈）：搜索中先退出搜索（清过滤），
    // 无过滤词时才关闭。必须在委托 SelectList 之前拦——SelectList 的 cancel
    // 分支（escape/ctrl+c）只调 onCancel，不会退搜索态。
    if (matchesKey(data, 'escape')) {
      if (this.#list.getFilter().length > 0) this.#list.setFilter('');
      else this.#onClose();
      return;
    }
    // q 关闭同样只在无过滤词时生效，避免抢占搜索输入（过滤中「q」必须进搜索框）
    if (matchesKey(data, 'q') && this.#list.getFilter().length === 0) {
      this.#onClose();
      return;
    }
    this.#list.handleInput(data);
  }

  /** 测试可观测性 */
  get selectedValue(): string | undefined {
    return this.#list.getSelectedItem()?.value;
  }
}

/**
 * 列表可见行预算（**视觉行**，非条目数）：表头 1 行、skill 行 2 行。
 * 终端行数 − 标题/提示/余量；小列表全显（不出滚动条），大列表才滚动。
 * @param terminalRows 终端总行数；未定义（非 TTY）→ 按 24 行计
 */
function visibleRowBudget(items: readonly SkillsOverlayItem[], terminalRows?: number): number {
  const rows = terminalRows && terminalRows > 0 ? terminalRows : 24;
  const available = Math.max(3, rows - 4);
  const need = items.reduce((n, i) => n + (i.kind === 'group' ? 1 : 2), 0);
  return Math.max(1, Math.min(need, available));
}

export function showSkillsOverlay(tui: TUI, entries: readonly SkillEntry[]): OverlayHandle {
  type SrcComponent = Parameters<typeof tui.showOverlay>[0];
  let handle: OverlayHandle | null = null;
  const close = (): void => {
    if (handle && !handle.isHidden()) handle.hide();
    handle = null;
    tui.requestRender();
  };
  const component = new SkillsOverlay(entries, close, tui.terminal.rows);
  handle = tui.showOverlay(component as unknown as SrcComponent, { fullscreen: true });
  return handle;
}

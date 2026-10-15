/**
 * usage-overlay.ts（ux-port P4.4）：/usage dashboard overlay。
 * pi-tui 内建 UsageDashboardComponent（18.4.4 src/overlays/usage-dashboard.ts:559）：
 * - reports 传空：SDK 无订阅配额 API，配额卡走空态（idle 分支）
 * - loadActivity 喂 P4.3 usage-daily.jsonl 按日聚合（同步读盘，push 一次即 resolve）
 * - renderDetail 画 session 累计（/cost 同款口径 + 当前上下文占用）
 * 键位组件内建：q/Esc 关（detail 视图先退 overview）、r 刷新（无 refresh 回调时无效）、
 * Enter/Tab/d 进 detail、↑↓/PgUp/PgDn 滚动。
 * 双世界强转同 app.ts ctrl+r 先例（app.ts:285-301）：运行时同一套 src 类。
 */
import type { TUI } from '@oh-my-pi/pi-tui';
import { UsageDashboardComponent } from '@oh-my-pi/pi-tui/overlays/usage-dashboard.js';
import type { Statusline } from '../app/statusline';
import { loadUsageDaily } from '../app/usage-daily';

// 取型用 ConstructorParameters（AGENTS.md：避免深路径 import 落回 dist 世界）
type DashboardOptions = ConstructorParameters<typeof UsageDashboardComponent>[0];

export function showUsageOverlay(tui: TUI, statusline: Statusline): void {
  type SrcComponent = Parameters<typeof tui.showOverlay>[0];
  let handle: { hide(): void } | null = null;

  const renderDetail = (): string => {
    const s = statusline.stats();
    const ctx = statusline.contextUsage();
    const ctxLine =
      ctx.used !== undefined && ctx.window
        ? `  当前上下文  ${ctx.used.toLocaleString()} / ${ctx.window.toLocaleString()}（${Math.round((ctx.used / ctx.window) * 100)}%）`
        : ctx.used !== undefined
          ? `  当前上下文  ${ctx.used.toLocaleString()} tokens`
          : '  当前上下文  未知（本轮对话后显示）';
    return [
      '本会话累计（含 resume 恢复的历史）',
      `  轮数        ${s.turns}`,
      `  输入 tokens ${s.inputTokens.toLocaleString()}`,
      `  输出 tokens ${s.outputTokens.toLocaleString()}`,
      `  费用        $${s.costUsd.toFixed(4)}`,
      '',
      ctxLine,
      '',
      '配额卡片为空态：SDK 无订阅配额 API，以上仅为本地统计。',
    ].join('\n');
  };

  const options: DashboardOptions = {
    reports: [],
    renderDetail,
    loadActivity: (push) => {
      push(loadUsageDaily());
      return Promise.resolve();
    },
    requestRender: () => tui.requestRender(),
    onClose: () => {
      handle?.hide();
      handle = null;
      tui.requestRender();
    },
  };
  handle = tui.showOverlay(new UsageDashboardComponent(options) as unknown as SrcComponent);
}

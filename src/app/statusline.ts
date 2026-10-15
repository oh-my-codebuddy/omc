/**
 * statusline.ts — 状态栏（P6.4）：viewport 底部；statusline 阶段起支持配置化多行布局。
 *
 * 默认单行 ` model | mode | tokens(in/out 累计) | ctx | cwd | git branch `
 * - model/mode：由 main 传 getter（system_init 与 /model /mode 改动自动反映）
 * - tokens：ResultEvent usage 累计（resume 重放的历史 result 也计入，符合「恢复现场」直觉）
 * - git branch：启动查一次 + 30s 轮询；非 git 目录省略该段
 * 只用 Node 标准 API（execFile 无 shell）。
 *
 * statusline 阶段：渲染走 statusline-layout 纯函数引擎（最多两行、左右分组、
 * 分隔符/DIM 可配，见 config.statusline），段渲染查 statusline-segments 注册表；
 * 无配置时输出与重构前逐字节一致。
 */
import { execFile } from 'node:child_process';
import type { StatuslineConfig } from '../config';
import { sessionTitle } from '../session-store/jsonl';
import { type ResolvedLayout, renderGroupAt, renderRowAt, renderRows, resolveLayout } from './statusline-layout';
import { isKnownSegment, renderSegment, type SegmentCtx } from './statusline-segments';

/** token 紧凑格式（1M/12.5k/1.20k；ux-port-v2 P5.2 /stats 复用同款） */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}k`;
  return String(n);
}

export class Statusline {
  private inputTokens = 0;
  private outputTokens = 0;
  private turns = 0;
  private costUsd = 0;
  private branch: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** statusline 阶段 P3：time 段分钟级刷新定时器（仅布局含 time 段时启动） */
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  /** statusline 阶段 P3：session 段数据源（system_init 写入；experimental，UUID 截前 8 位显示） */
  private sessionId: string | undefined;
  /** session_name 段缓存（sidecar/首条 user 消息解析结果；undefined = 隐藏） */
  private sessionName: string | undefined;
  /** ux-port P3.3：vim 段（undefined = vim 关，不显示） */
  private vim: { mode: string; pending: string } | undefined;
  /** ux-port P4.2：末次 API 调用的上下文占用（input+cache 读/写；undefined = 尚无数据不显示） */
  private contextTokens: number | undefined;
  /** ux-port P4.2：当前模型上下文窗口（未知时 context 段只显示用量不显示百分比） */
  private contextWindow: number | undefined;
  /**
   * P4.2 三修：system 基线估计 = 历史最小 context（首轮 ≈ system+首消息，首消息可忽略）。
   * manual compact 完成时用 baseline+summary 估算压缩后 context 立即刷新（实测误差 <2%），
   * 下一轮真实 usage 到达后自然校正。估算值不进入 min，避免污染基线。
   */
  private contextBaseline: number | undefined;
  /** statusline 阶段 P2：构造时解析一次（配置无热更新，重启生效） */
  private readonly layout: ResolvedLayout;
  private readonly semantic: boolean;

  constructor(
    private readonly cwd: string,
    private readonly getModel: () => string,
    private readonly getMode: () => string,
    config?: StatuslineConfig,
  ) {
    this.layout = resolveLayout(config);
    this.semantic = this.layout.semantic;
  }

  /**
   * 累计一轮 usage（result 事件；无 usage 忽略）。
   * 注意此 CLI 的 result.usage 是**会话累计值**（2026-10-01 真机实证单调递增），
   * 故 in/out/cost 用覆盖语义（语义即「会话总消耗」，resume 重放天然幂等）；
   * context 段不由它驱动（累计值算 context 会轮轮翻倍），走 setContextUsage。
   */
  addUsage(usage: { inputTokens: number; outputTokens: number; totalCostUsd?: number }): void {
    this.inputTokens = usage.inputTokens;
    this.outputTokens = usage.outputTokens;
    this.turns += 1;
    this.costUsd = usage.totalCostUsd ?? this.costUsd;
    // session_name：首轮后首条 user 消息已落盘，补解析回落标题（已有标题则不动，等 /rename 显式刷新）
    if (this.sessionName === undefined) this.resolveSessionName();
  }

  /** ux-port P4.2：末次 API 调用用量（context_usage 事件驱动，含 cache 即为当前上下文占用） */
  setContextUsage(usage: {
    inputTokens: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  }): void {
    this.contextTokens =
      usage.inputTokens + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
    if (this.contextBaseline === undefined || this.contextTokens < this.contextBaseline) {
      this.contextBaseline = this.contextTokens;
    }
  }

  /**
   * P4.2 三修：manual compact 完成时估算压缩后 context（= system 基线 + summary tokens）
   * 立即刷新；无基线（compact 发生在任何真实调用前，不可能但兜底）则不动作。
   */
  estimatePostCompact(summaryTokens: number): void {
    if (this.contextBaseline === undefined) return;
    this.contextTokens = this.contextBaseline + summaryTokens;
  }

  /** ux-port P4.2：模型窗口（init/切模型时由 main 异步查询后写入） */
  setContextWindow(w: number | undefined): void {
    this.contextWindow = w;
  }

  /** ux-port P4.4：/usage detail 用 —— 末次上下文占用（undefined = 尚无数据）与窗口 */
  contextUsage(): { used?: number; window?: number } {
    return {
      ...(this.contextTokens !== undefined ? { used: this.contextTokens } : {}),
      ...(this.contextWindow !== undefined ? { window: this.contextWindow } : {}),
    };
  }

  /**
   * ux-port-v2 P1.2：/context 报告用 —— system 基线（历史最小 context，
   * 首轮 ≈ system+首消息）。undefined = 首轮前（与 used 同生共死，
   * setContextUsage 里两者同时赋值，故 used 有值时它必有值）。
   */
  contextBaselineValue(): number | undefined {
    return this.contextBaseline;
  }

  /** /cost 统计（P6.6）：轮数/token/费用，含 resume 重放累计 */
  stats(): { turns: number; inputTokens: number; outputTokens: number; costUsd: number } {
    return {
      turns: this.turns,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      costUsd: this.costUsd,
    };
  }

  /**
   * clear 阶段 P1.1：会话重置（`/clear` = 开始新对话）——清空**会话级**累计
   * （轮数 / token / 费用 / 上下文占用与基线 / session id 与标题）。
   * 新会话要重新从零显示（否则 `/clear` 后仍显示旧用量，用户以为没清）。
   * `contextWindow`（模型属性）与 `branch`/`layout` 保留。
   */
  reset(): void {
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.turns = 0;
    this.costUsd = 0;
    this.contextTokens = undefined;
    this.contextBaseline = undefined;
    this.sessionId = undefined;
    this.sessionName = undefined;
  }

  /** vim 模式段（ux-port P3.3）：mode 为 pi-tui VimMode 小写串，转大写显示 */
  setVimStatus(status: { mode: string; pending: string } | undefined): void {
    this.vim = status;
  }

  /** statusline 阶段 P3：session 段数据源（system_init 事件写入） */
  setSessionId(id: string | undefined): void {
    this.sessionId = id;
    this.sessionName = undefined;
    this.resolveSessionName();
  }

  /**
   * session_name 段解析（sidecar 优先 → 首条 user 消息回落；「(无用户消息)」隐藏）。
   * 布局不含 session_name 段时零 IO。缓存制：setSessionId / 首轮后（addUsage）/ /rename 三处触发。
   */
  private resolveSessionName(): void {
    if (!this.usesSegment('session_name') || !this.sessionId) return;
    const title = sessionTitle(this.cwd, this.sessionId);
    this.sessionName = title && title !== '(无用户消息)' ? title : undefined;
  }

  /** /rename 写 sidecar 后调用：重新解析（调用方负责触发重绘） */
  refreshSessionName(): void {
    this.resolveSessionName();
  }

  /** 布局是否含某段（决定是否启 time 定时器等按需资源）；id 可为内置段或 `plugin:<id>` */
  private usesSegment(id: string): boolean {
    return this.layout.rows.some((r) => r.left.includes(id) || r.right.includes(id));
  }

  /**
   * 布局里**无法渲染**的段 id（写错 / 插件未装或已卸载）。
   * 调用方（main）据此打一行 warning —— 注意**只跳过该段**，不丢弃整块 statusline 配置。
   */
  unknownSegments(): string[] {
    const ids = this.layout.rows.flatMap((r) => [...r.left, ...r.right]);
    return [...new Set(ids)].filter((id) => !isKnownSegment(id));
  }

  /** 启动 git 轮询（立即一次 + 每 30s）；branch 变化时回调 onChange */
  start(onChange: () => void): void {
    const poll = (): void => {
      execFile(
        'git',
        ['branch', '--show-current'],
        { cwd: this.cwd, timeout: 3000 },
        (err, stdout) => {
          const b = err ? null : stdout.trim() || null;
          if (b !== this.branch) {
            this.branch = b;
            onChange();
          }
        },
      );
    };
    poll();
    this.timer = setInterval(poll, 30_000);
    this.timer.unref?.(); // 不拖累退出
    // time 段：分钟级刷新（与 git 轮询同模式，unref 不拖累退出）
    if (this.usesSegment('time')) {
      this.clockTimer = setInterval(onChange, 60_000);
      this.clockTimer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.clockTimer) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
  }

  /** 构造渲染上下文（各段数据快照） */
  #ctx(): SegmentCtx {
    return {
      ...(this.vim !== undefined ? { vim: this.vim } : {}),
      model: this.getModel(),
      mode: this.getMode(),
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      turns: this.turns,
      costUsd: this.costUsd,
      ...(this.contextTokens !== undefined ? { contextTokens: this.contextTokens } : {}),
      ...(this.contextWindow !== undefined ? { contextWindow: this.contextWindow } : {}),
      cwd: this.cwd,
      branch: this.branch,
      ...(this.sessionId !== undefined ? { sessionId: this.sessionId } : {}),
      ...(this.sessionName !== undefined ? { sessionName: this.sessionName } : {}),
      semantic: this.semantic,
      segmentColors: this.layout.segments,
      icons: this.layout.icons,
      now: new Date(),
    };
  }

  /** 渲染（可多行，`\n` 连接；默认布局与重构前逐字节一致） */
  render(width: number): string {
    const ctx = this.#ctx();
    return renderRows(this.layout, (id) => renderSegment(id, ctx), width);
  }

  /** 行数（composer-shape 阶段：按行映射用） */
  get rowCount(): number {
    return this.layout.rows.length;
  }

  /** 只渲染第 i 行（composer-shape 阶段：顶 chrome 注入 / 编辑器下方块；越界 null） */
  renderRow(width: number, i: number): string | null {
    const ctx = this.#ctx();
    return renderRowAt(this.layout, (id) => renderSegment(id, ctx), width, i);
  }

  /** 只渲染第 i 行某一组（composer-shape 阶段：chip = row0 右组） */
  renderRowGroup(width: number, i: number, group: 'left' | 'right'): string | null {
    const ctx = this.#ctx();
    return renderGroupAt(this.layout, (id) => renderSegment(id, ctx), width, i, group);
  }
}

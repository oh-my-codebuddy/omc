/**
 * SkillCallCard（skill-system P4.1）：**模型自主调用** `Skill` 工具时的专用卡。
 *
 * 为什么自研：pi-tui 的 `toolRenderers` 无 `Skill` 项（`node_modules/@oh-my-pi/pi-tui/src/tools/index.ts`）
 * → 落 `renderDefaultToolExecution`，把**整篇 SKILL.md 文本**灌进通用工具卡（几百行、超高、
 * 触发退休冻结）。本卡只做「不拦 + 画对卡」：标题行 + 折叠正文。
 *
 * 与**本地** `/skill:name` 的 `SkillMessageComponent` 是两套东西，不要混：
 * 那条路径是 user-attributed message（用户触发、落盘格式不同），本卡是 tool card
 * （模型触发）。文案上明确标 `(模型自主调用)`，避免用户误以为是自己触发的。
 *
 * 治本约束（同 DiffCard / CompactSummaryCard）：
 * - **单组件**：Disclosure 一次 render 返回整块行数组，不逐行 addChild（否则 TranscriptContainer
 *   在块间插空行把卡片断线）。
 * - **展开限高**：SKILL.md 常几百行 → 正文经 `CappedMarkdown` 同款**真渲染计数**截断
 *   （视口 − 14，下限 6）：超屏块退休进原生 scrollback 后 ctrl+o 折不动（退休冻结）。
 *
 * 与工具卡同鸭子面（bridge 统一调用）：`setArgsComplete` / `setExecutionStarted` /
 * `setExpanded` / `updateResult` / `seal` / `invalidate` / `render`。
 */
import { getMarkdownTheme, theme } from '@oh-my-pi/pi-tui';
import { Disclosure } from '@oh-my-pi/pi-tui/components/disclosure';
import { Box } from '@oh-my-pi/pi-tui/components/box';
import { Markdown } from '@oh-my-pi/pi-tui/components/markdown';
import { Text } from '@oh-my-pi/pi-tui/components/text';
import { expandKeyHint } from '@oh-my-pi/pi-tui/render/render-utils.js';
import { skillChipLabel, skillChipStyle } from '@oh-my-pi/pi-tui/prompt/composer-attachments.js';
import type { DetailRowCap } from './compact-summary-card';

/** 展开正文默认限高（未注入视口函数时的固定值；远小于一屏，防退休冻结） */
export const SKILL_CALL_CARD_MAX_DETAIL_ROWS = 24;

export interface SkillCallCardOptions {
  /** 目标 skill 名（`Skill` 直调取 input.skill；`DeferExecuteTool` 包装由 bridge 拆包后传入） */
  skillName: string;
  /** 透传的 args（可空） */
  args?: string;
  /** 展开正文行数上限（固定值或视口函数；缺省 SKILL_CALL_CARD_MAX_DETAIL_ROWS） */
  maxDetailRows?: DetailRowCap;
  /** 初始展开（缺省 false：Skill 正文是次要信息，默认折叠） */
  expanded?: boolean;
}

/** 单行裁剪（首行 + 省略号） */
function clip(s: string, max: number): string {
  const flat = s.split('\n')[0]!.trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * 结果正文（懒渲染 + 现读）：`tool_result` 到达前显示占位，到达后替换——
 * Disclosure 的 body 只在首次展开时 materialize，若把文本烧进 Markdown 实例
 * 就再也拿不到后续结果，故正文组件 render 时现读 `getText()`。
 */
class SkillResultBody {
  #getText: () => string | undefined;
  #cap: DetailRowCap;
  #cache: { text: string; md: Markdown } | undefined;

  constructor(getText: () => string | undefined, cap: DetailRowCap) {
    this.#getText = getText;
    this.#cap = cap;
  }

  invalidate(): void {
    this.#cache = undefined;
  }

  render(width: number): readonly string[] {
    const text = this.#getText();
    if (text === undefined || text.trim().length === 0) {
      return [theme.fg('dim', '（无输出）')];
    }
    if (this.#cache?.text !== text) {
      this.#cache = {
        text,
        md: new Markdown(text, 0, 0, getMarkdownTheme(), {
          color: (t: string) => theme.fg('customMessageText', t),
        }),
      };
    }
    const rows = this.#cache.md.render(width);
    const maxRows = Math.max(4, typeof this.#cap === 'function' ? this.#cap() : this.#cap);
    if (rows.length <= maxRows) return rows;
    return [...rows.slice(0, maxRows), theme.fg('dim', `… 还有 ${rows.length - maxRows} 行未显示`)];
  }
}

type SkillStatus = 'running' | 'ok' | 'error';

export class SkillCallCard {
  #skillName: string;
  #args: string;
  #cap: DetailRowCap;
  #status: SkillStatus = 'running';
  #bodyText: string | undefined;
  #stats: string | undefined;
  #header: Text;
  #body: SkillResultBody;
  #disclosure: Disclosure;

  constructor(options: SkillCallCardOptions) {
    this.#skillName = options.skillName.trim();
    this.#args = options.args?.trim() ?? '';
    this.#cap = options.maxDetailRows ?? SKILL_CALL_CARD_MAX_DETAIL_ROWS;
    this.#header = new Text(this.#headerText(), 0, 0);
    this.#body = new SkillResultBody(() => this.#bodyText, this.#cap);
    this.#disclosure = new Disclosure({
      summary: this.#header,
      body: () => {
        const box = new Box(1, 1, (t: string) => theme.bg('customMessageBg', t));
        box.setIgnoreTight(true);
        box.addChild(this.#body);
        return box;
      },
      expanded: options.expanded ?? false,
    });
  }

  // ---------- 工具卡鸭子面（bridge 统一调用） ----------

  /** 结果到达：记状态 + 正文 + 统计行（错误时标题追 ✗）。参数签名照抄 DiffCard，
   *  保证 bridge 的联合类型调用与本组件同口径。 */
  updateResult(
    result: {
      content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
      details?: unknown;
      isError?: boolean;
    },
    _isPartial?: boolean,
    _toolCallId?: string,
  ): void {
    this.#status = result.isError ? 'error' : 'ok';
    const text = result.content
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n')
      .trim();
    this.#bodyText = text.length > 0 ? text : undefined;
    if (this.#bodyText) {
      const lines = this.#bodyText.split('\n').length;
      this.#stats = `结果 ${lines} 行 · ${this.#bodyText.length} 字符`;
    }
    this.#refreshHeader();
  }

  setArgsComplete(_toolCallId?: string): void {
    // 无需处理：入参在构造时已由 bridge 拆好
  }

  setExecutionStarted(_toolCallId?: string): void {
    // 无需处理：卡片无执行动画
  }

  setExpanded(expanded: boolean): void {
    this.#disclosure.setExpanded(expanded);
  }

  /** 定稿（result 兜底 seal）：止住 running 态 */
  seal(): void {
    if (this.#status === 'running') this.#status = 'ok';
    this.#refreshHeader();
  }

  invalidate(): void {
    this.#body.invalidate();
    this.#disclosure.invalidate();
  }

  render(width: number): readonly string[] {
    return this.#disclosure.render(width);
  }

  // ---------- 内部 ----------

  #refreshHeader(): void {
    this.#header.setText(this.#headerText());
    this.#disclosure.invalidate();
  }

  /** 标题行：`✦ <name>` chip + `(模型自主调用)` + args + 状态 + ⌃O */
  #headerText(): string {
    const name = this.#skillName || '(未指定)';
    const parts: string[] = [skillChipStyle(skillChipLabel(name)), ` ${theme.fg('dim', '(模型自主调用)')}`];
    if (this.#args) parts.push(` ${theme.fg('dim', `args: ${clip(this.#args, 40)}`)}`);
    if (this.#status === 'error') parts.push(` ${theme.fg('error', theme.status.error)}`);
    else if (this.#status === 'ok' && this.#stats) parts.push(` ${theme.fg('dim', this.#stats)}`);
    else if (this.#status === 'running') parts.push(` ${theme.fg('dim', '运行中…')}`);
    parts.push(` ${theme.fg('dim', expandKeyHint())}`);
    return parts.join('');
  }
}

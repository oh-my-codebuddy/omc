/**
 * prompt-suggestion.ts — 输入框浅色「提问建议」生成侧（prompt-suggestion P1）。
 *
 * 机制来源（codebuddy CLI `PromptSuggestionService`，bundle `dist/codebuddy.js:695-697`）：
 * 每轮对话结束后，用**旁路的一次性轻量模型调用**读最近一轮「用户问 + 助手答」，
 * 产出 3-8 词的下一步提问建议；无建议时模型回 `done`。
 *
 * 与 CLI 的差异（**必须知道**）：
 * - CLI 的 `promptSuggestion` 是 CLI 交互层（TUI/ACP）能力，**SDK/control 通道拿不到**
 *   （仅 ACP 私有能力位 `_meta['codebuddy.ai'].promptSuggestion`）→ omc 自实现生成侧。
 * - omc 用裸 SDK 会话（不经 AgentSession、不挂 hook，防自递归）照 `goal-judge.ts` 范式。
 * - 会话模型 = lite 变体（对齐 CLI `agents.promptSuggestion.models=['lite']`）。
 *
 * 纯函数（`buildSuggestionInput`/`parseSuggestion`/`detectLanguage`/`suggestionKey`）可单测；
 * `SuggestionService` 负责会话生命周期（竞态 / 超时 / 失败静默）。
 */
import { unstable_v2_createSession as createSession } from '@tencent-ai/agent-sdk';

/** 建议输入上下文上限（对齐 CLI `MAX_CONTEXT_CHARS=2000`） */
export const MAX_CONTEXT_CHARS = 2000;
/** 用户消息段保底字符数（对齐 CLI `MIN_USER_CHARS=100`） */
export const MIN_USER_CHARS = 100;
/** 同一建议会话连续生成上限，超过则重建（控上下文膨胀；对齐 goal-judge 的 MAX_JUDGE_TURNS） */
export const MAX_SUGGEST_TURNS = 20;
/** 建议文本长度上限（防御模型跑偏成整段文字） */
export const MAX_SUGGESTION_CHARS = 120;
/**
 * 生成超时（毫秒）——超时才视为无建议并重建会话。
 *
 * **必须显著大于「建议会话冷启动」耗时**：建议会话是**独立 CLI 子进程**（与主会话不同），
 * 首次 spawn 要加载 cwd 的项目上下文（AGENTS.md/memory/skills…）。实测 2026-10-10：
 * cwd=/tmp 冷启动 ≈4.4s、cwd=项目根 ≈7.0s、**在 omc 进程内冷启动 >8s**，暖态 ≈1.6–2.4s。
 * 早期设为 8s 会导致「每轮都超时 → reset → 下一轮又冷启动」的死亡循环，**永远不显示建议**。
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 建议生成指令（静态内联自 `cli/product.json#prompts['prompt-suggestion-instructions']`）。
 * CLI 升级后可用 `scripts/probe-suggest.ts` 对照 product.json 复核漂移（同 gen-prompt-templates 思路）。
 * 品牌词改中性化（CLI 会 `replaceBrandName`，omc 不需要品牌名）。
 */
export const SUGGEST_INSTRUCTIONS = `You are a prompt suggestion generator. Your ONLY purpose is to suggest the user's next action.

Your job:
1. Read the conversation context (user's last message and assistant's last response)
2. Suggest what could be done next

CRITICAL CONSTRAINTS:
- You are NOT a code generator, writer, or task executor
- You MUST respond with ONLY the suggestion text, 3-8 words
- NEVER generate, implement, code, or produce any content
- NEVER provide explanations, reasoning, or extra text
- NEVER use quotes, markdown, or formatting
- Be specific when you can — name files, functions, or actions
- Say "done" ONLY if the work is truly complete with no natural follow-ups`;

/** 会话上下文块（对齐 CLI `buildSuggestionInput` 的输出形态） */
export interface SuggestionInput {
  /** 最近一条真实用户消息（斜杠命令已由调用方/本函数过滤） */
  lastUserText: string;
  /** 最近一条助手定稿文本 */
  lastAssistantText: string;
  /** 输出语言（缺省不追加语言约束，模型默认英文） */
  language?: string;
}

/** 截断到 `max` 字符（保留头部，`hardCapEnd` 语义） */
function headCap(text: string, max: number): string {
  if (max <= 0) return '';
  return text.length <= max ? text : text.slice(0, max);
}

/**
 * 拼「用户问 + 助手答」上下文块（纯函数，对齐 CLI `buildSuggestionInput`）。
 *
 * 形态：`[User Message]\n<user>\n...\n[Assistant Response]\n<assistant>`。
 * 总量 ≤ {@link MAX_CONTEXT_CHARS}；超限时用户段保底 {@link MIN_USER_CHARS}，助手段吃剩余。
 * 斜杠命令（`/`开头）与空白用户文本按 CLI 语义**不入用户段**。
 * 无助手文本（无上下文）→ 返回 `null`（调用方据此跳过）。
 */
export function buildSuggestionInput(
  lastUserText: string,
  lastAssistantText: string,
  opts: { maxChars?: number; minUserChars?: number } = {},
): string | null {
  const maxChars = opts.maxChars ?? MAX_CONTEXT_CHARS;
  const minUserChars = opts.minUserChars ?? MIN_USER_CHARS;

  let assistant = (lastAssistantText ?? '').trim();
  if (!assistant) return null;

  let user = (lastUserText ?? '').trim();
  // 斜杠命令不算「真实用户消息」（对齐 CLI），也不喂空串
  if (user.startsWith('/')) user = '';

  if (user.length + assistant.length > maxChars) {
    const userCap = Math.max(minUserChars, maxChars - assistant.length);
    const assistantCap = maxChars - Math.min(user.length, userCap);
    assistant = headCap(assistant, assistantCap);
    user = headCap(user, userCap);
  }

  const parts: string[] = [];
  if (user) parts.push(`[User Message]\n${user}`);
  parts.push('...');
  parts.push(`[Assistant Response]\n${assistant}`);
  return parts.join('\n');
}

/** CJK 表意文字（中日韩统一表意文字 + 扩展 A + 兼容表意文字） */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/**
 * 粗略判定输出语言（纯函数）：含 CJK 表意文字 → `'Chinese'`；否则 `undefined`（不追加语言约束）。
 * 对齐 CLI 模板的 `{{language}}` 条件块——只在需要时强制同语言。
 */
export function detectLanguage(text: string): string | undefined {
  if (!text) return undefined;
  return CJK_RE.test(text) ? 'Chinese' : undefined;
}

/** 组装完整 prompt（纯函数）：指令 + 可选语言约束 + 上下文块 */
export function buildSuggestionPrompt(input: SuggestionInput): string | null {
  const block = buildSuggestionInput(input.lastUserText, input.lastAssistantText);
  if (!block) return null;
  const lines = [SUGGEST_INSTRUCTIONS];
  if (input.language) {
    lines.push(
      '',
      `IMPORTANT: The suggestion MUST be written in ${input.language}. Do not use English even though these instructions are in English.`,
    );
  }
  return `${lines.join('\n')}\n\n--- conversation ---\n${block}`;
}

/**
 * 解析模型输出为建议（纯函数，对齐 CLI `parseSuggestionResult` + `cleanSuggestionResponse`）：
 * trim → 去首尾引号（含中英文/反引号）→ 空白折叠为单空格 → 再 trim；
 * 空 / `"done"` / 超长 → `null`。
 */
export function parseSuggestion(text: string | null | undefined): string | null {
  if (text == null) return null;
  let s = text.trim();
  if (!s) return null;
  s = s.replace(/^["'“”‘’`]+/, '').replace(/["'“”‘’`]+$/, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (s.toLowerCase() === 'done') return null;
  if (s.length > MAX_SUGGESTION_CHARS) return null;
  return s;
}

/** 建议行右侧的「回车发送」提示（对齐 CLI `⏎ send`；dim 渲染由 UI 层负责） */
export const SUGGEST_SEND_HINT = '⏎ send';

/**
 * 拼建议展示文本：`<建议>  ⏎ send`（纯函数，便于单测）。
 * 中间两空格分隔，整体由 UI 层包 dim 后交 pi-tui `placeholder`（右对齐）。
 * 空建议 → 空串（调用方据此不显示）。
 */
export function formatSuggestionPlaceholder(suggestion: string | null | undefined): string {
  const s = (suggestion ?? '').trim();
  return s ? `${s}  ${SUGGEST_SEND_HINT}` : '';
}

/** 去重键（纯函数）：同一轮（同 user + 同 assistant）不重复生成，避免重复模型调用 */
export function suggestionKey(lastUserText: string, lastAssistantText: string): string {
  const s = `${lastUserText ?? ''}\n${lastAssistantText ?? ''}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return `${s.length}:${h}`;
}

type SdkSession = ReturnType<typeof createSession>;

export interface SuggestionServiceOptions {
  cwd: string;
  /** 建议模型（lite 变体 id；缺省 → CLI 默认模型） */
  model?: string;
  /** 子进程 env 覆盖（口径同 AgentSession：宿主清理 + 变体 env + 账户 KEY） */
  env?: Record<string, string | undefined>;
  /** 生成超时（毫秒），缺省 {@link DEFAULT_TIMEOUT_MS} */
  timeoutMs?: number;
  /**
   * 测试/冒烟注入：命中时**跳过会话**直接返回该文本（`'done'`/空 → 无建议）。
   * 缺省读 `process.env.OMC_SUGGEST_FAKE`。
   */
  fake?: string;
  /** 测试注入：替换 SDK 会话工厂（默认 = `unstable_v2_createSession`） */
  sessionFactory?: (options: {
    cwd: string;
    model?: string;
    env?: Record<string, string | undefined>;
  }) => SdkSession;
  /** 诊断口（`OMC_DEBUG_SUGGEST`）：记录创建/结果/异常/超时（默认 no-op） */
  debug?: (line: string) => void;
}

/**
 * 建议生成服务（P1）。懒创建、常驻复用（暖态省 spawn，同 goal-judge），超限/超时/失败重建。
 * 任何异常都静默为「无建议」——建议是锦上添花，绝不打扰主对话。
 */
export class SuggestionService {
  private session: SdkSession | null = null;
  private turns = 0;
  /** 竞态令牌：新一代请求作废在途旧结果 */
  private token = 0;
  private readonly fake: string | undefined;
  private readonly timeoutMs: number;
  private readonly dbg: (line: string) => void;

  constructor(private readonly opts: SuggestionServiceOptions) {
    this.fake = opts.fake ?? process.env.OMC_SUGGEST_FAKE;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.dbg = opts.debug ?? (() => {});
  }

  /**
   * 生成一条建议。返回 `null` = 无建议（无助手上下文 / 模型回 `done` / 超时 / 失败 / 被更新请求取代）。
   * 不抛异常。
   */
  async request(input: SuggestionInput): Promise<string | null> {
    const my = ++this.token;
    // 假实现（冒烟/单测）：不建会话，零成本可预期
    if (this.fake !== undefined) {
      this.dbg(`fake=${JSON.stringify(this.fake)}`);
      return parseSuggestion(this.fake);
    }
    if (!input.lastAssistantText?.trim()) {
      this.dbg('skip: no assistant context');
      return null;
    }
    const prompt = buildSuggestionPrompt(input);
    if (!prompt) {
      this.dbg('skip: empty prompt');
      return null;
    }

    if (this.turns >= MAX_SUGGEST_TURNS) this.reset();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const t0 = Date.now();
    // runOnce 可能因超时后 reset() 而在后台 reject → 就地吞掉，避免 unhandled rejection
    const work = this.runOnce(prompt).then(
      (t) => t,
      (e) => {
        this.dbg(`error: ${e instanceof Error ? e.message : String(e)}`);
        this.reset();
        return '';
      },
    );
    try {
      const raced = await Promise.race([
        work,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), this.timeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (my !== this.token) {
        this.dbg('race: superseded');
        return null;
      }
      if (raced === null) {
        // 超时：会话状态不确定 → 重建，避免下一轮带着半截上下文
        this.dbg(`timeout after ${Date.now() - t0}ms`);
        this.reset();
        return null;
      }
      const parsed = parseSuggestion(raced);
      this.dbg(
        `gen ${Date.now() - t0}ms raw=${JSON.stringify(raced.slice(0, 160))} => ${parsed === null ? 'null' : JSON.stringify(parsed)}`,
      );
      return parsed;
    } catch (e) {
      if (timer) clearTimeout(timer);
      this.dbg(`throw: ${e instanceof Error ? e.message : String(e)}`);
      this.reset();
      return null;
    }
  }

  /** 作废在途生成（新一轮开始 / 换会话时调用），不关闭常驻会话 */
  cancel(): void {
    this.token++;
  }

  close(): void {
    this.reset();
  }

  private runOnce(prompt: string): Promise<string> {
    const session = this.ensure();
    return (async () => {
      await session.send(prompt);
      const text = await readAssistantText(session);
      this.turns += 1;
      return text;
    })();
  }

  private ensure(): SdkSession {
    if (!this.session) {
      this.dbg(`create session model=${this.opts.model ?? '(default)'} cwd=${this.opts.cwd}`);
      this.session =
        this.opts.sessionFactory?.({
          cwd: this.opts.cwd,
          model: this.opts.model,
          env: this.opts.env,
        }) ??
        createSession({
          cwd: this.opts.cwd,
          model: this.opts.model,
          // 建议会话不弹权限、不加载 settings、不挂 hook（避免自递归）
          permissionMode: 'bypassPermissions',
          settingSources: [],
          includePartialMessages: false,
          env: this.opts.env,
        });
      this.turns = 0;
    }
    return this.session;
  }

  private reset(): void {
    this.session?.close();
    this.session = null;
    this.turns = 0;
  }
}

/** 读一轮 assistant 文本（照 goal-judge 范式：`stream()` 每轮一个生成器，遇 result 即 break） */
async function readAssistantText(session: SdkSession): Promise<string> {
  let text = '';
  for await (const m of session.stream()) {
    const msg = m as { type?: string; message?: { content?: unknown } };
    const content = msg.message?.content;
    if (msg.type === 'assistant' && Array.isArray(content)) {
      for (const raw of content) {
        const b = raw as { type?: string; text?: string };
        if ((b.type === 'text' || b.type === 'output_text') && typeof b.text === 'string') {
          text += b.text;
        }
      }
    }
    if (msg.type === 'result') break;
  }
  return text;
}

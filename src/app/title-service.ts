/**
 * title-service.ts — 自动会话标题（session-title 阶段）。
 *
 * 机制来源：omp 的 tiny 标题路径（`packages/coding-agent/src/tiny/{text,message-preproc}.ts`）。
 * omp 有 fork / tiny 两条路，omc 只取 **tiny 等价物** —— 独立 lite 旁路会话单次生成
 * （fork 依赖 ephemeral turn API，omc 的 SDK 没有，见 docs/plan/session-title/README.md）。
 *
 * 本文件只放**纯函数 + 常量**（可单测，不 spawn 会话）：
 * - {@link isLowSignalTitleInput}：确定性预过滤（filler 词表 + 纯形状规则）—— **只当省钱闸门**，
 *   正确性由模型自拒哨兵兜底（P0.4 实测 10/10 命中）。
 * - {@link preprocessTitleInput}：剥噪 + 中间截断，喂给模型的用户段。
 * - {@link normalizeGeneratedTitle}：模型输出的剥壳与护栏（**拒绝而非截断**）。
 *
 * 与 omp 的差异（**必须知道**，勿照抄英文口径）：
 * - filler 词表以**中文为主**，判据是 **归一化后整串精确匹配**（omp 是英文按词匹配）。中文没有
 *   空格分词，词数护栏无意义 → 只留**码点长度**护栏（omp 是 80 字符 / 12 词，中文信息密度高，
 *   80 太长）。
 * - 哨兵 = ASCII `__NO_TITLE__`（omp 用 `none`；P0.4 实测小模型对中文哨兵易乱写，ASCII 稳）。
 * - 输出形态 = 纯标题一行（不走 omp 的 `<title/>` 标记、也不走 CLI 的 JSON）。
 *
 * 会话生命周期（懒起 / 超时 / 竞态 / 用完即关）见本文件末尾的 `TitleService`（P1.2）。
 */
import { appendFileSync } from 'node:fs';
import { unstable_v2_createSession as createSession } from '@tencent-ai/agent-sdk';

/** 无可用内容时模型应回的字面量（prompt 里显式规定；ASCII 避免小模型对中文哨兵乱写） */
export const TITLE_SKIP_SENTINEL = '__NO_TITLE__';
/** 标题长度护栏（码点数）；超限 → 由 {@link normalizeGeneratedTitle} 返回 null（拒绝而非截断） */
export const MAX_TITLE_CHARS = 40;
/** 归一化后短于此长度 → 本地判为低信号（覆盖「好」「嗯」这类单字） */
export const TITLE_MIN_CHARS = 2;
/** 喂给模型的用户段字符上限（对齐 omp `MAX_TINY_MESSAGE_CHARS`） */
export const MAX_TITLE_INPUT_CHARS = 2000;

/**
 * 本地 filler 词表：**归一化后整串精确匹配**（不做子串！否则「继续修复那个 bug」会被误杀）。
 * 归一化 = trim → 去首尾空白/标点/符号(含 emoji) → 转小写。
 * 正确性不依赖它（模型自拒已 10/10），它只是省掉一次无用调用的上游闸门。
 */
export const TITLE_FILLER_WORDS: readonly string[] = [
  // 中文问候 / 应答
  '你好', '您好', '哈喽', '嗨', '早', '早上好', '晚安', '拜拜', '再见',
  '在吗', '在么', '在不在',
  // 中文致谢
  '谢谢', '多谢', '感谢', '谢了', '辛苦了',
  // 中文确认 / 继续 / 单字应答
  'ok', 'okay', '好的', '好', '嗯', '嗯嗯', '哦', '行', '可以', '收到', '知道了', '明白', '继续', '继续吧',
  // 英文
  'hi', 'hello', 'hey', 'thanks', 'thank you', 'thx', 'continue', 'go', 'go on', 'test',
];

const FILLER_SET: ReadonlySet<string> = new Set(TITLE_FILLER_WORDS);

/** 首尾「空白 + 标点 + 符号（含 emoji，属 \p{So}）」 */
const EDGE_NOISE = /^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu;
/** 纯十进制数字（含全角；`\p{Nd}`） */
const PURE_DIGITS = /^\p{Nd}+$/u;
/** 是否含可命名的字/数（`\p{L}` / `\p{N}`）—— 没有就是纯标点/符号垃圾 */
const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;

/** 归一化：去首尾空白/标点/符号 → 转小写（filler 判据口径） */
function normalizeForFiller(text: string): string {
  return text.replace(EDGE_NOISE, '').toLowerCase();
}

/**
 * 确定性低信号预过滤：归一化后为空 / 码点 `< TITLE_MIN_CHARS` / 命中 filler 表 / 纯数字
 * → 判为「无可命名任务」，**不建会话**（把标题留给下一句实质消息）。
 *
 * 依据 omp `tiny/text.ts:127`；常量见 [P0.4 定论]（P0 探针实测模型自拒 10/10，故本过滤只省钱）。
 */
export function isLowSignalTitleInput(text: string): boolean {
  const norm = normalizeForFiller(text ?? '');
  if (!norm) return true; // 空白 / 纯标点 / 纯 emoji
  if ([...norm].length < TITLE_MIN_CHARS) return true; // 单字
  if (FILLER_SET.has(norm)) return true;
  if (PURE_DIGITS.test(norm)) return true; // 纯数字
  return false;
}

// ---- preprocessTitleInput：剥噪 + 中间截断（照 omp message-preproc.ts） ----

/** 剥 fenced code block（3+ 反引号，含未闭合的尾部 fence） */
const FENCED_CODE_BLOCK = /```+[\s\S]*?(?:```+|$)/g;
/** SGR ANSI 转义序列（粘贴终端输出时泄漏的着色码） */
const ANSI_ESCAPE = /\u001b\[[0-9;]*m/g;
/** 成对 XML/HTML 式块（`<user>…</user>` 或工具信封）；自闭合/未配对的单标签保留 */
const XML_BLOCK = /<([a-zA-Z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g;
/** 长 hex 串（≥12 位，视为完整 commit SHA 而非普通词） */
const LONG_HEX_RUN = /\b[0-9a-fA-F]{12,}\b/g;
/** 长 hex 串保留的短前缀长度 */
const SHORT_HASH_CHARS = 7;
/** 剥代码块后短于此长度 → 回落到原文（防「整条消息就是一个代码块」被剥空） */
const MIN_STRIPPED_TITLE_CHARS = 12;
/** 清理前从超大消息两端各保留的原始字符数（只封顶病态粘贴的工作量） */
const RAW_SCAN_EDGE_CHARS = 262_144;
/** 成对标签剥离前从两端各保留的字符数（该正则对未闭合标签是二次复杂度） */
const CLEAN_WINDOW_EDGE_CHARS = 16_384;
/** 拼接超大消息头尾窗口的分隔符 */
const WINDOW_SEPARATOR = '\n…\n';

/** 超过 `edgeChars*2` 时，两端各留 `edgeChars`（对齐 omp `windowEdges`） */
function windowEdges(message: string, edgeChars: number): string {
  if (message.length <= edgeChars * 2) return message;
  return `${message.slice(0, edgeChars)}${WINDOW_SEPARATOR}${message.slice(-edgeChars)}`;
}

/** 水平空白折叠为单空格 + 连续空行压成一段 + trim（对齐 omp `collapseWhitespace`） */
function collapseWhitespace(message: string): string {
  return message
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 剥 ANSI 转义（导出供单测/复用） */
export function stripAnsi(message: string): string {
  return message.replace(ANSI_ESCAPE, '');
}

/** 剥成对 XML/HTML 式块（导出供单测/复用） */
export function stripXmlBlocks(message: string): string {
  return message.replace(XML_BLOCK, ' ');
}

/** 长 hex 串截断为短前缀（导出供单测/复用） */
export function shortenHashes(message: string): string {
  return message.replace(LONG_HEX_RUN, (m) => m.slice(0, SHORT_HASH_CHARS));
}

/**
 * 剥 fenced code block。小模型会照抄代码块里的字面串当标题（粘贴的 UI mockup 里有
 * "Welcome to …" 就出这个标题），故剥掉代码块留下真正描述任务的 prose；**内联代码（单反引号）
 * 保留**（短、高信号，如 `/login`）。剥完太短（消息基本就是个代码块）→ 回落原文。
 */
export function stripCodeBlocks(message: string): string {
  const cleaned = collapseWhitespace(message.replace(FENCED_CODE_BLOCK, ' '));
  return cleaned.length >= MIN_STRIPPED_TITLE_CHARS ? cleaned : message;
}

/** 中间截断：头部留 2/3、尾部留 1/3，省略标记计入上限（对齐 omp `truncateTinyMessage`） */
function truncateMiddle(message: string): string {
  if (message.length <= MAX_TITLE_INPUT_CHARS) return message;
  let omitted = message.length - MAX_TITLE_INPUT_CHARS;
  let marker = '';
  let headChars = 0;
  let tailChars = 0;
  // 省略字数会改变标记宽度；两遍收敛（只有十进制位数会变）
  for (let pass = 0; pass < 2; pass++) {
    marker = `\n[… ${omitted} chars omitted …]\n`;
    const keptChars = Math.max(0, MAX_TITLE_INPUT_CHARS - marker.length);
    headChars = Math.ceil((keptChars * 2) / 3);
    tailChars = keptChars - headChars;
    omitted = message.length - headChars - tailChars;
  }
  marker = `\n[… ${omitted} chars omitted …]\n`;
  return `${message.slice(0, headChars)}${marker}${message.slice(-tailChars)}`;
}

/**
 * 把原始用户消息清洗成有界、低噪的标题输入（纯函数，对齐 omp `preprocessTinyMessage`）：
 * 剥 ANSI → 剥 fenced code block → 剥成对 XML/tool 信封 → 长 hex 截短 → 折叠空白 →
 * **中间截断** {@link MAX_TITLE_INPUT_CHARS}（2/3 头 + 1/3 尾 + `[… N chars omitted …]`）。
 */
export function preprocessTitleInput(text: string): string {
  const raw = windowEdges(stripAnsi(text ?? ''), RAW_SCAN_EDGE_CHARS);
  const fenceStripped = stripCodeBlocks(raw);
  const windowed = windowEdges(fenceStripped, CLEAN_WINDOW_EDGE_CHARS);
  const cleaned = collapseWhitespace(shortenHashes(stripXmlBlocks(windowed)));
  return truncateMiddle(cleaned);
}

// ---- normalizeGeneratedTitle：模型输出剥壳与护栏 ----

/** 首尾包裹的引号/书名号（含中英文引号与反引号、CJK 引号与书名号） */
const WRAP_QUOTES = /^["'“”‘’`「」『』《》〈〉]+|["'“”‘’`「」『』《》〈〉]+$/g;
/** 句末标点（**不含** `_`，否则会把 `__NO_TITLE__` 拆散） */
const TRAILING_PUNCT = /[.!?。！？…]+$/;
/** 空标记 `<title/>`（omp 兼容；omc prompt 不用标记，但容错无害） */
const EMPTY_TITLE_TAG = /^<title\s*\/>$/i;

/**
 * 把模型回复归一化成标题（纯函数，对齐 omp `normalizeGeneratedTitle`，中文适配）：
 * 取首行 → 剥 `<title>` 壳与首尾引号 → 剥句末标点 → 拒哨兵 {@link TITLE_SKIP_SENTINEL} /
 * 空 / 纯标点 → 码点长度护栏 {@link MAX_TITLE_CHARS}（**超限返回 null 而非截断**）。
 *
 * 拒绝而非截断的理由（照 omp）：标题是 3-7 词的任务，超限说明模型没理会指令、直接把回复
 * 整段当成标题了，截一半仍是垃圾；返回 null 让调用方**留给下一轮**。
 */
export function normalizeGeneratedTitle(raw: string | null | undefined): string | null {
  const firstLine = raw?.trim().split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine) return null;
  if (EMPTY_TITLE_TAG.test(firstLine)) return null;
  const title = firstLine
    .replace(/^<title>/i, '')
    .replace(/<\/title>$/i, '')
    .replace(WRAP_QUOTES, '')
    .replace(TRAILING_PUNCT, '')
    .trim();
  if (!title) return null;
  if (title.toUpperCase() === TITLE_SKIP_SENTINEL) return null;
  if (!HAS_WORD_CHAR.test(title)) return null; // 纯标点/符号垃圾
  if ([...title].length > MAX_TITLE_CHARS) return null;
  return title;
}

// ---- TitleService：旁路会话生命周期（D1/D3：lite 变体、用完即关） ----

/**
 * 标题生成指令（D8：纯标题一行）。
 * 措辞**逐字**取自 P0.4 已验的 `plain` 风格（`scripts/probe-title-gen.ts` `TITLE_STYLES.plain`，
 * 两种风格各 10/10 命中哨兵）→ 不改写以免引入未验证漂移。
 */
export const TITLE_INSTRUCTIONS =
  'Generate a short title for the user message below. Reply with the title text ONLY — no quotes, no punctuation at the end, no explanation, same language as the message.\n' +
  'Keep it under 16 Chinese characters (or 6 English words).\n' +
  `If the message is just a greeting, thanks, a single word, or only punctuation, reply exactly: ${TITLE_SKIP_SENTINEL}`;

/**
 * 生成超时（毫秒）——超时即视为无标题并关闭会话。
 *
 * **必须显著大于「旁路会话冷启动」**（`project_side_session_cold_start` 教训）：冷启动 2–8.4s，
 * 超时若小于它 → 「每轮超时 → 关闭 → 下一轮又冷启动」永久不出标题（`prompt-suggestion` 实测坑）。
 */
export const TITLE_TIMEOUT_MS = 30_000;

/**
 * 拼标题 prompt（纯函数）：指令 + `<user>\n{preprocessTitleInput(text)}\n</user>`。
 * 用户段走 {@link preprocessTitleInput} 剥噪（防模型照抄代码块里的字面串）。
 */
export function buildTitlePrompt(userText: string): string {
  return formatTitlePrompt(preprocessTitleInput(userText));
}

/** 由**已清洗**的用户段拼 prompt（内部用，避免重复清洗） */
function formatTitlePrompt(cleanedUserText: string): string {
  return `${TITLE_INSTRUCTIONS}\n\n<user>\n${cleanedUserText}\n</user>`;
}

type SdkSession = ReturnType<typeof createSession>;

/**
 * 诊断口默认实现（`OMC_DEBUG_TITLE=<path>` 时把 gate/创建/耗时/超时/异常追加到该文件；
 * 值 `1`/`-` → 写 stderr。口径同 `OMC_DEBUG_SUGGEST`/`OMC_DEBUG_TASKS`）。真机排查用，未设则 no-op。
 * 注：main.ts 会显式注入它自己的 `titleDebug`（门禁层），此时本兜底不生效。
 */
function envTitleDebug(): ((line: string) => void) | undefined {
  const path = process.env.OMC_DEBUG_TITLE;
  if (!path) return undefined;
  const toStderr = path === '1' || path === '-';
  return (line: string) => {
    try {
      if (toStderr) process.stderr.write(`${line}\n`);
      else appendFileSync(path, `${line}\n`);
    } catch {
      // 调试通道失败不影响主流程
    }
  };
}

export interface TitleServiceOptions {
  cwd: string;
  /** 标题模型（lite 变体 id；缺省 → CLI 默认模型） */
  model?: string;
  /** 子进程 env 覆盖（口径同主会话：宿主清理 + 变体 env + 账户 KEY） */
  env?: Record<string, string | undefined>;
  /** 生成超时（毫秒），缺省 {@link TITLE_TIMEOUT_MS} */
  timeoutMs?: number;
  /**
   * 测试/冒烟注入：命中时**跳过会话**直接归一化该文本（哨兵/空 → `null`）。
   * 缺省读 `process.env.OMC_TITLE_FAKE`。低信号门禁在调用方（`main.ts`）先判，故此处不再过滤。
   */
  fake?: string;
  /** 测试注入：替换 SDK 会话工厂（默认 = `unstable_v2_createSession`） */
  sessionFactory?: (options: {
    cwd: string;
    model?: string;
    env?: Record<string, string | undefined>;
  }) => SdkSession;
  /** 诊断口（缺省读 `OMC_DEBUG_TITLE=<path>` 追加写文件）：记录 gate/创建/耗时/超时/异常 */
  debug?: (line: string) => void;
}

/**
 * 自动标题服务（P1.2）：**每次用完即关**（D3 —— 标题低频一次性：成功即冻结，典型 1–3 次调用，
 * 常驻的摊薄收益抵不过长期占一个 CLI 子进程；P0.1 实证 `close()` 真回收子进程，无需显式 kill）。
 * 任何异常/超时都静默为 `null` —— 标题是锦上添花，绝不打扰主对话。
 */
export class TitleService {
  /** 竞态令牌：新一代请求/`cancel()` 作废在途旧结果 */
  private token = 0;
  private readonly fake: string | undefined;
  private readonly timeoutMs: number;
  private readonly dbg: (line: string) => void;

  constructor(private readonly opts: TitleServiceOptions) {
    this.fake = opts.fake ?? process.env.OMC_TITLE_FAKE;
    this.timeoutMs = opts.timeoutMs ?? TITLE_TIMEOUT_MS;
    this.dbg = opts.debug ?? envTitleDebug() ?? (() => {});
  }

  /**
   * 生成一条标题。返回 `null` = 无标题（清洗后为空 / 模型回哨兵 / 超长被拒 / 超时 / 失败 / 被取代）。
   * 不抛异常。
   */
  async generate(userText: string): Promise<string | null> {
    // 假实现（冒烟/单测）：不建会话，零成本可预期
    if (this.fake !== undefined) {
      this.dbg(`fake=${JSON.stringify(this.fake)}`);
      return normalizeGeneratedTitle(this.fake);
    }
    const clean = preprocessTitleInput(userText ?? '');
    if (!clean) {
      this.dbg('skip: empty input after preprocess');
      return null;
    }
    const my = ++this.token;
    const prompt = formatTitlePrompt(clean);
    let session: SdkSession | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const t0 = Date.now();
    try {
      session =
        this.opts.sessionFactory?.({ cwd: this.opts.cwd, model: this.opts.model, env: this.opts.env }) ??
        createSession({
          cwd: this.opts.cwd, // P0.2 定论：干净 cwd 无收益 → 用会话 cwd
          model: this.opts.model,
          // 标题会话不弹权限、不加载 settings、不挂 hook（避免自递归）
          permissionMode: 'bypassPermissions',
          settingSources: [],
          includePartialMessages: false, // P0.3 实测：开与不开都不影响读回文本
          env: this.opts.env,
        });
      const s = session;
      this.dbg(`create session model=${this.opts.model ?? '(default)'} cwd=${this.opts.cwd}`);
      // work 超时后仍在后台跑（会话即将关闭）→ 就地吞掉，避免 unhandled rejection
      const work = (async () => {
        await s.send(prompt);
        return await readTitleText(s);
      })().then(
        (t) => t,
        (e) => {
          this.dbg(`error: ${e instanceof Error ? e.message : String(e)}`);
          return '';
        },
      );
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
        this.dbg(`timeout after ${Date.now() - t0}ms`);
        return null;
      }
      const title = normalizeGeneratedTitle(raced);
      this.dbg(
        `gen ${Date.now() - t0}ms raw=${JSON.stringify(raced.slice(0, 160))} => ${title === null ? 'null' : JSON.stringify(title)}`,
      );
      return title;
    } catch (e) {
      if (timer) clearTimeout(timer);
      this.dbg(`throw: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    } finally {
      // D3 用完即关：**必须在 finally**（超时是最常见路径，放 then 里会漏；P0.1 实证真回收）
      session?.close();
    }
  }

  /** 作废在途生成（新一轮开始 / 换会话时调用） */
  cancel(): void {
    this.token++;
  }

  close(): void {
    this.cancel();
  }
}

/**
 * 读一轮标题输出。**优先取 `result.result`**（P0 最重要的坑）：
 * 该模型是 reasoning 型，assistant 消息常只有 `thinking` 块、文本为空 —— 只读 assistant 文本块
 * 时 15 样本空回复率 **73.3%**，改读 `result.result` 后 **0%**（`includePartialMessages` 无效）。
 */
async function readTitleText(session: SdkSession): Promise<string> {
  let resultText = '';
  let assistantText = '';
  for await (const m of session.stream()) {
    const msg = m as { type?: string; result?: unknown; message?: { content?: unknown } };
    if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
      for (const raw of msg.message.content) {
        const b = raw as { type?: string; text?: string };
        if ((b.type === 'text' || b.type === 'output_text') && typeof b.text === 'string') {
          assistantText += b.text;
        }
      }
    }
    if (msg.type === 'result') {
      if (typeof msg.result === 'string') resultText = msg.result;
      break;
    }
  }
  return resultText.trim() ? resultText : assistantText;
}

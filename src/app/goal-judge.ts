/**
 * goal-judge.ts — `/goal` 裁判（goal P1.3，通道① 常驻轻量 SDK 会话）。
 *
 * 机制（见 docs/plan/goal/「P0 定论」）：Stop hook 每次回调时，把**条件 + 锚点后的对话**
 * 交给一个独立裁判会话判定 `{ok, reason}` —— 不达标则 hook 返回 `block` 逼代理继续。
 *
 * 设计（P0 定论）：
 * - 通道①（本实现）：复用 SDK `createSession` 起**常驻**轻量会话（省 spawn；P0 实测暖态
 *   ≈2.5–3.7s/判定）。**不得挂 Stop hook**（否则自递归）——故用裸 SDK 会话，不经 AgentSession。
 * - 建议用 lite 变体模型降本（main 侧解析后传入 `model`）。
 * - transcript 直接读 Stop 入参 `transcript_path`（= CLI 会话 jsonl，权威同源），
 *   只取 `createdAt` 之后的消息、限行数/字符数控成本。
 * - 输出解析失败 → 视为未达标但标 `parseError`（不计入熔断，避免裁判偶发格式抖动误熔断）。
 *
 * 纯函数（`readTranscriptTail`/`buildStopConditionPrompt`/`parseVerdict`）可单测；
 * `GoalJudgeSession` 负责会话生命周期。
 */
import { readFileSync } from 'node:fs';
import { unstable_v2_createSession as createSession } from '@tencent-ai/agent-sdk';
import type { GoalVerdict } from './goal-state';

/** transcript 字符上限（喂裁判的对话总量；取尾部） */
export const MAX_TRANSCRIPT_CHARS = 12_000;
/** transcript 消息条数上限（取尾部） */
export const MAX_TRANSCRIPT_MESSAGES = 60;
/** 同一裁判会话连续判定上限，超过则重建（控上下文膨胀） */
export const MAX_JUDGE_TURNS = 20;

export interface TranscriptOptions {
  /** 只取该毫秒时间戳之后的消息（= goal `createdAt` 锚点；对齐 codebuddy "AFTER this timestamp"） */
  createdAt?: number;
  maxChars?: number;
  maxMessages?: number;
}

/** 提取 `function_call_result.output` 的文本（容错：string / {text} / {content} / {content[]}） */
export function extractOutputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object') {
    const o = output as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text;
    if (typeof o.content === 'string') return o.content;
    if (Array.isArray(o.content)) {
      return o.content
        .map((c) => (c && typeof c === 'object' ? (c as Record<string, unknown>).text : undefined))
        .filter((t): t is string => typeof t === 'string')
        .join('\n');
    }
  }
  return '';
}

/**
 * CLI 会话 jsonl 行 → 单行对话文本（非对话行 / 无可提取文本返回 null）。
 *
 * 覆盖三种行形态（`probe-goal-session-dump.ts` 实测）：
 * - `type:'message'`（role user/assistant，content blocks）
 * - `type:'function_call'`（工具调用，`name`）
 * - `type:'function_call_result'`（工具输出，`output.text`）——**必须带上内容**，
 *   否则裁判看不到测试输出等证据，会把已完成判成未达标（探针首跑实证）。
 */
export function formatTranscriptLine(obj: unknown): string | null {
  if (!obj || typeof obj !== 'object') return null;
  const rec = obj as Record<string, unknown>;
  if (rec.type === 'function_call') {
    const name = typeof rec.name === 'string' ? rec.name : 'tool';
    const input = rec.input !== undefined && rec.input !== null ? JSON.stringify(rec.input) : '';
    return `tool_call ${name}${input ? ` ${input.slice(0, 200)}` : ''}`;
  }
  if (rec.type === 'function_call_result') {
    const name = typeof rec.name === 'string' ? rec.name : 'tool';
    const out = extractOutputText(rec.output).slice(0, 1000);
    return `tool_result ${name}: ${out}`;
  }
  if (rec.type !== 'message') return null;
  const role = typeof rec.role === 'string' ? rec.role : 'unknown';
  const content = rec.content;
  const parts: string[] = [];
  if (Array.isArray(content)) {
    for (const raw of content) {
      if (!raw || typeof raw !== 'object') continue;
      const b = raw as Record<string, unknown>;
      if (
        typeof b.text === 'string' &&
        (b.type === 'input_text' || b.type === 'output_text' || b.type === 'text')
      ) {
        parts.push(b.text);
      } else if (b.type === 'tool_use' && typeof b.name === 'string') {
        parts.push(`[tool: ${b.name}]`);
      } else if (b.type === 'tool_result') {
        const out = extractOutputText(b.content ?? b.output ?? b.text).slice(0, 1000);
        parts.push(out ? `[tool result] ${out}` : '[tool result]');
      }
    }
  } else if (typeof content === 'string') {
    parts.push(content);
  }
  return parts.length > 0 ? `${role}: ${parts.join(' ')}` : null;
}

/**
 * 读 CLI 会话 jsonl 尾部，拼成裁判可读的对话文本（纯函数，`path` 不可读 → ''）。
 * 只取 `type==='message'` 行；`createdAt` 之后（时间戳过滤）；尾部限行数/字符数。
 */
export function readTranscriptTail(path: string, opts: TranscriptOptions = {}): string {
  const {
    createdAt,
    maxChars = MAX_TRANSCRIPT_CHARS,
    maxMessages = MAX_TRANSCRIPT_MESSAGES,
  } = opts;
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return '';
  }
  const lines: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (createdAt !== undefined && typeof obj.timestamp === 'number' && obj.timestamp < createdAt) {
      continue;
    }
    const formatted = formatTranscriptLine(obj);
    if (formatted) lines.push(formatted);
  }
  const joined = lines.slice(-maxMessages).join('\n');
  return joined.length > maxChars ? joined.slice(-maxChars) : joined;
}

/** 裁判提示词（对齐 codebuddy `buildStopConditionPrompt` 的语义：只评估锚点之后的对话） */
export function buildStopConditionPrompt(condition: string, transcript: string): string {
  return (
    `You are a strict judge for an autonomous coding agent's stopping condition.\n` +
    `Based on the conversation transcript below, has the following stopping condition been satisfied?\n\n` +
    `Stopping condition: ${condition}\n\n` +
    `Evaluate ONLY the conversation that happened after the goal was set.\n` +
    `Reply with ONLY a JSON object: {"ok": true|false, "reason": "<short reason>"}.\n` +
    `- ok=true  → the condition is fully satisfied.\n` +
    `- ok=false → the condition is not yet satisfied.\n\n` +
    `--- transcript ---\n${transcript}`
  );
}

/**
 * 解析裁判输出为 `GoalVerdict`（纯函数）。容错：整段 JSON 优先，失败回落「首个 { 到末个 }」
 * 片段；仍失败返回 `null`（调用方视为未达标 + `parseError`）。
 */
export function parseVerdict(text: string): GoalVerdict | null {
  if (!text) return null;
  const tries: string[] = [];
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) tries.push(trimmed);
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) tries.push(text.slice(first, last + 1));
  for (const raw of tries) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      if (typeof obj.ok !== 'boolean') continue;
      const reason =
        typeof obj.reason === 'string' && obj.reason.trim()
          ? obj.reason.trim()
          : obj.ok
            ? 'condition satisfied'
            : 'condition not satisfied';
      const verdict: GoalVerdict = { ok: obj.ok, reason };
      if (obj.impossible === true) verdict.impossible = true;
      return verdict;
    } catch {
      // 继续尝试下一个候选
    }
  }
  return null;
}

/** 裁判会话配置 */
export interface GoalJudgeOptions {
  cwd: string;
  /** 裁判模型（建议 lite 变体；缺省 → CLI 默认模型） */
  model?: string;
  /** 子进程 env 覆盖（与主会话一致：宿主清理 + 变体 env / 账户 KEY） */
  env?: Record<string, string | undefined>;
}

/**
 * 常驻裁判会话（通道①）。懒创建；`judge()` 发一条 prompt 读回文本；
 * 句柄错误/超时由调用方（`AgentSession.onStopHook`）兜为「无结论放行」。
 */
export class GoalJudgeSession {
  private session: ReturnType<typeof createSession> | null = null;
  private turns = 0;

  constructor(private readonly opts: GoalJudgeOptions) {}

  private ensure(): ReturnType<typeof createSession> {
    if (!this.session) {
      this.session = createSession({
        cwd: this.opts.cwd,
        model: this.opts.model,
        // 裁判会话不弹权限、不加载 settings、不挂 hook（避免自递归）
        permissionMode: 'bypassPermissions',
        settingSources: [],
        includePartialMessages: false,
        env: this.opts.env,
      });
      this.turns = 0;
    }
    return this.session;
  }

  /** 判定一次：读 transcript 由调用方传入（已按锚点裁剪） */
  async judge(condition: string, transcript: string): Promise<GoalVerdict> {
    if (this.turns >= MAX_JUDGE_TURNS) this.reset();
    const session = this.ensure();
    const prompt = buildStopConditionPrompt(condition, transcript);
    await session.send(prompt);
    const text = await readAssistantText(session);
    this.turns += 1;
    const verdict = parseVerdict(text);
    if (!verdict) {
      return {
        ok: false,
        reason: `裁判输出无法解析（视为未达标）：${text.slice(0, 120)}`,
        parseError: true,
      };
    }
    return verdict;
  }

  private reset(): void {
    this.session?.close();
    this.session = null;
    this.turns = 0;
  }

  close(): void {
    this.reset();
  }
}

/** 读一轮 assistant 文本（照 P0 探针范式：`stream()` 每轮一个生成器，遇 result 即 break） */
async function readAssistantText(
  session: ReturnType<typeof createSession>,
): Promise<string> {
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

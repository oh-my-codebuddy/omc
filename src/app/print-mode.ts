/**
 * print-mode.ts — `-p/--print` 非交互一次性执行的输出渲染（print-mode P1.3/P1.4）。
 *
 * 与 `renderEventPlain`（人看的降级输出：满标签 + ANSI）**并列但独立**，专供 `-p`：
 * **stdout 只放最终答案**（text 模式 = 答案文本；json 模式 = 单行 JSON），过程事件
 * （tool_* / status / thinking_* / system_init）一律不进 stdout。
 *
 * 本文件只做**状态累积 + 格式化**（不 import pi-tui、不写 stdout/stderr）——I/O 由
 * 调用方（`src/main.ts`）按返回的 `PrintEmission` 落地，故可单测。
 *
 * 取值口径（P0 定论）：
 * - D4：最终答案**优先读 `result` 事件的 `result` 字段**，为空才回退累积的文本
 *   （依据 session-title P0 同类实证：reasoning 型模型 assistant 文本块常为空）。
 * - 失败判据（D5）：`error` 事件 / `result.success !== true` / **一轮结束但既无 `result`
 *   也无 `error`**（P0 定论 2：非法模型实测吐完 `idle`+`init` 就结束、退出码仍 0）。
 * - json 契约（P0 定论 7）：单行 `{success, result, errors, interrupted, session_id, usage}`；
 *   `usage` 用 omc 归一后的 **camelCase `UsageInfo`**；`session_id` **由调用方注入取值器**
 *   （`() => session.sessionId`）—— P0 原计划「取自 `system_init` 事件」已被实测推翻：
 *   全新 `-p` 会话的 SDK 主流里根本没有 `system/init`（见 `#getSessionId` 注释）。
 */
import type { ResultEvent, UIEvent, UsageInfo } from '../agent/types';

export type PrintOutputFormat = 'text' | 'json';

/** `--output-format` 合法值表（帮助文案与校验共用） */
export const PRINT_OUTPUT_FORMATS: readonly PrintOutputFormat[] = ['text', 'json'];

/** `--output-format` 取值校验（缺值传 `''` → false） */
export function isPrintOutputFormat(v: string): v is PrintOutputFormat {
  return v === 'text' || v === 'json';
}

/** json 模式的单行契约（P0 定论 7） */
export interface PrintResultJson {
  success: boolean;
  result?: string;
  errors?: string[];
  interrupted?: boolean;
  session_id?: string;
  usage?: UsageInfo;
}

/** 一次待落地的输出（`undefined` 字段 = 不写） */
export interface PrintEmission {
  /** 写 stdout（json 模式恒单行 + 尾换行；text 模式 = 最终答案 + 尾换行） */
  stdout?: string;
  /** 写 stderr（失败诊断；json 模式下也写，便于人看日志） */
  stderr?: string;
}

/** 无 result 无 error 时的失败原因（P0 定论 2） */
const NO_RESULT_ERROR = 'no result event: session ended without a result or error';

/**
 * 一轮 print 执行的事件累积器。
 *
 * 用法：把 `handleEvent` 收到的每个 UIEvent 喂给 `handle`（返回值非空即写盘）；
 * `runTurn` 返回后再调一次 `finish()` 兜「无 result」的失败路径。
 */
export class PrintRenderer {
  readonly format: PrintOutputFormat;
  /**
   * 会话 id 取值器（由调用方注入 `() => session.sessionId`）。
   *
   * **不要只依赖 `system_init` 事件**：实测（2026-10-13，`-p` 全新会话 + `OMC_DEBUG_STREAM`）
   * SDK 主流里根本没有 `system/init`（首条即 `system/status`，随后直接 stream_event/assistant/result）
   * → 光靠事件捕获会恒得空 session_id。`session.sessionId` 才是权威源（`printResumeHint` 同款）。
   */
  #getSessionId: (() => string | undefined) | null;
  /** `system_init` 的 sessionId（兜底；见 `#getSessionId` 注释） */
  #sessionId: string | null = null;
  /** text_delta 累积（text_final 到达即清空） */
  #delta = '';
  /** 最近一条非空 text_final（D4 回退用） */
  #finalText = '';
  /** 最近一次 result 事件（成功/失败都据此出 json） */
  #result: ResultEvent | null = null;
  /** error 事件收集（失败诊断） */
  #errors: string[] = [];
  /** 是否已写出（幂等：只写首个 result；finish 不再重复） */
  #emitted = false;
  /** 失败标志（error / result 非 success / 无 result） */
  #failed = false;

  constructor(format: PrintOutputFormat, getSessionId?: () => string | undefined) {
    this.format = format;
    this.#getSessionId = getSessionId ?? null;
  }

  /** 是否已判定失败（供调用方决定退出码） */
  get failed(): boolean {
    return this.#failed;
  }

  /** 喂入一个事件；返回非空 = 有内容要落盘（首个 result 事件时产出） */
  handle(ev: UIEvent): PrintEmission | null {
    switch (ev.type) {
      case 'system_init':
        this.#sessionId = ev.sessionId;
        return null;
      case 'text_delta':
        this.#delta += ev.text;
        return null;
      case 'text_final':
        this.#delta = '';
        if (ev.text.trim()) this.#finalText = ev.text;
        return null;
      case 'error':
        this.#failed = true;
        this.#errors.push(ev.detail ? `${ev.message} (${ev.detail})` : ev.message);
        return null;
      case 'result':
        if (this.#emitted) return null; // 幂等：只认首个 result（`-p` 只跑一轮）
        this.#result = ev;
        if (ev.success !== true) {
          this.#failed = true;
          for (const e of ev.errors ?? []) this.#errors.push(e);
        }
        return this.#emit();
      default:
        return null;
    }
  }

  /**
   * 轮末收口：`runTurn` 返回后调用。
   * - 已产出过（正常 result）→ null
   * - 见过 `error` 但本轮无 result → 判失败（text 模式无答案可打，只给 stderr；json 出一行）
   * - 既无 result 也无 error（P0 定论 2 的静默失败）→ 同上
   */
  finish(): PrintEmission | null {
    if (this.#emitted) return null;
    this.#failed = true;
    if (this.#errors.length === 0) this.#errors.push(NO_RESULT_ERROR);
    return this.#emit();
  }

  /** 最终答案：优先 `result.result`（D4），空则回退累积文本 */
  #answer(): string | undefined {
    const r = this.#result?.result;
    if (typeof r === 'string' && r.trim()) return r;
    const fallback = this.#finalText || this.#delta;
    return fallback.trim() ? fallback : undefined;
  }

  /** session id：注入的取值器优先，其次 `system_init` 捕获值 */
  #sid(): string | undefined {
    const injected = this.#getSessionId?.();
    if (injected) return injected;
    return this.#sessionId ?? undefined;
  }

  #emit(): PrintEmission {
    this.#emitted = true;
    const success = !this.#failed;
    const answer = this.#answer();

    if (this.format === 'json') {
      const json: PrintResultJson = { success };
      if (answer !== undefined) json.result = answer;
      if (this.#errors.length > 0) json.errors = this.#errors;
      if (this.#result?.interrupted) json.interrupted = true;
      const sid = this.#sid();
      if (sid) json.session_id = sid;
      if (this.#result?.usage) json.usage = this.#result.usage;
      const em: PrintEmission = { stdout: `${JSON.stringify(json)}\n` };
      if (!success) em.stderr = `${this.#errors.join('; ')}\n`;
      return em;
    }

    // text 模式：stdout 只放最终答案（失败无答案 → 只给 stderr）
    if (success && answer !== undefined) {
      return { stdout: answer.endsWith('\n') ? answer : `${answer}\n` };
    }
    return { stderr: `${this.#errors.join('; ') || 'print mode failed'}\n` };
  }
}

/** 落地一次输出（main.ts 的 I/O 口；单测可断言内容而不触盘） */
export function writePrintEmission(em: PrintEmission | null): void {
  if (!em) return;
  if (em.stdout) process.stdout.write(em.stdout);
  if (em.stderr) process.stderr.write(em.stderr);
}

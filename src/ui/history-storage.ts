/**
 * history-storage.ts（M2.4 适配 / P3.1 扩展）：pi-tui Editor.setHistoryStorage
 * + HistorySearchComponent HistorySource 双契约适配器。
 *
 * 文件格式（~/.config/oh-my-codebuddy/history，JSONL）：
 * - 新行：`{"text": "...", "ts": 1759..., "cwd": "..."}`（cwd 可选）
 * - 旧行：纯 `JSON.stringify(text)` 字符串，兼容读取，created_at 用文件行号兜底
 *   （保证 overlay native key `${created_at}-${hash}` 唯一，见 pi-tui history-search.ts）
 *
 * 返回顺序契约：getRecent/search 均 **newest first**
 * （editor #history[0] = most recent，pi-tui components/editor.ts:715）。
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const MAX_ENTRIES = 1000;

export interface HistoryEntry {
  prompt: string;
  created_at: number;
  cwd?: string;
}

/** 与 pi-tui history-search 组件 queryTokens 同一套切词，保证高亮对齐 */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((tok) => tok.length > 0);
}

export class FileHistoryStorage {
  #file: string;
  /** 仅记最后一条用于连续去重（对齐 MVP push 语义） */
  #last: string | null = null;

  constructor(file: string) {
    this.#file = file;
  }

  async add(prompt: string, cwd?: string): Promise<void> {
    if (prompt === this.#last) return;
    this.#last = prompt;
    try {
      mkdirSync(dirname(this.#file), { recursive: true });
      const record: { text: string; ts: number; cwd?: string } = { text: prompt, ts: Date.now() };
      if (cwd) record.cwd = cwd;
      appendFileSync(this.#file, `${JSON.stringify(record)}\n`);
    } catch {
      // 持久化失败不影响当次提交
    }
  }

  /** 启动加载（文件不存在/读失败静默降级空历史）；尾部 limit 条，newest first */
  getRecent(limit: number): HistoryEntry[] {
    const all = this.#readAll();
    if (all.length > 0) this.#last = all[all.length - 1].prompt;
    return all.slice(-Math.min(limit, MAX_ENTRIES)).reverse();
  }

  /** token-AND 大小写不敏感子串过滤（omp 语义，SQLite/FTS 不抄），去重，newest first */
  search(query: string, limit: number): HistoryEntry[] {
    const tokens = tokenize(query);
    const safeLimit = Math.min(Math.max(0, limit), MAX_ENTRIES);
    if (tokens.length === 0 || safeLimit === 0) return [];
    const all = this.#readAll();
    const seen = new Set<string>();
    const out: HistoryEntry[] = [];
    for (let i = all.length - 1; i >= 0 && out.length < safeLimit; i--) {
      const entry = all[i];
      if (seen.has(entry.prompt)) continue;
      const haystack = entry.prompt.toLowerCase();
      if (!tokens.every((tok) => haystack.includes(tok))) continue;
      seen.add(entry.prompt);
      out.push(entry);
    }
    return out;
  }

  /** 全量读取（尾部 MAX_ENTRIES 条截断），文件顺序 oldest→newest */
  #readAll(): HistoryEntry[] {
    let lines: string[] = [];
    try {
      lines = readFileSync(this.#file, 'utf8').split('\n');
    } catch {
      return [];
    }
    const out: HistoryEntry[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      try {
        const v: unknown = JSON.parse(line);
        if (typeof v === 'string') {
          // 旧格式无时间戳：用行号兜底保证唯一且单调（远小于真实 ms 时间戳）
          out.push({ prompt: v, created_at: i });
        } else if (v !== null && typeof v === 'object' && typeof (v as { text?: unknown }).text === 'string') {
          const rec = v as { text: string; ts?: unknown; cwd?: unknown };
          const entry: HistoryEntry = {
            prompt: rec.text,
            created_at: typeof rec.ts === 'number' ? rec.ts : i,
          };
          if (typeof rec.cwd === 'string') entry.cwd = rec.cwd;
          out.push(entry);
        }
      } catch {
        // 坏行跳过
      }
    }
    return out.slice(-MAX_ENTRIES);
  }
}

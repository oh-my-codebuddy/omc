/**
 * command-usage.ts — slash 命令使用次数持久化（command-usage 阶段 P1.1）。
 *
 * 每次用户提交一条 **命中的** slash 命令（内置 / skill / 自定义 / workflow）时计数 +1，
 * 持久化到 `~/.omc/command-usage.json`（`OMC_CONFIG_DIR` 可覆盖），格式 `{ "<name>": <count> }`。
 * 供 pi-tui `CombinedAutocompleteProvider` 第三参 `commandUsage: (name) => number` 做**次级排序**
 * （同文本匹配分时才按次数降序，精确匹配不受影响；P0 定论见 docs/plan/command-usage/p0-probe.md）。
 *
 * 计数键 = 补全条目 `name` 口径：
 *   - 内置 / 自定义 / workflow = `slash.name`（`parseSlash` 已小写归一）
 *   - skill = `skill:<裸名>`（`skill-slash.ts` 补全条目 name 口径）
 *
 * 设计要点（对齐 usage-daily 的容忍式 IO）：
 *   - **读走进程内 `Map` 缓存**：autocomplete 每次按键对每个候选各调一次 `commandUsage`，
 *     **绝不能触盘**；`reload()` 才重读文件（单测显式调用；运行期不必要）。
 *   - **写走同目录临时文件 + `rename` 原子替换**：避免写一半崩溃留下坏文件。
 *   - 坏 JSON / 非对象 / 数组 → 空表；值非正整数 → 丢弃；写失败静默（记账不挡主流程）。
 *   - 上限 `MAX_NAMES = 500`：写盘按 count 降序裁剪，防卸载的 skill/命令名无界累积。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { commandUsageFile } from '../config/paths';

/** 写盘保留的最大命令名数量（按 count 降序裁剪） */
export const MAX_NAMES = 500;

/** 解析一份原始 JSON 值为合法计数表：容忍坏数据，只保留正有限数值项 */
function parseUsageTable(raw: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!name) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) continue;
    out.set(name, value);
  }
  return out;
}

export class CommandUsageStore {
  #file: string;
  #cache: Map<string, number> | null = null;

  constructor(file: string = commandUsageFile()) {
    this.#file = file;
  }

  /** 首次访问时惰性读盘（进程内缓存；后续命中不触盘） */
  #ensure(): Map<string, number> {
    if (this.#cache) return this.#cache;
    let table = new Map<string, number>();
    try {
      if (existsSync(this.#file)) {
        table = parseUsageTable(JSON.parse(readFileSync(this.#file, 'utf8')));
      }
    } catch {
      // 坏 JSON / 读失败 → 空表（不影响启动）
    }
    this.#cache = table;
    return table;
  }

  /** 某命令当前使用次数（未记录 → 0） */
  get(name: string): number {
    return this.#ensure().get(name) ?? 0;
  }

  /** 记录一次使用（+1）并落盘；返回新计数 */
  record(name: string): number {
    if (!name) return 0;
    const table = this.#ensure();
    const next = (table.get(name) ?? 0) + 1;
    table.set(name, next);
    this.#persist(table);
    return next;
  }

  /** 丢弃缓存，下次 `get`/`record` 重读文件（外部改动后的刷新口；运行期不必调用） */
  reload(): void {
    this.#cache = null;
  }

  /** 原子写盘：按 count 降序裁剪到 MAX_NAMES，临时文件 + rename 替换；失败静默 */
  #persist(table: Map<string, number>): void {
    try {
      const trimmed = [...table.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_NAMES);
      mkdirSync(dirname(this.#file), { recursive: true });
      // Object.fromEntries 只走自有属性定义，不触发 __proto__ setter（防原型污染）
      const payload = JSON.stringify(Object.fromEntries(trimmed));
      const tmp = join(dirname(this.#file), `.command-usage.${process.pid}.${Date.now()}.tmp`);
      writeFileSync(tmp, `${payload}\n`);
      renameSync(tmp, this.#file);
    } catch {
      // 记账失败静默
    }
  }
}

// ---------- 进程单例（autocomplete 回调必须同步且廉价，禁止每次新建实例） ----------
let singleton: CommandUsageStore | null = null;

function store(): CommandUsageStore {
  if (!singleton) singleton = new CommandUsageStore();
  return singleton;
}

/** pi-tui `commandUsage` 回调：同步查表（进程内缓存，不触盘） */
export function getCommandUsage(name: string): number {
  return store().get(name);
}

/** 提交一条命中命令时计数（内置/skill/自定义/workflow 共用） */
export function recordCommandUsage(name: string): number {
  return store().record(name);
}

/** 仅供单测/调试：重置进程单例 */
export function __resetCommandUsageForTest(): void {
  singleton = null;
}

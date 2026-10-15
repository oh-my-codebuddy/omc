/**
 * paths.ts — omc 路径集中管理（plugin 阶段 P1，对齐 omp `packages/utils/src/dirs.ts` 的角色）。
 *
 * 单根布局（D1/D3）：
 *   ~/.omc/
 *     config.json                    # 用户配置
 *     history                        # 输入历史（JSONL）
 *     usage-daily.jsonl              # 用量记账
 *     command-usage.json             # slash 命令使用次数（补全排序权重）
 *     projects/<escaped-cwd>/        # 会话项目目录（可读名 + `.cwd` 侧车，见 projectStoreDir）
 *       <id>.jsonl                   # 会话 transcript
 *     plugins/                       # 插件安装根（本地 symlink / github clone 落点）
 *     plugins.json                   # 插件注册表（enabled/source）
 *     .slots/<name>-<ts>/            # 插件加载槽位（每次加载独立副本，重载隔离）
 *     plugin-data/<name>/            # 插件运行期私有数据（宿主给目录，插件自管文件；P6 追加）
 *   <cwd>/.omc/
 *     config.json                    # 项目级配置
 *
 * `OMC_CONFIG_DIR`（D2）：绝对路径 → 直接作根；相对值 → `~/<值>`；未设 → `~/.omc`。
 *
 * ⚠️ 禁用 `import.meta.dir`：`bun --compile` 下解析成 `/$bunfs/root`（omp #1423）。
 * 所有路径从 `os.homedir()` / `process.cwd()` 出发。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** 目录名（用户根 / 项目根共用的 basename） */
export const CONFIG_DIR_NAME = '.omc';

/** `OMC_CONFIG_DIR` 是否非空（判断是否使用了自定义根，而非默认 `~/.omc`） */
export function isOverrideSet(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.OMC_CONFIG_DIR;
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * 解析用户根：`OMC_CONFIG_DIR`（绝对→原样 / 相对→`~/<值>`）→ 否则 `~/.omc`。
 * `home`/`env` 可注入以便单测（纯函数）。
 */
export function resolveRoot(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.OMC_CONFIG_DIR?.trim();
  if (raw) return isAbsolute(raw) ? raw : join(home, raw);
  return join(home, CONFIG_DIR_NAME);
}

/** 用户根目录（`~/.omc` 或 `OMC_CONFIG_DIR` 结果） */
export function userRoot(): string {
  return resolveRoot();
}

/** 用户级配置 `~/.omc/config.json` */
export function userConfigFile(): string {
  return join(userRoot(), 'config.json');
}

/** 输入历史 `~/.omc/history` */
export function historyFile(): string {
  return join(userRoot(), 'history');
}

/** 用量记账 `~/.omc/usage-daily.jsonl` */
export function usageDailyFile(): string {
  return join(userRoot(), 'usage-daily.jsonl');
}

/** slash 命令使用次数 `~/.omc/command-usage.json`（command-usage 阶段） */
export function commandUsageFile(): string {
  return join(userRoot(), 'command-usage.json');
}

/** 项目目录名字节上限（对齐 CLI `MAX_BYTES`） */
const WORKSPACE_NAME_MAX_BYTES = 255;
/** 超长时的截断上限（对齐 CLI `TRUNCATE_BYTES`） */
const WORKSPACE_NAME_TRUNCATE_BYTES = 180;

/** djb2 base36（对齐 CLI `djb2Base36`；注意 `*` 优先级高于 `^`） */
function djb2Base36(s: string): string {
  const buf = Buffer.from(s, 'utf8');
  let h = 5381;
  for (let i = 0; i < buf.length; i++) h = (33 * h) ^ buf[i];
  return (h >>> 0).toString(36);
}

/** 按码点截断到字节上限（对齐 CLI `truncateToByteLimitOnCodePoint`，不切断多字节字符） */
function truncateToByteLimitOnCodePoint(s: string, limit: number): string {
  let len = 0;
  let out = '';
  for (const ch of s) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (len + n > limit) break;
    len += n;
    out += ch;
  }
  return out;
}

/** 路径 → 目录名基础形态（对齐 CLI `normalizeWorkspacePathBase`，逐字复刻替换链） */
function normalizeWorkspacePathBase(p: string): string {
  return p
    .replace(/[/\\:]/g, '-') // 分隔符（含 Windows 盘符冒号）→ '-'
    .replace(/^-+/, '') // 去前导 '-'
    .replace(/-+$/, '') // 去尾随 '-'
    .replace(/-+/g, '-'); // 折叠连续 '-'
}

/**
 * cwd 绝对路径 → 会话项目目录名（对齐 codebuddy CLI `compressWorkspacePathName`）。
 *
 * 生成可读、按项目分组的目录名（如 `/Users/you/Projects/demo` → `Users-you-Projects-demo`）。
 * 超出 255 字节 → 按码点截到 180 字节 + `-` + `djb2Base36(完整 base)` 尾缀（hash 对**未截断**的
 * base 计算，保证同长前缀的不同路径不撞名）。**纯函数无副作用**；碰撞兜底见 `projectStoreDir`。
 */
export function escapedCwdName(cwd: string): string {
  const base = normalizeWorkspacePathBase(cwd);
  if (Buffer.byteLength(base, 'utf8') <= WORKSPACE_NAME_MAX_BYTES) return base;
  const cut = truncateToByteLimitOnCodePoint(base, WORKSPACE_NAME_TRUNCATE_BYTES);
  return `${cut}-${djb2Base36(base)}`;
}

/** 读 `.cwd` 侧车（首行去空白）；不存在/为空 → null */
function readCwdSidecar(path: string): string | null {
  try {
    const v = readFileSync(path, 'utf8').trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** 进程内缓存：cwd → 已选定项目目录（避免每轮落盘/读侧车都重走建目录 + 写 `.cwd`） */
const projectDirCache = new Map<string, string>();

/**
 * 某 cwd 的会话项目目录 `~/.omc/projects/<escaped-cwd>`（**有副作用**）。
 *
 * 碰撞兜底（D5，omc 增量；CLI 无）：候选名被占用且 `.cwd` 记录的不是本 cwd（或旧数据无 `.cwd`）
 * → 退避 `<候选>-2`、`-3`…。选中新目录时 `mkdir` + 落 `.cwd`（内容 = cwd 绝对路径）。
 * **正常路径下目录名恒定**（`.cwd` 命中即复用，不产生 `-2`）。
 *
 * 幂等短路由进程内 `Map` 兜底（首次调用后不再触盘）。
 */
export function projectStoreDir(cwd: string): string {
  const cached = projectDirCache.get(cwd);
  if (cached) return cached;

  const root = join(userRoot(), 'projects');
  const base = escapedCwdName(cwd);

  for (let attempt = 1; ; attempt++) {
    const dir = join(root, attempt === 1 ? base : `${base}-${attempt}`);
    if (existsSync(dir)) {
      // 已存在：仅当 `.cwd` 记录了同一个 cwd 才复用；否则（内容不符 / 无 `.cwd` 旧数据）退避
      if (readCwdSidecar(join(dir, '.cwd')) === cwd) {
        projectDirCache.set(cwd, dir);
        return dir;
      }
      continue;
    }
    // 新目录：建目录 + 落 `.cwd`（建目录/写盘失败静默 —— 上层落盘同样容错）
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '.cwd'), `${cwd}\n`);
    } catch {
      /* 只读目录等：仍返回路径，写盘由上层容错 */
    }
    projectDirCache.set(cwd, dir);
    return dir;
  }
}

/** 某 cwd 的会话目录 `~/.omc/projects/<escaped-cwd>`（碰撞兜底见 `projectStoreDir`） */
export function sessionsDir(cwd: string): string {
  return projectStoreDir(cwd);
}

/** 插件安装根 `~/.omc/plugins`（本地 symlink / github clone 落点） */
export function pluginsDir(): string {
  return join(userRoot(), 'plugins');
}

/** 插件注册表 `~/.omc/plugins.json`（P2） */
export function pluginRegistryFile(): string {
  return join(userRoot(), 'plugins.json');
}

/**
 * 插件加载槽位根 `~/.omc/.slots`（P2）。
 * 每次加载在 `<root>/<name>-<ts>/` 放插件独立副本 —— Bun 按模块 realpath 缓存，
 * 目录/文件 symlink 与 `?v=` 都不能可靠重置插件自身模块图（2026-10-05 实证），
 * 唯一可靠的重载法是每次新路径 + 独立副本。
 */
export function pluginSlotsDir(): string {
  return join(userRoot(), '.slots');
}

/**
 * 插件运行期私有数据目录 `~/.omc/plugin-data/<name>`（P6 追加）。
 * 宿主只提供**目录**，插件在其中自管文件（对齐 VS Code `globalStorageUri` 惯例）。
 * 与安装落点 `~/.omc/plugins/<name>` 区分：后者是安装产物（symlink / clone），插件不可写。
 */
export function pluginDataDir(name: string): string {
  return join(userRoot(), 'plugin-data', name);
}

/** 项目根 `<cwd>/.omc` */
export function projectRoot(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME);
}

/** 项目级配置 `<cwd>/.omc/config.json` */
export function projectConfigFile(cwd: string): string {
  return join(projectRoot(cwd), 'config.json');
}

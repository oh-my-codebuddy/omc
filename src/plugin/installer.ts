/**
 * installer.ts — 插件安装器（plugin 阶段 P3：本地 symlink / GitHub clone）。
 *
 * 来源两种（D6）：
 * - **本地**：`addLocal(path)` = `symlink(realpath(源), ~/.omc/plugins/<name>)`。
 *   开发友好（改文件热重载生效，不重装）；依赖由用户项目自理。
 * - **GitHub**：`addGithub('owner/repo', ref?)` = staging 内 `git clone --depth 1
 *   [--branch <ref>]` → 读 manifest 定名 → 有依赖则 `bun install` → 记 commit →
 *   `rename` 到 `~/.omc/plugins/<name>`。记 commit 保证可复现/审计。
 *
 * 名称权威来自 `manifest.name`（本地先读源目录；github 先 clone 再读，故用 staging
 * 中转，避免 `owner/repo` 名与 manifest.name 不一致时落错目录）。
 *
 * 注册表落点见 registry.ts：本地记源绝对路径，github 记 `github:<spec>[#<ref>]`。
 * `resolvePluginDir()` 据此决定加载目录（github → 托管目录）。
 *
 * 安全：插件 = 进程内全权限 JS → github 安装须由命令面（P5）显式确认后调用本模块。
 *
 * ⚠️ 禁 `rm` 命令：`remove` 的托管目录删除、以及 staging 失败回滚，一律走 Node `fs`
 * （`rmSync`/`unlinkSync`），不 spawn `rm`。本地安装的**源目录永不触碰**。
 */
import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pluginRegistryFile, pluginsDir } from '../config/paths';
import { readManifest, ManifestError } from './manifest';
import { readRegistry, writeRegistry, type PluginEntry } from './registry';

const execFileP = promisify(execFile);

/** 安装器可预期失败（调用方据此给用户人话提示，而非崩栈） */
export type InstallerErrorCode =
  | 'missing-git'
  | 'missing-bun'
  | 'bad-source'
  | 'not-a-plugin'
  | 'name-conflict'
  | 'already-installed'
  | 'not-found'
  | 'clone-failed'
  | 'install-failed';

export class InstallerError extends Error {
  constructor(
    readonly code: InstallerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'InstallerError';
  }
}

/** 安装结果（命令面用于回显） */
export interface AddResult {
  /** 权威插件名（manifest.name） */
  name: string;
  /** 安装落点（`~/.omc/plugins/<name>`；本地为指向源目录的 symlink） */
  dir: string;
  /** 写入注册表的 source（本地 = 源绝对路径 / github = `github:<spec>[#<ref>]`） */
  source: string;
  /** github 源记录的 commit（本地无） */
  commit?: string;
}

/** 工具探测结果 */
export interface ToolStatus {
  git: boolean;
  bun: boolean;
}

/** 命令是否在 PATH 中可执行（存在 + X_OK）；`env.PATH` 注入以便单测 */
export function hasCommand(cmd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const path = env.PATH ?? '';
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, cmd), constants.X_OK);
      return true;
    } catch {
      // 继续找
    }
  }
  return false;
}

/** 前置检查：git（github 源）、bun（装依赖）是否就绪 */
export function checkTools(env: NodeJS.ProcessEnv = process.env): ToolStatus {
  return { git: hasCommand('git', env), bun: hasCommand('bun', env) };
}

/**
 * 本地安装：symlink 源目录到 `~/.omc/plugins/<name>` 并写注册表。
 * 源目录须是合法插件（package.json#omc 通过门禁）；name 冲突 / 目标已存在 → 抛错。
 */
export function addLocal(path: string): AddResult {
  let abs: string;
  try {
    abs = realpathSync(resolve(path));
  } catch {
    throw new InstallerError('bad-source', `本地路径不存在或不可访问：${path}`);
  }
  if (!isDir(abs)) throw new InstallerError('bad-source', `本地路径不是目录：${abs}`);

  const manifest = readManifestOrThrow(abs);
  const name = manifest.name;

  const reg = readRegistry();
  if (reg.plugins[name]) {
    throw new InstallerError('name-conflict', `插件名已被占用：${name}（先 remove 再安装）`);
  }
  const dest = join(pluginsDir(), name);
  if (existsSync(dest)) {
    throw new InstallerError('already-installed', `安装目录已存在：${dest}`);
  }

  mkdirSync(pluginsDir(), { recursive: true });
  symlinkSync(abs, dest, 'dir');

  reg.plugins[name] = { source: abs, enabled: true, api: manifest.api };
  writeRegistry(reg);
  return { name, dir: dest, source: abs };
}

export interface AddGithubOptions {
  /** 环境（PATH 探测 + 子进程 env；注入以便单测缺工具场景） */
  env?: NodeJS.ProcessEnv;
}

/**
 * GitHub 安装：`git clone --depth 1 [--branch <ref>]` 到 staging → 读 manifest 定名 →
 * 有依赖则 `bun install` → 记 commit → rename 到 `~/.omc/plugins/<name>` → 写注册表。
 *
 * @param spec `owner/repo` / `github:owner/repo` / 完整 URL / 可被 git 克隆的本地路径
 *             （本地路径形式主要用于测试：`github:/tmp/x/repo`）
 * @param ref  分支/标签/commit；缺省取 spec 内 `#<ref>`（两者都给时以参数为准）
 */
export async function addGithub(
  spec: string,
  ref?: string,
  opts: AddGithubOptions = {},
): Promise<AddResult> {
  const env = opts.env ?? process.env;
  const tools = checkTools(env);
  if (!tools.git) {
    throw new InstallerError(
      'missing-git',
      '未找到 git，无法从 GitHub 安装；请先安装 git（或改用本地路径安装）',
    );
  }

  const parsed = parseGithubSpec(spec, ref);
  mkdirSync(pluginsDir(), { recursive: true });
  const staging = join(pluginsDir(), `.staging-${Date.now().toString(36)}-${rand()}`);

  const cloneArgs = ['clone', '--depth', '1'];
  if (parsed.ref) cloneArgs.push('--branch', parsed.ref);
  cloneArgs.push(parsed.url, staging);
  try {
    await runCapture('git', cloneArgs, env);
  } catch (e) {
    safeRemove(staging);
    throw new InstallerError('clone-failed', `git clone 失败：${errText(e)}`);
  }

  let manifest;
  try {
    manifest = readManifest(staging);
  } catch (e) {
    safeRemove(staging);
    throw new InstallerError('not-a-plugin', `克隆内容不是合法插件：${errText(e)}`);
  }
  const name = manifest.name;

  const reg = readRegistry();
  if (reg.plugins[name]) {
    safeRemove(staging);
    throw new InstallerError('name-conflict', `插件名已被占用：${name}（先 remove 再安装）`);
  }
  const dest = join(pluginsDir(), name);
  if (existsSync(dest)) {
    safeRemove(staging);
    throw new InstallerError('already-installed', `安装目录已存在：${dest}`);
  }

  if (needsInstall(staging)) {
    if (!tools.bun) {
      safeRemove(staging);
      throw new InstallerError(
        'missing-bun',
        '插件声明了依赖但未找到 bun；请先安装 bun，或改用已预置 node_modules 的插件',
      );
    }
    try {
      await runCapture('bun', ['install'], env, staging);
    } catch (e) {
      safeRemove(staging);
      throw new InstallerError('install-failed', `bun install 失败：${errText(e)}`);
    }
  }

  const commit = await captureCommit(staging, env);

  renameSync(staging, dest);
  const entry: PluginEntry = { source: parsed.source, enabled: true, api: manifest.api };
  if (commit) entry.commit = commit;
  reg.plugins[name] = entry;
  writeRegistry(reg);
  return { name, dir: dest, source: parsed.source, ...(commit ? { commit } : {}) };
}

/** 卸载结果 */
export interface RemoveResult {
  name: string;
  /** github 源被删除的托管目录（本地源为 undefined——只解链，源目录不动） */
  removedDir?: string;
}

/**
 * 卸载：github 源删除 `~/.omc/plugins/<name>` 托管目录（Node fs，规避 rm 命令）；
 * 本地源只解链 symlink（**源目录永不触碰**）。随后从注册表移除。
 */
export function remove(name: string): RemoveResult {
  const reg = readRegistry();
  const entry = reg.plugins[name];
  if (!entry) throw new InstallerError('not-found', `插件未安装：${name}`);

  const managed = join(pluginsDir(), name);
  if (entry.source.startsWith('github:')) {
    if (existsSync(managed)) rmSync(managed, { recursive: true, force: true });
    delete reg.plugins[name];
    writeRegistry(reg);
    return { name, removedDir: managed };
  }

  // 本地：仅删除托管目录里的 symlink（lstat 判定，防误删真实目录）
  try {
    if (lstatSync(managed).isSymbolicLink()) unlinkSync(managed);
  } catch {
    // 链不存在（已手工清理）→ 无操作
  }
  delete reg.plugins[name];
  writeRegistry(reg);
  return { name };
}

/** 启用/停用（改注册表 enabled 位；触发 host reload 由调用方命令面负责，见 P5） */
export function setEnabled(name: string, enabled: boolean): void {
  const reg = readRegistry();
  const entry = reg.plugins[name];
  if (!entry) throw new InstallerError('not-found', `插件未安装：${name}`);
  entry.enabled = enabled;
  writeRegistry(reg);
}

export function enable(name: string): void {
  setEnabled(name, true);
}

export function disable(name: string): void {
  setEnabled(name, false);
}

// —— 内部工具 ——

interface ParsedGithub {
  /** 传给 git clone 的 URL（或本地路径） */
  url: string;
  /** 写入注册表的 source（恒以 `github:` 起头，供 resolvePluginDir 识别为托管源） */
  source: string;
  ref?: string;
}

/** 解析 `[github:]owner/repo[#ref]`；URL/本地路径原样作 clone 目标 */
function parseGithubSpec(spec: string, refOverride?: string): ParsedGithub {
  let s = spec.trim().replace(/^github:/, '');
  if (!s) throw new InstallerError('bad-source', 'github 源为空');

  let ref = refOverride?.trim() || undefined;
  const hash = s.indexOf('#');
  if (hash >= 0) {
    if (!ref) ref = s.slice(hash + 1).trim() || undefined;
    s = s.slice(0, hash);
  }
  if (!s) throw new InstallerError('bad-source', `github 源缺少 owner/repo：${spec}`);

  const url = resolveUrl(s);
  const source = `github:${s}${ref ? `#${ref}` : ''}`;
  return { url, source, ...(ref ? { ref } : {}) };
}

/** owner/repo → GitHub HTTPS；完整 URL / 本地路径（含测试用 `github:/tmp/x`）原样 */
function resolveUrl(s: string): string {
  if (s.includes('://') || s.startsWith('git@')) return s;
  if (isAbsolute(s) || s.startsWith('.') || existsSync(resolve(s))) return s;
  return `https://github.com/${s}.git`;
}

/** 插件是否声明了依赖（需 bun install） */
function needsInstall(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
    for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const deps = pkg[key];
      if (deps !== null && typeof deps === 'object' && !Array.isArray(deps) && Object.keys(deps).length > 0) {
        return true;
      }
    }
  } catch {
    // 无 package.json（readManifest 已在前面拦过）→ 不装依赖
  }
  return false;
}

async function captureCommit(dir: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const out = await runCapture('git', ['-C', dir, 'rev-parse', 'HEAD'], env);
    const sha = out.trim();
    return sha || undefined;
  } catch {
    return undefined; // 非 git 仓库（本地路径 clone 也可能无历史）→ 不记
  }
}

/** 执行命令并返回 stdout；失败抛原错（由调用方包成 InstallerError） */
async function runCapture(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
): Promise<string> {
  const { stdout } = await execFileP(file, args, { env, cwd, maxBuffer: 16 * 1024 * 1024 });
  return String(stdout);
}

/** 读 manifest，失败统一转 InstallerError（人话） */
function readManifestOrThrow(dir: string) {
  try {
    return readManifest(dir);
  } catch (e) {
    const detail = e instanceof ManifestError ? e.message : errText(e);
    throw new InstallerError('not-a-plugin', `不是合法插件：${detail}`);
  }
}

function isDir(p: string): boolean {
  try {
    return lstatSync(p).isDirectory() || lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** 失败回滚：清 staging（Node fs；不 spawn rm） */
function safeRemove(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 回滚失败不掩盖原始错误
  }
}

function errText(e: unknown): string {
  if (e instanceof Error) {
    const stderr = (e as { stderr?: unknown }).stderr;
    const tail = typeof stderr === 'string' && stderr.trim() ? ` (${stderr.trim().split('\n').slice(-1)[0]})` : '';
    return `${e.message}${tail}`;
  }
  return String(e);
}

function rand(): string {
  return Math.random().toString(36).slice(2, 8);
}

/**
 * clipboard.ts — macOS 剪贴板图片读取。
 *
 * 顺序：«class furl» 文件 URL 优先（Finder 复制文件 → 读真实文件，避开
 * 1024x1024 通用图标 flavor）→ `pngpaste -`（stdout 出 PNG）→ osascript
 * 取 «class PNGf» hex 解析。
 * 统一落盘 /tmp/oh-my-codebuddy/paste-<ts>.png（临时文件约定目录；文件 URL
 * 路径除外——链接直接指原文件）。>20MB 拒绝（对齐 omp 的 MAX_IMAGE_INPUT_BYTES）。
 * 只用 Node 标准 API。
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const TMP_DIR = '/tmp/oh-my-codebuddy';

/** 扩展名 → 媒体类型（对齐 SDK ImageMediaType） */
const EXT_MEDIA: Record<string, 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export interface ImageData {
  data: Buffer;
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
}

export type ClipboardImage =
  | { ok: true; image: ImageData; path: string }
  | { ok: false; reason: 'no-image' | 'too-large' | 'no-tool' };

/**
 * ⌘V 补救：粘贴文本若是已存在的图片文件路径（Finder 复制图片文件后 ⌘V 的场景），
 * 读出图片。返回 null 表示不是图片路径（按普通文本处理）。
 * 容忍首尾空白与 shell 转义/引号。
 */
export function imageFromPathText(text: string): ImageData | null {
  let p = text.trim();
  if (p.includes('\n')) return null; // 多行不按路径处理
  if ((p.startsWith("'") && p.endsWith("'")) || (p.startsWith('"') && p.endsWith('"'))) {
    p = p.slice(1, -1);
  }
  p = p.replace(/\\([ ])/g, '$1'); // Finder 拖入的空格转义
  const ext = /\.[a-z]+$/i.exec(p)?.[0].toLowerCase();
  const mediaType = ext ? EXT_MEDIA[ext] : undefined;
  if (!mediaType) return null;
  try {
    if (!existsSync(p)) return null;
    if (statSync(p).size > MAX_IMAGE_BYTES) return null;
    return { data: readFileSync(p), mediaType };
  } catch {
    return null;
  }
}

/**
 * 写文本到系统剪贴板（custom-commands P5 `/copy`）。
 * macOS 走 `pbcopy`（stdin 传文本）；非 macOS / 无 pbcopy → false（调用方给提示）。
 * 只用 Node 标准 API（同本模块既有约定）。
 */
export function writeClipboardText(text: string): boolean {
  try {
    execFileSync('pbcopy', { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function exec(cmd: string, args: string[]): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'buffer', maxBuffer: MAX_IMAGE_BYTES * 2 }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(err);
        return;
      }
      resolve({
        code: err && typeof err.code === 'number' ? err.code : 0,
        stdout: stdout as Buffer,
        stderr: String(stderr),
      });
    });
  });
}

/** osascript 输出 «data PNGf<hex>» → PNG 字节；无法解析返回 null（导出以便单测） */
export function parseOsascriptPng(out: string): Buffer | null {
  const m = /«data PNGf([0-9A-Fa-f\s]+)»/.exec(out);
  if (!m) return null;
  const hex = m[1].replace(/\s/g, '');
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  const buf = Buffer.from(hex, 'hex');
  // PNG 魔数校验
  return buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 ? buf : null;
}

async function viaPngpaste(): Promise<ClipboardImage | null> {
  try {
    const r = await exec('pngpaste', ['-']);
    if (r.code !== 0 || r.stdout.length === 0) return { ok: false, reason: 'no-image' };
    return finalize(r.stdout);
  } catch {
    return null; // pngpaste 未安装
  }
}

async function viaOsascript(): Promise<ClipboardImage> {
  try {
    const r = await exec('osascript', ['-e', 'get the clipboard as «class PNGf»']);
    const buf = parseOsascriptPng(r.stdout.toString('utf8'));
    if (!buf) return { ok: false, reason: 'no-image' };
    return finalize(buf);
  } catch {
    return { ok: false, reason: 'no-tool' };
  }
}

/**
 * Finder 文件复制优先（M4.1 验收发现）：macOS 对文件复制会在图片 flavor 放一张
 * 1024x1024 通用文件图标图（pngpaste 会误读成"图片"），真实图片在文件本身。
 * 剪贴板带 «class furl» 且是图片文件 → 直接读文件；否则 null 走后续 flavor。
 * 多文件/无文件 flavor 时 osascript 报错 → null。
 */
async function viaFileUrl(): Promise<ClipboardImage | null> {
  try {
    const r = await exec('osascript', ['-e', 'POSIX path of (the clipboard as «class furl»)']);
    if (r.code !== 0) return null;
    const p = r.stdout.toString('utf8').trim();
    if (!p) return null;
    const img = imageFromPathText(p);
    if (!img) return null;
    // 链接指向原文件（比 tmp 副本更有用），不落 tmp
    return { ok: true, image: img, path: p };
  } catch {
    return null;
  }
}

function finalize(png: Buffer): ClipboardImage {
  if (png.length > MAX_IMAGE_BYTES) return { ok: false, reason: 'too-large' };
  const path = saveTmpImage(png, '.png');
  return { ok: true, image: { data: png, mediaType: 'image/png' }, path };
}

/** 落盘 /tmp/oh-my-codebuddy/paste-<ts><ext>（约定目录；失败不阻断，返回路径仅作展示） */
export function saveTmpImage(data: Buffer, ext: string): string {
  const path = `${TMP_DIR}/paste-${Date.now()}${ext}`;
  try {
    writeFileSync(path, data);
  } catch {
    // 落盘失败不阻断：仍可直接用内存字节
  }
  return path;
}

/** 读剪贴板图片。文件复制优先读真实文件；截图等走 PNG flavor。无图/无工具/超限均优雅降级 */
export async function readClipboardImage(): Promise<ClipboardImage> {
  const f = await viaFileUrl();
  if (f) return f;
  const r = await viaPngpaste();
  if (r !== null) return r;
  return viaOsascript();
}

/**
 * 读剪贴板文本（smart paste 回落，对齐 omp #1628：pasteImage 无图时贴文本）。
 * pbpaste 无文本 flavor 输出空 → null；pbpaste 不可用 → null。
 */
export async function readClipboardText(): Promise<string | null> {
  try {
    const r = await exec('pbpaste', []);
    if (r.code !== 0) return null;
    const text = r.stdout.toString('utf8');
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

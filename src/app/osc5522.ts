/**
 * osc5522.ts — OSC 5522（kitty 剪贴板协议）应用主动读取。
 *
 * 流程（参考 omp utils/enhanced-paste.ts，简化为仅图片、仅 app 发起）：
 *   1. requestPaste() 发枚举请求 `\x1b]5522;type=read;Lg==`（payload = base64 "."）
 *   2. 终端回 OK → DATA(mime=".", payload=空格分隔的 MIME 列表) → DONE
 *   3. 按优先级挑图片 MIME，带 pw+name 发读取请求（kitty ≥0.42.2 一次授权免重复提示）
 *   4. 终端回 OK → DATA 分块（≤4096B/块，base64）→ DONE，拼出图片字节
 *
 * 不启用 `\x1b[?5522h` paste-event 模式：那会劫持 ⌘V（kitty 不再走 bracketed
 * paste 文本路径，且 Finder 复制的图标位图会盖过文件本体，omp #8769 的坑）。
 * 终端不响应由调用方超时降级（pngpaste/osascript）。
 */
import { randomUUID } from 'node:crypto';
/** OSC 5522 包前缀（原 src/tui/keys.ts，pi-tui 迁移后自研 KeyParser 删除，常量内联） */
const OSC5522_PREFIX = '\x1b]5522;';
import { MAX_IMAGE_BYTES, type ImageData } from './clipboard';

const BEL = '\x07';
const ST = '\x1b\\';

/** 枚举剪贴板 MIME 列表的 sentinel（base64 "."） */
const LIST_REQUEST = `${OSC5522_PREFIX}type=read;Lg==${BEL}`;

const IMAGE_MIME_PRIORITY = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

/** kitty ≥0.42.2 用 pw+name 记住授权，避免每次读取都弹确认 */
const PW = Buffer.from(randomUUID(), 'utf8').toString('base64');
const NAME = Buffer.from('oh-my-codebuddy', 'utf8').toString('base64');

export interface Osc5522Handlers {
  write(data: string): void;
  /** 事务内收到第一个响应包（调用方据此取消静默降级定时器） */
  onFirstResponse(): void;
  onImage(image: ImageData): void;
  /** 终端明确回答但剪贴板没有图片 */
  onNoImage(): void;
  /** 终端拒绝/不支持读取（ENOSYS/EPERM/EBUSY）：调用方应降级系统剪贴板工具 */
  onRejected(message: string): void;
  /** 错误/异常提示（超限等） */
  onStatus(message: string): void;
}

interface ListingState {
  phase: 'listing';
  mimes: string[];
  /** kitty 风格：列表装在 mime="." 的 DATA payload 里（后续读取也用 payload 形式） */
  kittyDotPayload?: true;
}

interface ReadingState {
  phase: 'reading';
  mediaType: ImageData['mediaType'];
  chunks: string[];
  bytes: number;
}

type State = ListingState | ReadingState;

function decodeBase64Utf8(value: string): string | undefined {
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return undefined;
  }
}

/** 解析完整 5522 包（含前缀与终止符），非法返回 undefined（导出以便单测） */
export function parseOsc5522Packet(data: string): { metadata: Map<string, string>; payload: string } | undefined {
  if (!data.startsWith(OSC5522_PREFIX)) return undefined;
  const bodyEnd = data.endsWith(BEL) ? data.length - 1 : data.endsWith(ST) ? data.length - ST.length : -1;
  if (bodyEnd < 0) return undefined;
  const body = data.slice(OSC5522_PREFIX.length, bodyEnd);
  const sep = body.indexOf(';');
  const metadata = new Map<string, string>();
  for (const part of (sep === -1 ? body : body.slice(0, sep)).split(':')) {
    const eq = part.indexOf('=');
    if (eq > 0) metadata.set(part.slice(0, eq), part.slice(eq + 1));
  }
  return { metadata, payload: sep === -1 ? '' : body.slice(sep + 1) };
}

export class Osc5522Clipboard {
  private state: State | undefined;
  private readonly handlers: Osc5522Handlers;

  constructor(handlers: Osc5522Handlers) {
    this.handlers = handlers;
  }

  /** 是否有未完成的事务（进行中新请求直接忽略） */
  get busy(): boolean {
    return this.state !== undefined;
  }

  /** 发起枚举请求（Ctrl-V 入口）。busy 时忽略 */
  requestPaste(): void {
    if (this.state) return;
    this.state = { phase: 'listing', mimes: [] };
    this.handlers.write(LIST_REQUEST);
  }

  /** 放弃当前事务（超时降级 / 中断时调用） */
  reset(): void {
    this.state = undefined;
  }

  /** 喂入完整 5522 包文本（keys.ts 已保证完整性） */
  handlePacket(raw: string): void {
    const packet = parseOsc5522Packet(raw);
    if (!packet) return;
    if (packet.metadata.get('type') !== 'read') return;
    this.handlers.onFirstResponse();

    const status = packet.metadata.get('status');
    if (status === 'OK') {
      // 读取阶段的 OK 无需处理（omp 同款）；空闲时收到 OK 视为 unsolicited
      // paste event（终端自行启用了 5522 模式），按列表事务接管
      if (!this.state) this.state = { phase: 'listing', mimes: [] };
      return;
    }
    if (status === 'DATA') {
      this.handleData(packet.metadata.get('mime'), packet.payload);
      return;
    }
    if (status === 'DONE') {
      this.handleDone();
      return;
    }
    if (status) {
      this.state = undefined;
      const msg = {
        ENOSYS: '[paste] 终端不支持 5522 直读，改用系统剪贴板工具',
        EPERM: '[paste] 终端拒绝直读，改用系统剪贴板工具（kitty.conf 加 read-clipboard-ask 可直读）',
        EBUSY: '[paste] 终端剪贴板忙，改用系统剪贴板工具',
      }[status];
      this.handlers.onRejected(msg ?? `[paste] 终端剪贴板读取失败（${status}），改用系统剪贴板工具`);
    }
  }

  private handleData(encodedMime: string | undefined, payload: string): void {
    const state = this.state;
    if (!state || !encodedMime) return;
    const mime = decodeBase64Utf8(encodedMime);
    if (!mime) return;

    if (state.phase === 'listing') {
      // kitty 把列表装在单个 mime="." 的 payload 里；ancillary spec 是每个
      // DATA 一个 mime、空 payload。两种都支持（omp 同款逻辑）
      if (mime === '.') {
        if (!payload) return;
        const listing = decodeBase64Utf8(payload);
        if (!listing) return;
        state.kittyDotPayload = true;
        for (const m of listing.split(/\s+/)) {
          if (m && m !== '.') state.mimes.push(m);
        }
        return;
      }
      state.mimes.push(mime);
      return;
    }

    if (state.mediaType === mime && payload) {
      // 尺寸守卫：边收边算，超限即弃（防恶意/异常终端撑爆内存）
      state.bytes += Math.floor(payload.length / 4) * 3;
      if (state.bytes > MAX_IMAGE_BYTES) {
        this.state = undefined;
        this.handlers.onStatus('[paste] 图片超过 20MB，已拒绝');
        return;
      }
      state.chunks.push(payload);
    }
  }

  private handleDone(): void {
    const state = this.state;
    if (!state) return;

    if (state.phase === 'listing') {
      const mediaType = IMAGE_MIME_PRIORITY.find((m) => state.mimes.includes(m));
      if (!mediaType) {
        this.state = undefined;
        this.handlers.onNoImage();
        return;
      }
      this.state = { phase: 'reading', mediaType, chunks: [], bytes: 0 };
      const encoded = Buffer.from(mediaType, 'utf8').toString('base64');
      if (state.kittyDotPayload) {
        // kitty 风格：MIME 放 payload（spec 标准形式）
        this.handlers.write(`${OSC5522_PREFIX}type=read:pw=${PW}:name=${NAME};${encoded}${BEL}`);
      } else {
        // ancillary spec：MIME 放 metadata
        this.handlers.write(`${OSC5522_PREFIX}type=read:pw=${PW}:name=${NAME}:mime=${encoded}${BEL}`);
      }
      return;
    }

    this.state = undefined;
    if (state.chunks.length === 0) {
      this.handlers.onNoImage();
      return;
    }
    const data = Buffer.concat(state.chunks.map((c) => Buffer.from(c, 'base64')));
    if (data.byteLength === 0) {
      this.handlers.onNoImage();
      return;
    }
    this.handlers.onImage({ data, mediaType: state.mediaType });
  }
}

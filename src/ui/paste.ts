/**
 * paste.ts（M2.1+M2.2）：Ctrl-V / ⌘V 图片粘贴与 OSC 5522 跨 chunk 重组。
 *
 * - 键位：app.clipboard.pasteImage 绑 ctrl+v + super+v（对齐 omp darwin 表；
 *   ⌘V 经 kitty 键盘协议上报为 super+v=\x1b[118;9u，见 docs/todo/image-paste-v1.md）
 * - onPasteImage：系统工具优先（pngpaste/osascript）；no-tool → 5522 终端直读
 *   兜底 + 800ms 静默超时（MVP 逻辑整体搬移）；no-image → smart paste 回落贴
 *   剪贴板文本（对齐 omp #1628），图文皆无才提示
 * - onPasteImagePath：bracketed paste 来的图片文件路径 → 附件（替代 MVP
 *   imageFromPathText 分支，CustomEditor 已内建路径检测）
 * - 挂图走 omp 范式：pendingImages/pendingImageLinks + insertAtom(chip, 展开占位符)
 * - 5522 响应重组：addInputListener 跨 chunk 缓冲，完整包（BEL/ST 终止）喂
 *   osc5522.handlePacket，普通按键数据放行
 */
import { chipLabel, compactImageMarkers } from '@oh-my-pi/pi-tui/prompt/composer-attachments.js';
import type { CustomEditor } from '@oh-my-pi/pi-tui/prompt/custom-editor.js';
import type { TUI } from '@oh-my-pi/pi-tui';
import type { ImageContent } from '@oh-my-pi/pi-ai';
import {
  imageFromPathText,
  readClipboardImage,
  readClipboardText,
  saveTmpImage,
  type ClipboardImage,
  type ImageData,
} from '../app/clipboard';
import { Osc5522Clipboard } from '../app/osc5522';

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const MEDIA_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

const OSC5522_PREFIX = '\x1b]5522;';
const BEL = '\x07';
const ST = '\x1b\\';

export interface PasteDeps {
  editor: CustomEditor;
  tui: TUI;
  /** 信息行进转录区（bridge.addInfoLines） */
  info: (lines: string[]) => void;
  /** 测试注入：覆盖剪贴板图片/文本读取（默认系统剪贴板） */
  readImage?: () => Promise<ClipboardImage>;
  readText?: () => Promise<string | null>;
}

/** 提交时的图片收集结果 */
export interface SubmissionImages {
  /** 重映射后的文本（占位符编号已压缩连续） */
  text: string;
  /** 按占位符编号顺序的图片（与文本中 [Image #N] 对应） */
  images: ImageContent[];
  /** 与 images 对齐的来源链接（用户气泡 chip 超链接回显用） */
  imageLinks: (string | undefined)[];
}

export class PasteController {
  #deps: PasteDeps;
  #osc5522: Osc5522Clipboard;
  /** Ctrl-V 后等待 5522 响应的降级定时器 */
  #fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  /** 5522 跨 chunk 重组缓冲 */
  #packetBuf = '';

  constructor(deps: PasteDeps) {
    this.#deps = deps;
    this.#osc5522 = new Osc5522Clipboard({
      write: (d) => deps.tui.terminal.write(d),
      onFirstResponse: () => {
        if (this.#fallbackTimer) {
          clearTimeout(this.#fallbackTimer);
          this.#fallbackTimer = null;
        }
      },
      onImage: (image) => {
        const path = saveTmpImage(image.data, MEDIA_EXT[image.mediaType] ?? '.png');
        void this.attachImage(image, path);
        deps.info([`${DIM}[paste] 已粘贴（${(image.data.length / 1024).toFixed(0)}KB → ${path}，终端协议）${RESET}`]);
      },
      onNoImage: () => deps.info([`${DIM}[paste] 剪贴板中没有图片${RESET}`]),
      onRejected: (m) => deps.info([`${DIM}${m}${RESET}`]),
      onStatus: (m) => deps.info([`${DIM}${m}${RESET}`]),
    });

    deps.editor.onPasteImage = () => this.onPasteImage();
    deps.editor.onPasteImagePath = (path) => this.onPasteImagePath(path);
    // 对齐 omp：darwin 下 ⌘V 经 kitty 键盘协议上报为 super+v（\x1b[118;9u），
    // DEFAULT_ACTION_KEYS 只有 ctrl+v 会静默落空；omp 在 input-controller.ts:640
    // 显式补绑，这里同步（getDefaultPasteImageKeys('darwin') 等价表）。
    deps.editor.setActionKeys('app.clipboard.pasteImage', ['ctrl+v', 'super+v']);
  }

  /** 5522 input-listener：跨 chunk 重组（注册到 tui.addInputListener） */
  readonly inputListener = (data: string): { consume?: boolean; data?: string } | undefined => {
    if (this.#packetBuf === '' && !data.includes(OSC5522_PREFIX)) {
      // 前缀本身被 chunk 切断的可能（如结尾 "\x1b]55"）：挂起等齐
      for (let k = Math.min(data.length, OSC5522_PREFIX.length - 1); k > 0; k--) {
        if (OSC5522_PREFIX.startsWith(data.slice(-k))) {
          this.#packetBuf = data.slice(-k);
          const head = data.slice(0, -k);
          return head === '' ? { consume: true } : { data: head };
        }
      }
      return undefined;
    }
    let s = this.#packetBuf + data;
    this.#packetBuf = '';
    let out = '';
    let i = 0;
    while (i < s.length) {
      const p = s.indexOf(OSC5522_PREFIX, i);
      if (p === -1) {
        out += s.slice(i);
        break;
      }
      out += s.slice(i, p); // 包前普通数据放行
      const bel = s.indexOf(BEL, p + OSC5522_PREFIX.length);
      const st = s.indexOf(ST, p + OSC5522_PREFIX.length);
      let end = -1;
      if (bel !== -1 && (st === -1 || bel < st)) end = bel + 1;
      else if (st !== -1) end = st + ST.length;
      if (end === -1) {
        this.#packetBuf = s.slice(p); // 包未收全，等后续 chunk
        break;
      }
      this.#osc5522.handlePacket(s.slice(p, end));
      i = end;
    }
    return out === '' ? { consume: true } : { data: out };
  };

  /** 挂图（omp 范式 input-controller.ts:1830-1855）：chip + 原子展开占位符 */
  async attachImage(img: ImageData, link?: string): Promise<void> {
    const { editor, tui } = this.#deps;
    const image: ImageContent = { type: 'image', data: img.data.toString('base64'), mimeType: img.mediaType };
    editor.pendingImages.push(image);
    editor.pendingImageLinks.push(link);
    editor.imageLinks = editor.pendingImageLinks;
    const n = editor.pendingImages.length;
    const dims = await imageDimensions(img.data);
    const expansion = dims ? `[Image #${n}, ${dims.width}x${dims.height}]` : `[Image #${n}]`;
    editor.insertAtom(chipLabel('image', n), expansion);
    tui.requestRender();
  }

  /**
   * Ctrl-V / ⌘V（super+v）：系统工具优先（零终端配置）；仅 no-tool（SSH/未安装）
   * 走 5522 终端直读兜底，800ms 静默超时。
   * 无图时 smart paste 回落：剪贴板有文本则贴文本（对齐 omp #1628），
   * 图文皆无才提示。
   */
  async onPasteImage(): Promise<boolean> {
    const { editor, info } = this.#deps;
    const readImage = this.#deps.readImage ?? readClipboardImage;
    const r = await readImage();
    if (r.ok) {
      await this.attachImage(r.image, r.path);
      info([`${DIM}[paste] 已粘贴（${(r.image.data.length / 1024).toFixed(0)}KB → ${r.path}）${RESET}`]);
      return true;
    }
    if (r.reason === 'no-tool') {
      if (!this.#osc5522.busy && !this.#fallbackTimer) {
        this.#osc5522.requestPaste();
        this.#fallbackTimer = setTimeout(() => {
          this.#fallbackTimer = null;
          this.#osc5522.reset();
          info([`${DIM}[paste] 无可用剪贴板工具（需 pngpaste 或 osascript），终端也未响应直读${RESET}`]);
        }, 800);
      }
      return true;
    }
    if (r.reason === 'no-image') {
      const readText = this.#deps.readText ?? readClipboardText;
      const text = await readText();
      if (text !== null) {
        editor.pasteText(text);
        return true;
      }
      info([`${DIM}[paste] 剪贴板中没有图片${RESET}`]);
      return true;
    }
    info([`${DIM}[paste] 图片超过 20MB，已拒绝${RESET}`]);
    return true;
  }

  /** bracketed paste 检测到的图片文件路径（Ghostty ⌘V 落盘路径场景） */
  async onPasteImagePath(path: string): Promise<void> {
    const img = imageFromPathText(path);
    if (!img) {
      this.#deps.info([`${DIM}[paste] 图片路径读取失败：${path}${RESET}`]);
      return;
    }
    await this.attachImage(img, path);
    this.#deps.info([`${DIM}[paste] 已附加（图片路径粘贴，${(img.data.length / 1024).toFixed(0)}KB）${RESET}`]);
  }

  /**
   * 提交时收集：compactImageMarkers 剔除已删 chip 并重映射编号
   * （composer-attachments.ts:271），返回按新编号排序的图片列表。
   */
  collectSubmission(text: string): SubmissionImages {
    const { editor } = this.#deps;
    const compact = compactImageMarkers(text, editor.pendingImages.length);
    if (!compact) {
      return { text, images: editor.pendingImages.slice(), imageLinks: editor.pendingImageLinks.slice() };
    }
    return {
      text: compact.text,
      images: compact.keep.map((i) => editor.pendingImages[i]!),
      imageLinks: compact.keep.map((i) => editor.pendingImageLinks[i]),
    };
  }
}

/** 图片像素尺寸探针（喂占位符 `[Image #N, WxH]`；失败落裸标签） */
async function imageDimensions(data: Buffer): Promise<{ width: number; height: number } | undefined> {
  try {
    const { width, height } = await new Bun.Image(data).metadata();
    if (width && height) return { width, height };
  } catch {
    // 未知/损坏头：裸标签
  }
  return undefined;
}

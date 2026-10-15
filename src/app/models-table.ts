/**
 * models 子命令：可用模型表格渲染（纯函数，可测）。
 * 数据源为 SDK RawLanguageModel（含 contextWindow / reasoning.supportedEfforts /
 * credits 等完整字段，简化格式没有这些）。
 *
 * 能力列的图片模态以 pi-catalog models.json 注册表为准（2026-10-04 实证：
 * CLI raw 的 supportsImages 全模型恒 true 是虚标——glm-5.1 实际纯文本；
 * catalog 与 codebuddy CLI bundle 内嵌注册表同源，input:["text"]/["text","image"]
 * 是真实路由能力）。catalog 无该 id（新模型/自建）时回退 CLI 自报。
 */
import type { RawLanguageModel } from '@tencent-ai/agent-sdk';
import modelsDb from '@oh-my-pi/pi-catalog/models.json';
import { fmtTokens } from './statusline';

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

const HEADERS = ['ID', '名称', '上下文', '最大输出', 'thinking 强度', '能力', '积分'] as const;

/** catalog：modelId → 任一 provider 条目声明 image 输入即为 true（显式 false 也算有定论） */
const catalogImage: ReadonlyMap<string, boolean> = (() => {
  const found = new Map<string, boolean>();
  for (const models of Object.values(modelsDb)) {
    for (const [id, entry] of Object.entries(models)) {
      const img = (entry.input as readonly string[]).includes('image');
      found.set(id, (found.get(id) ?? false) || img);
    }
  }
  return found;
})();

/** 显示宽度对齐（中文占 2 列）；Bun 锁定，直接用 Bun.stringWidth */
function pad(s: string, width: number): string {
  const w = Bun.stringWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

function ctxOf(m: RawLanguageModel): string {
  const v = m.contextWindow?.defaultLength ?? m.maxInputTokens ?? m.maxAllowedSize;
  return v ? fmtTokens(v) : '-';
}

function outOf(m: RawLanguageModel): string {
  return m.maxOutputTokens ? fmtTokens(m.maxOutputTokens) : '-';
}

function effortsOf(m: RawLanguageModel): string {
  const s = m.reasoning?.supportedEfforts;
  return s && s.length > 0 ? s.join('/') : '-';
}

function capabilitiesOf(m: RawLanguageModel): string {
  const caps = ['文字'];
  const img = catalogImage.get(m.id) ?? (m.supportsImages === true && !m.disabledMultimodal);
  if (img) caps.push('图片');
  if (m.supportsToolCall) caps.push('工具');
  if (m.supportsReasoning) caps.push('推理');
  return caps.join('/');
}

/** credits 原始格式 "x0.79 credits" → "x0.79"；缺省 → "-" */
function creditsOf(m: RawLanguageModel): string {
  return m.credits?.replace(/\s*credits\s*$/, '') ?? '-';
}

/** 渲染为对齐表格（单行字符串，含表头；当前模型行首 * 标黄） */
export function formatModelsTable(models: RawLanguageModel[], currentModel?: string): string {
  const rows = models.map((m) => [
    m.id,
    m.name ?? m.id,
    ctxOf(m),
    outOf(m),
    effortsOf(m),
    capabilitiesOf(m),
    creditsOf(m),
  ]);
  const widths = HEADERS.map((h, i) =>
    Math.max(Bun.stringWidth(h), ...rows.map((r) => Bun.stringWidth(r[i]))),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((c, i) => pad(c, widths[i])).join('  ');
  const lines = [
    `${DIM}${line(HEADERS)}${RESET}`,
    ...rows.map((r) => {
      const mark = r[0] === currentModel ? `${YELLOW}*${RESET} ` : '  ';
      // ID 列染色在行外做会乱宽度，先拼纯文本再整体替换 ID 段
      return mark + line(r).replace(r[0], `${CYAN}${r[0]}${RESET}`);
    }),
  ];
  return lines.join('\n');
}

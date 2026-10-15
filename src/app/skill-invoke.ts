/**
 * skill-invoke.ts（skill-invoke P3）：提交文本 → skill 调用解析 + SKILL.md 展开。
 *
 * 对齐 omp extensibility/skills.ts:432 parseSkillInvocation / :484
 * buildSkillPromptMessage，但不引 Handlebars（简单字符串拼接）、不异步
 * （readFileSync，omp 的 Bun.file().text() 在 omc 侧无收益）。
 *
 * token 正则与门控直接复用 pi-tui skill-tokens（SKILL_TOKEN_RE 全局正则，
 * 用前重置 lastIndex）；omp 语义：
 * - 行首形态 `/skill:foo bar baz` → name=foo args='bar baz'
 * - 句中形态 `fix bug /skill:foo focus` → 前后 prose 折叠进 args
 * - 只取第一个 token；known 给定时未知名返回 undefined（保持字面不拦）
 * - 模板含 skill 目录声明（模型据此解析 skill 内相对路径），args 非空追加 User 段
 */
import { readFileSync } from 'node:fs';
import { getMarkdownTheme } from '@oh-my-pi/pi-tui';
import type { SkillPromptDetails } from '@oh-my-pi/pi-tui/chat/messages.js';
import { Markdown } from '@oh-my-pi/pi-tui/components/markdown';
import { SKILL_TOKEN_RE, allowsSkillTokens } from '@oh-my-pi/pi-tui/prompt/skill-tokens.js';
import type { SkillEntry } from './context-data';

export interface ParsedSkillInvocation {
  /** 裸 skill 名（不含 skill: 前缀） */
  name: string;
  /** token 之外的全部文本折叠成的 args（行首形态 = token 后缀；句中 = 前后 prose） */
  args: string;
  /** 提交原文（trim 后，token 保留原位）——驱动 transcript 布局 */
  prompt: string;
  /** head=行首 slash 位；inline=句中 token（omp 无此字段，omc 供 P4 分流用） */
  mode: 'head' | 'inline';
}

/** 剥 YAML frontmatter 返回正文（与 context-data.ts parseSkillFrontmatter 同口径；无 frontmatter 返回原文） */
export function stripFrontmatter(content: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---/.exec(content);
  if (!m) return content.trim();
  return content.slice(m[0].length).trim();
}

/** 检测 `/skill:<name>` 调用；known 给定时未知名返回 undefined（交调用方落回普通消息） */
export function parseSkillInvocation(
  text: string,
  known?: { has(name: string): boolean },
): ParsedSkillInvocation | undefined {
  const trimmedStart = text.trimStart();
  const prompt = trimmedStart.trimEnd();
  // 行首形态：/skill:foo bar baz
  if (trimmedStart.startsWith('/skill:')) {
    const spaceIndex = trimmedStart.search(/\s/);
    const name =
      spaceIndex === -1
        ? trimmedStart.slice('/skill:'.length)
        : trimmedStart.slice('/skill:'.length, spaceIndex);
    if (!name) return undefined;
    if (known && !known.has(name)) return undefined;
    const args = spaceIndex === -1 ? '' : trimmedStart.slice(spaceIndex + 1).trim();
    return { name, args, prompt, mode: 'head' };
  }
  // 句中形态：门控（其他 slash 命令 / 本地执行 sigil 不拦）
  if (!allowsSkillTokens(trimmedStart)) return undefined;
  SKILL_TOKEN_RE.lastIndex = 0; // 全局正则复用前重置
  const match = SKILL_TOKEN_RE.exec(text);
  if (!match) return undefined;
  const name = match[2]!;
  if (known && !known.has(name)) return undefined;
  const tokenStart = match.index + match[1]!.length;
  const tokenEnd = match.index + match[0].length;
  const before = text.slice(0, tokenStart).trimEnd();
  const after = text.slice(tokenEnd).trimStart();
  const args = [before, after].filter((p) => p.length > 0).join(' ').trim();
  return { name, args, prompt, mode: 'inline' };
}

export interface BuiltSkillPrompt {
  /** 注入模型的展开文本（模板 + SKILL.md 正文） */
  message: string;
  /** transcript skill 卡片数据（对齐 pi-tui SkillPromptDetails） */
  details: SkillPromptDetails;
}

/**
 * skill 卡片展开显示限高（CompactSummaryCard 范式，2026-10-05 两轮用户验收实锤）：
 * pi-tui SkillMessageComponent 展开不限高（setIgnoreTight(true)），长 prompt 常态超一屏；
 * 展开帧使整卡越出活体容量 → **整卡退休进原生 scrollback 冻结**（退休行不重绘），
 * ctrl+o 折叠只作用视口内活体 → 「展开后收不回、退休卡展不开」。
 *
 * 高度构成（探针实证）：卡总高 = 折叠 chrome(3) + prompt 小节(3) + prompt 渲染行(N)。
 * 存活条件：卡总高 + 块间空行(1) + 下方回复/状态行 ≤ 终端行数 − 底部 chrome(~6)。
 * → prompt 渲染行预算 = rows − 19，clamp [4, SKILL_PROMPT_MAX_DISPLAY_ROWS]。
 * 首版固定 24 源行估算仍超（渲染膨胀 + 无 rows 适配，31 行卡 + 回复超容量），
 * 故改为**真 Markdown 渲染计数 + 二分截断**（提交时一次性 ~8 次小渲染，可忽略）。
 */
export const SKILL_PROMPT_MAX_DISPLAY_ROWS = 24;

/** 底部 chrome(6) + 卡 chrome(3) + prompt 小节(3) + 块间空行(1) + 回复/状态余量(6) */
const SKILL_PROMPT_CHROME_RESERVE = 19;

/** 卡片内 Markdown 可用宽：左轨(1) + Box padding(2) + 安全边(1) */
const SKILL_CARD_WIDTH_COST = 4;

/** 用真 Markdown 渲染计行（宽度对齐卡片内栏；调用时 theme 已 init——deliver 在 app 装配后） */
function promptRenderedRows(text: string, width: number): number {
  const md = new Markdown(text, 0, 0, getMarkdownTheme(), {});
  return md.render(Math.max(20, width)).length;
}

/**
 * 卡片展示用 prompt 限高：按当前终端行列计算渲染行预算，真渲染二分截断，
 * 超出补提示行。**只影响 transcript 展示**——发给模型的 msg 是另一条载荷，
 * 全文不受影响；全文可点卡片头部 SKILL.md 链接查看。
 * 已知限制：提交时快照行列，之后resize 收窄不再重估（CompactCard 动态 cap 才跟 resize）。
 */
export function capSkillPromptDisplay(
  text: string,
  options: { columns: number; rows: number; maxRows?: number },
): string {
  const { columns, rows } = options;
  const budget = Math.max(
    4,
    Math.min(options.maxRows ?? SKILL_PROMPT_MAX_DISPLAY_ROWS, rows - SKILL_PROMPT_CHROME_RESERVE),
  );
  const width = columns - SKILL_CARD_WIDTH_COST;
  if (promptRenderedRows(text, width) <= budget) return text;
  // 二分最大源行前綴：渲染行 ≤ budget（prefix 渲染行随行数单调不减）
  const lines = text.split('\n');
  let lo = 0;
  let hi = lines.length - 1; // 至少保留提示行的位置
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (promptRenderedRows(lines.slice(0, mid).join('\n'), width) <= budget) lo = mid;
    else hi = mid - 1;
  }
  const hidden = lines.length - lo;
  return [
    ...lines.slice(0, lo),
    `… prompt 还有 ${hidden} 行未显示（完整内容已发给模型；全文见上方 SKILL.md 链接）`,
  ].join('\n');
}

/**
 * 读 SKILL.md → 剥 frontmatter → 套 omp user-invocation.md 模板。
 * 文件不可读时抛错（调用方 catch 落回字面消息）。
 */
export function buildSkillPromptMessage(
  skill: Pick<SkillEntry, 'name' | 'filePath' | 'baseDir'>,
  input: { args: string; prompt?: string },
): BuiltSkillPrompt {
  const content = readFileSync(skill.filePath, 'utf8');
  const body = stripFrontmatter(content);
  const trimmedArgs = input.args.trim();
  const message = (
    [
      `[IMPORTANT: User invoked the "${skill.name}" skill; follow its instructions. Full skill below.]`,
      '',
      body,
      '',
      '---',
      '',
      `[Skill directory: ${skill.baseDir}]`,
      'Resolve relative paths in this skill (e.g. `scripts/foo.js`, `templates/config.yaml`) against this absolute directory; read referenced assets and templates; run scripts with the terminal tool when skill instructions call for it.',
    ].join('\n') + (trimmedArgs ? `\nUser: ${trimmedArgs}\n` : '')
  ).trim();
  return {
    message,
    details: {
      name: skill.name,
      path: skill.filePath,
      args: trimmedArgs || undefined,
      prompt: input.prompt,
      lineCount: body ? body.split('\n').length : 0,
    },
  };
}

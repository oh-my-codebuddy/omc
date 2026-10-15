/**
 * ux-port-v2 P6：启动欢迎页（omp 卡片版式，omc 文案）。
 *
 * 版式照抄 pi-tui WelcomeComponent.#renderLines（src/prompt/welcome.ts:463）：
 * 圆角边框卡片 + 顶边内嵌标题 + 左列居中（问候/渐变 logo/模型/provider）
 * + 右列（Tips/Recent sessions）+ 底部分列 teeUp + 卡片下斜体 Tip。
 * 不用 WelcomeComponent 本体的原因：logo（π）、Tips 键位（omp 话术）、
 * 标题 APP_NAME（"omp"）、tip 池（tips.txt 内嵌）均写死且 #私有不可覆盖。
 * 本文件仅依赖其公开导出：theme/gradientLogo/truncateToWidth/visibleWidth/
 * padding/renderWelcomeTip。
 *
 * 纯函数 renderWelcome 输出带 ANSI 的行数组，main.ts TTY 分支经
 * bridge.addInfoLines 打印；全程可单测。
 */
import { theme } from '@oh-my-pi/pi-tui';
import { gradientLogo, renderWelcomeTip } from '@oh-my-pi/pi-tui/prompt/welcome.js';
import { padding, truncateToWidth, visibleWidth } from '@oh-my-pi/pi-tui/utils.js';

/**
 * C 标志：12 列 × 5 行密排块体（2026-10-04 真机修订）。
 * 初版带右钩的草书写法在 transcript 行距下读感散乱；定稿 bracket 体——
 * 上下 10 列横杠 + 左缘 3 列通长竖脊，小字号下也是完整的「C」。
 */
const C_LOGO = [
  ' ██████████ ',
  '███         ',
  '███         ',
  '███         ',
  ' ██████████ ',
];

/** 右列 Tips（omc 真实键位；dim 键 + muted 动作，omp 同款两段式） */
const TIP_SHORTCUTS: ReadonlyArray<readonly [string, string]> = [
  ['/help', ' 列出全部命令'],
  ['ctrl+r', ' 历史搜索'],
  ['ctrl+o', ' 折叠工具卡'],
  ['alt+↑', ' 取回排队'],
];

/** 底部随机 Tip 池（omc 真实功能） */
const BOTTOM_TIPS = [
  '/usage 查看用量热力图与每日统计',
  '/context 查看上下文构成报告',
  '/export 导出会话为 markdown',
  'ctrl+t 展开 / 折叠待办列表',
  '/resume 切换到历史会话',
  '/rewind 回退文件 / 对话到某个检查点',
  '直接粘贴图片可随消息发送',
];

const MAX_SESSIONS = 3;
const MAX_WIDTH = 100;
const MIN_LEFT_COL = 12; // logo 宽
const MIN_RIGHT_COL = 20;
const PREFERRED_LEFT_COL = 26;

export interface WelcomeSessionEntry {
  title: string;
  mtime: number;
}

export interface RenderWelcomeOptions {
  version: string;
  model: string;
  /** 左列第三行（provider/品牌行），缺省 'codebuddy' */
  provider?: string;
  /** mtime 倒序（新→旧），取前 3 */
  sessions: WelcomeSessionEntry[];
  /** 终端列宽 */
  width: number;
  /** 测试注入：当前时间（相对时间格式化基准） */
  now?: number;
  /** 测试注入：底部 Tip 索引（缺省随机） */
  tipIndex?: number;
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 */
export function formatRelativeTime(mtime: number, now: number): string {
  const diff = Math.max(0, now - mtime);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/** omp welcome.ts:641 同款：ANSI 感知居中（超宽截断） */
function centerText(text: string, width: number): string {
  const visLen = visibleWidth(text);
  if (visLen >= width) return truncateToWidth(text, width);
  const leftPad = Math.floor((width - visLen) / 2);
  return padding(leftPad) + text + padding(width - visLen - leftPad);
}

/** omp welcome.ts:652 同款：ANSI 感知定宽（超宽截断补 …，不足补空格） */
function fitToWidth(str: string, width: number): string {
  const visLen = visibleWidth(str);
  if (visLen > width) return truncateToWidth(str, width);
  return str + padding(width - visLen);
}

export function renderWelcome(opts: RenderWelcomeOptions): string[] {
  const { version, model, sessions, width: termWidth } = opts;
  const provider = opts.provider ?? 'codebuddy';
  const now = opts.now ?? Date.now();
  const tip = BOTTOM_TIPS[(opts.tipIndex ?? Math.floor(Math.random() * BOTTOM_TIPS.length)) % BOTTOM_TIPS.length];

  // ---- 盒尺寸（omp welcome.ts:464-489 同款响应式） ----
  const boxWidth = Math.min(MAX_WIDTH, Math.max(0, termWidth - 2));
  if (boxWidth < 4) return [];
  const dualContentWidth = boxWidth - 3; // 3 = │ + │ + │
  const leftMinContentWidth = Math.max(MIN_LEFT_COL, visibleWidth('Welcome back!'));
  const desiredLeftCol = Math.max(
    Math.min(PREFERRED_LEFT_COL, Math.max(MIN_LEFT_COL, Math.floor(dualContentWidth * 0.35))),
    leftMinContentWidth,
  );
  const dualLeftCol =
    dualContentWidth >= MIN_RIGHT_COL + 1
      ? Math.min(desiredLeftCol, dualContentWidth - MIN_RIGHT_COL)
      : Math.max(1, dualContentWidth - 1);
  const dualRightCol = Math.max(1, dualContentWidth - dualLeftCol);
  const showRightColumn = dualLeftCol >= leftMinContentWidth && dualRightCol >= MIN_RIGHT_COL;
  const leftCol = showRightColumn ? dualLeftCol : boxWidth - 2;
  const rightCol = showRightColumn ? dualRightCol : 0;

  // ---- 左列：居中 问候/渐变 C logo/模型/provider ----
  const logoColored = gradientLogo(C_LOGO, 0);
  const leftLines = [
    '',
    centerText(theme.bold('Welcome back!'), leftCol),
    '',
    ...logoColored.map((l) => centerText(l, leftCol)),
    '',
    centerText(theme.fg('muted', model), leftCol),
    centerText(theme.fg('borderMuted', provider), leftCol),
  ];

  // ---- 右列：Tips + 分隔 + Recent sessions ----
  const separatorWidth = Math.max(0, rightCol - 2);
  const separator = ` ${theme.fg('dim', theme.boxRound.horizontal.repeat(separatorWidth))}`;

  const sessionLines: string[] = [];
  const recent = sessions.slice(0, MAX_SESSIONS);
  if (recent.length === 0) {
    sessionLines.push(` ${theme.fg('dim', '暂无历史会话')}`);
  } else {
    // omp welcome.ts:514 同款：预算先扣 bullet 前缀与时间后缀，标题吃掉剩余宽度
    const bulletPrefix = ` ${theme.md.bullet} `;
    const prefixWidth = visibleWidth(bulletPrefix);
    for (const s of recent) {
      const timeSuffixRaw = `（${formatRelativeTime(s.mtime, now)}）`;
      const nameBudget = Math.max(1, rightCol - prefixWidth - visibleWidth(timeSuffixRaw));
      const name = visibleWidth(s.title) > nameBudget ? truncateToWidth(s.title, nameBudget) : s.title;
      sessionLines.push(
        `${theme.fg('dim', bulletPrefix)}${theme.fg('muted', name)}${theme.fg('dim', timeSuffixRaw)}`,
      );
    }
  }
  // 槽位补齐：卡片高度不随会话数变化
  while (sessionLines.length < MAX_SESSIONS) sessionLines.push('');

  const rightLines = [
    ` ${theme.bold(theme.fg('accent', 'Tips'))}`,
    ...TIP_SHORTCUTS.map(([key, label]) => ` ${theme.fg('dim', key)}${theme.fg('muted', label)}`),
    separator,
    ` ${theme.bold(theme.fg('accent', 'Recent sessions'))}`,
    ...sessionLines,
    '',
  ];

  // ---- 边框 ----
  const hChar = theme.boxRound.horizontal;
  const h = theme.fg('dim', hChar);
  const v = theme.fg('dim', theme.boxRound.vertical);
  const tl = theme.fg('dim', theme.boxRound.topLeft);
  const tr = theme.fg('dim', theme.boxRound.topRight);
  const bl = theme.fg('dim', theme.boxRound.bottomLeft);
  const br = theme.fg('dim', theme.boxRound.bottomRight);

  const lines: string[] = [];

  // 顶边内嵌标题：`─── omc vX.Y.Z ───…`
  const title = ` omc v${version} `;
  const titlePrefixRaw = hChar.repeat(3);
  const titleStyled = theme.fg('dim', titlePrefixRaw) + theme.fg('muted', title);
  const titleVisLen = visibleWidth(titlePrefixRaw) + visibleWidth(title);
  const titleSpace = boxWidth - 2;
  if (titleVisLen >= titleSpace) {
    lines.push(tl + truncateToWidth(titleStyled, titleSpace) + tr);
  } else {
    lines.push(tl + titleStyled + theme.fg('dim', hChar.repeat(titleSpace - titleVisLen)) + tr);
  }

  // 内容行
  const maxRows = showRightColumn ? Math.max(leftLines.length, rightLines.length) : leftLines.length;
  for (let i = 0; i < maxRows; i++) {
    const left = fitToWidth(leftLines[i] ?? '', leftCol);
    if (showRightColumn) {
      lines.push(v + left + v + fitToWidth(rightLines[i] ?? '', rightCol) + v);
    } else {
      lines.push(v + left + v);
    }
  }

  // 底边（双列时中间 teeUp）
  if (showRightColumn) {
    lines.push(bl + h.repeat(leftCol) + theme.fg('dim', theme.boxRound.teeUp) + h.repeat(rightCol) + br);
  } else {
    lines.push(bl + h.repeat(leftCol) + br);
  }

  // 卡片下斜体 Tip（omp renderWelcomeTip：customMessageLabel 标签 + muted 正文 + 整体斜体）
  lines.push(...renderWelcomeTip(tip, boxWidth));

  return lines;
}

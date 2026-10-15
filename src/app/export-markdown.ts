/**
 * export-markdown.ts — /export 会话导出 markdown（ux-port-v2 P2.1）纯函数。
 *
 * 数据源：SessionLog.load 的 LogRecord[]（user/text_final/tool_start/tool_result/result）。
 * 纯本地转换，不碰 SDK。落盘口径即定稿口径：未落盘的进行中轮次不在导出内。
 *
 * 版式（docs/plan/ux-port-v2/p2-export.md 定稿）：
 * - 头部：# 标题 + sessionId/导出时间/模型 元信息行
 * - 用户/助手：## 👤 User / ## 🤖 Assistant 二级标题分段，原文原样保留
 * - detail-view P1.1：`opts.includeThinking`（`/detail` 全屏详情视图用）时，thinking 全文成
 *   `### 💭 Thinking` 段；`/export` 缺省**不含** thinking（既有导出物不变）
 * - 工具调用：<details> 折叠块（tool_start 配 tool_result，按 toolUseId 配对；
 *   缺对的 start 在末尾补出，缺对的 result 单独成块）
 * - result 记录 → 轮次分隔线 `---` + 一行 stats（usage 是 CLI 会话累计值，注明口径）
 * - tool_result images 是 base64：不内嵌，降级 `> 🖼 图片×N（base64 略）` 占位行
 */
import type { LogRecord } from '../session-store/jsonl';
import type { ResultEvent, ToolResult, ToolStart } from '../agent/types';
import { fenceOutput } from './bash-mode';

export interface ExportMeta {
  sessionId: string;
  exportedAt: Date;
  /** 当前模型 id（result 记录无 model 字段，由调用方从本地状态给；可省略） */
  model?: string;
}

/**
 * 渲染选项（detail-view P1.1）。
 * - `includeThinking`：含 thinking 全文（`/detail` 详情视图用）。缺省 **false** ——
 *   `/export` 的导出物保持既有形态（不含 thinking），避免改动已验收的导出结果。
 * - `title`：头部首行（缺省「oh-my-codebuddy 会话导出」）。
 */
export interface SessionRenderOptions {
  includeThinking?: boolean;
  title?: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 本地时间 YYYY-MM-DD HH:mm:ss（头部「导出时间」） */
export function formatTimestamp(d: Date): string {
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

/** 文件名时间戳 YYYYmmdd-HHMMSS */
function fileStamp(d: Date): string {
  return (
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  );
}

/** 默认导出文件名：omc-session-{sid前8}-{YYYYmmdd-HHMMSS}.md */
export function defaultExportFileName(sessionId: string, at: Date): string {
  return `omc-session-${sessionId.slice(0, 8)}-${fileStamp(at)}.md`;
}

/**
 * 防覆盖：path 已存在则插 `-1` `-2`… 后缀（扩展名前）。
 * exists 注入便于单测；返回第一个不存在的路径。
 */
export function dedupePath(path: string, exists: (p: string) => boolean): string {
  if (!exists(path)) return path;
  const dot = path.lastIndexOf('.');
  const stem = dot > 0 ? path.slice(0, dot) : path;
  const ext = dot > 0 ? path.slice(dot) : '';
  for (let i = 1; ; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!exists(candidate)) return candidate;
  }
}

function renderToolBlock(start: ToolStart | undefined, result: ToolResult | undefined): string[] {
  const name = start?.toolName ?? '(unknown tool)';
  const summary = start?.summary ?? result?.summary ?? '';
  const lines: string[] = [`<details><summary>🔧 ${name} — ${summary}</summary>`, ''];
  if (start) {
    lines.push('**input**', '', start.detail ?? start.summary, '');
  }
  if (result) {
    lines.push(`**output**${result.isError ? '（error）' : ''}`, '', result.detail ?? result.summary, '');
    if (result.images && result.images.length > 0) {
      lines.push(`> 🖼 图片×${result.images.length}（base64 略）`, '');
    }
  }
  lines.push('</details>', '');
  return lines;
}

function renderResult(rec: ResultEvent): string[] {
  const lines: string[] = ['---', ''];
  if (rec.interrupted) {
    lines.push('> 本轮被用户中断', '');
    return lines;
  }
  if (!rec.success) {
    lines.push('> 本轮失败');
    if (rec.errors && rec.errors.length > 0) lines.push(`> errors: ${rec.errors.join('; ')}`);
    lines.push('');
    return lines;
  }
  if (rec.usage) {
    const u = rec.usage;
    const cost = u.totalCostUsd !== undefined ? ` | $${u.totalCostUsd.toFixed(4)}` : '';
    lines.push(
      `> in ${u.inputTokens.toLocaleString()} out ${u.outputTokens.toLocaleString()}${cost}（CLI 会话累计口径）`,
      '',
    );
  }
  return lines;
}

/**
 * 会话记录 → markdown 全文。空记录数组也渲染（头部 + 无正文），
 * 「无记录不建文件」由命令层判断。
 *
 * `opts.includeThinking`（detail-view P1.1）：`/export` 缺省不含 thinking（既有导出物不变），
 * `/detail` 全屏详情视图传 true —— thinking 是该视图的**主要内容**，必须全文呈现。
 */
export function renderSessionMarkdown(
  records: LogRecord[],
  meta: ExportMeta,
  opts: SessionRenderOptions = {},
): string {
  const includeThinking = opts.includeThinking ?? false;
  const lines: string[] = [
    `# ${opts.title ?? 'oh-my-codebuddy 会话导出'}`,
    `- sessionId: ${meta.sessionId}`,
    `- 导出时间: ${formatTimestamp(meta.exportedAt)}`,
  ];
  if (meta.model) lines.push(`- 模型: ${meta.model}`);
  lines.push('');

  const pendingTools = new Map<string, ToolStart>();
  for (const rec of records) {
    switch (rec.type) {
      case 'user':
        lines.push('## 👤 User', '', rec.text, '');
        break;
      case 'text_final': {
        // P4.4 thinking-only 记录（text 空、thinking 非空）：/export 跳过（不含 thinking），
        // /detail 则只出 thinking 段，不让这条记录凭空消失
        const thinking = includeThinking ? (rec.thinking ?? '').trim() : '';
        if (!rec.text.trim() && !thinking) break;
        lines.push('## 🤖 Assistant', '');
        if (thinking) lines.push('### 💭 Thinking', '', thinking, '');
        if (rec.text.trim()) lines.push(rec.text, '');
        break;
      }
      case 'tool_start':
        pendingTools.set(rec.toolUseId, rec);
        break;
      case 'tool_result': {
        const start = pendingTools.get(rec.toolUseId);
        if (start) pendingTools.delete(rec.toolUseId);
        lines.push(...renderToolBlock(start, rec));
        break;
      }
      case 'result':
        // 轮末：本轮未配对的 tool_start（被中断等）先补出，再画分隔线
        for (const start of pendingTools.values()) lines.push(...renderToolBlock(start, undefined));
        pendingTools.clear();
        lines.push(...renderResult(rec));
        break;
      case 'subagent_done':
        // P2.7：子代理完成卡（CLI 不推 teammate 续话，由 omc 补的「结果回流」记录）；
        // status=failed = 僵尸判定（工具调用悬空超时，附 stuckTool 现场）
        if (rec.status === 'failed') {
          lines.push(
            `## ⚠️ 子代理 ${rec.name}（疑似中断）`,
            '',
            `> ${rec.description || rec.name} · ${Math.round(rec.elapsedMs / 1000)}s`,
            '',
            ...(rec.stuckTool ? [`> 最后的工具调用无结果：${rec.stuckTool}`] : []),
            '',
          );
        } else {
          lines.push(
            `## ✅ 子代理 ${rec.name}`,
            '',
            `> ${rec.description || rec.name} · ${Math.round(rec.elapsedMs / 1000)}s`,
            '',
            // 交付报告全文（teammate 注入路径）优先；否则用卡片截断行
            ...(rec.report
              ? rec.report.split('\n')
              : rec.outcome.length > 0
                ? rec.outcome.map((l) => `> ${l}`)
                : []),
            '',
          );
        }
        break;
      case 'bash': {
        // input-interactions P1：`!` / `!!` bash 命令（不触发模型轮，输出卡片化落盘）
        const sigil = rec.excluded ? '!!' : '!';
        const status = rec.timedOut
          ? '⏱ 超时'
          : rec.cancelled
            ? '✗ 已取消'
            : rec.exitCode === 0
              ? '✓ exit 0'
              : `✗ exit ${rec.exitCode ?? '?'}`;
        const notes = [
          rec.excluded ? '本地执行（未进入模型上下文）' : '',
          rec.truncated ? `输出已截断（共 ${rec.totalChars} 字符）` : '',
        ].filter(Boolean);
        lines.push(
          `## 💻 Bash \`${sigil} ${rec.command}\``,
          '',
          `> ${status}${notes.length > 0 ? ` · ${notes.join(' · ')}` : ''}`,
          '',
          ...(rec.output ? fenceOutput(rec.output).split('\n') : ['*(无输出)*']),
          '',
        );
        break;
      }
    }
  }
  // 会话尾部仍悬挂的 tool_start（无 result 轮次，如启动即中断）
  for (const start of pendingTools.values()) lines.push(...renderToolBlock(start, undefined));

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

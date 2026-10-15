/**
 * normalize：SDK Message → UIEvent[] 纯函数。
 * 未识别的消息类型返回 []，绝不抛错。
 */
import type { ContentBlock, Message } from '@tencent-ai/agent-sdk';
import { computeLineDiff, type DiffLine } from '../app/line-diff';
import { isPermissionDenied } from './errors';
import { makeEventId, type TaskUsage, type ToolDiff, type ToolResultImage, type UIEvent, type WorkflowTimelineItem } from './types';

function base() {
  return { id: makeEventId(), timestamp: Date.now() };
}

/** SDK TaskUsage（snake_case）→ UI TaskUsage */
function taskUsage(u: {
  total_tokens: number;
  tool_uses: number;
  duration_ms: number;
}): TaskUsage {
  return { totalTokens: u.total_tokens, toolUses: u.tool_uses, durationMs: u.duration_ms };
}

/** 把 tool_use input 压成单行摘要 */
function clip(s: string, max = 80): string {
  const flat = s.split('\n')[0].trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/**
 * per-tool 摘要函数表（P4.4；放 agent 层是因 UIEvent 契约由 normalize 产出，
 * agent 与 tui 互不 import 的约束优先于组件内聚）。未命中落默认。
 */
const INPUT_SUMMARIZERS: Record<string, (i: Record<string, unknown>) => string> = {
  bash: (i) => clip(String(i.command ?? i.description ?? '')),
  read: (i) => clip(String(i.file_path ?? '')),
  write: (i) => clip(String(i.file_path ?? '')),
  edit: (i) => clip(String(i.file_path ?? '')),
  grep: (i) => clip(`/${i.pattern ?? ''}/ ${i.path ?? ''}`.trim()),
  glob: (i) => clip(`${i.pattern ?? ''} ${i.path ?? ''}`.trim()),
  // skill-system P1.3：Skill 调用摘要 = 目标 skill 名（否则落整段 JSON；
  // 权限弹窗与 tool_start 卡片共用。经 DeferExecuteTool 包装的形态由 bridge 拆包后调用）
  skill: (i) => clip(String(i.skill ?? i.command ?? '')),
  // tool-render P2：Task* 工具族的单行摘要（待办展示走编辑器正上方的**贴底行**，
  // 此处供 /export 与日志可读性——通用回退会落到 description 或整段 JSON）
  taskcreate: (i) => clip(String(i.subject ?? '')),
  taskupdate: (i) => clip(`#${i.taskId ?? '?'} → ${i.status ?? '?'}`),
  tasklist: () => '当前任务列表',
};

/** per-tool 单行摘要（P5 权限弹窗复用，故导出） */
export function summarizeInput(toolName: string, input: Record<string, unknown>): string {
  const fn = INPUT_SUMMARIZERS[toolName.toLowerCase()];
  if (fn) {
    const s = fn(input);
    if (s) return s;
  }
  const keys = ['file_path', 'command', 'pattern', 'path', 'url', 'query', 'description'];
  for (const k of keys) {
    const v = input[k];
    if (typeof v === 'string') {
      return v.length > 80 ? `${v.slice(0, 77)}...` : v;
    }
  }
  const json = JSON.stringify(input);
  return json.length > 80 ? `${json.slice(0, 77)}...` : json;
}

/**
 * 工具特化渲染（tool-render P1 / D1 seam）：编辑类工具产出结构化 diff。
 * 数据全部由入参本地计算（P1.1 实证 SDK 不提供结构化 patch，也不带旧内容）：
 * - `edit`：old_string → new_string
 * - `multiedit`：逐条 edits[] 各算一段后拼接（纯展示，不做跨条归一化）
 * - `write`：旧内容不可得 → 空 old 起算（全新增行）+ isNewFile 标注
 * 未命中返回 undefined，UI 回落现有 summary/detail 路径。
 * 导出：main.ts 的 resume 重放用它从落盘 detail 重算 diff（落盘时 diff 被剥离）。
 */
export function computeToolDiff(toolName: string, input: Record<string, unknown>): ToolDiff | undefined {
  const name = toolName.toLowerCase();
  const filePath = typeof input.file_path === 'string' ? input.file_path : '';

  if (name === 'edit') {
    const oldText = typeof input.old_string === 'string' ? input.old_string : '';
    const newText = typeof input.new_string === 'string' ? input.new_string : '';
    return { filePath, lines: computeLineDiff(oldText, newText) };
  }

  if (name === 'multiedit') {
    const edits = input.edits;
    if (!Array.isArray(edits) || edits.length === 0) return undefined;
    const lines: DiffLine[] = [];
    for (const raw of edits) {
      if (!raw || typeof raw !== 'object') continue;
      const e = raw as Record<string, unknown>;
      lines.push(
        ...computeLineDiff(
          typeof e.old_string === 'string' ? e.old_string : '',
          typeof e.new_string === 'string' ? e.new_string : '',
        ),
      );
    }
    return lines.length > 0 ? { filePath, lines } : undefined;
  }

  if (name === 'write') {
    const content = typeof input.content === 'string' ? input.content : '';
    return { filePath, lines: computeLineDiff('', content), isNewFile: true };
  }

  return undefined;
}

/**
 * tool_result content 归一为块数组。SDK read 工具的图片结果会把块数组
 * JSON.stringify 成字符串送达（dist-server codebuddy.js 实测：
 * JSON.stringify([{type:"image_url",...}])），字符串形态尝试解析回块；
 * 解析失败或元素不像内容块（无 string type 字段）则按普通文本处理。
 */
function contentBlocks(content: unknown): unknown[] {
  if (Array.isArray(content)) return content;
  if (typeof content === 'string') {
    const t = content.trim();
    if (t.startsWith('[{') && t.endsWith('}]')) {
      try {
        const p: unknown = JSON.parse(t);
        if (
          Array.isArray(p) &&
          p.length > 0 &&
          p.every((b) => b && typeof b === 'object' && typeof (b as { type?: unknown }).type === 'string')
        ) {
          return p;
        }
      } catch {
        // 非法 JSON：按普通文本
      }
    }
  }
  return [];
}

/** 提取 tool_result 完整文本（verbose detail 与 summary 共用提取逻辑） */
function resultText(content: unknown): string {
  if (Array.isArray(content) || typeof content === 'string') {
    const blocks = contentBlocks(content);
    if (blocks.length > 0) {
      return blocks
        .map((b) =>
          b && typeof b === 'object' && 'text' in b && typeof (b as { text?: unknown }).text === 'string'
            ? (b as { text: string }).text
            : '',
        )
        .filter(Boolean)
        .join('\n');
    }
    if (typeof content === 'string') return content;
  }
  return JSON.stringify(content) ?? '';
}

/** 提取 tool_result 中的 base64 图片块（M4.1）。
 *  覆盖两种形态：Anthropic {type:'image', source:{type:'base64',...}} 与
 *  OpenAI {type:'image_url', image_url:{url:'data:<mime>;base64,<data>'}}
 *  （SDK read 工具读图片返回后者，M4.1 真机验收实测）。url 源不取，避免网络拉取。 */
function resultImages(content: unknown): ToolResultImage[] {
  const blocks = contentBlocks(content);
  const out: ToolResultImage[] = [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    const type = (b as { type?: unknown }).type;
    if (type === 'image') {
      const src = (b as { source?: unknown }).source;
      if (src && typeof src === 'object') {
        const s = src as { type?: unknown; media_type?: unknown; data?: unknown };
        if (s.type === 'base64' && typeof s.data === 'string' && typeof s.media_type === 'string') {
          out.push({ data: s.data, mimeType: s.media_type });
        }
      }
    } else if (type === 'image_url') {
      const url = (b as { image_url?: unknown }).image_url;
      const u = url && typeof url === 'object' ? (url as { url?: unknown }).url : undefined;
      if (typeof u === 'string') {
        const m = /^data:([^;,]+);base64,(.+)$/.exec(u);
        if (m) out.push({ data: m[2]!, mimeType: m[1]! });
      }
    }
  }
  return out;
}

/** 把 tool_result 内容压成单行摘要 */
function summarizeResult(content: unknown): string {
  const firstLine = resultText(content).split('\n').find((l) => l.trim().length > 0) ?? '';
  const clipped = firstLine.length > 100 ? `${firstLine.slice(0, 97)}...` : firstLine;
  if (clipped) return clipped;
  const n = resultImages(content).length;
  return n > 0 ? `[图片 x${n}]` : '';
}

/** verbose detail：截 2000 字符 */
function clipDetail(s: string, max = 2000): string | undefined {
  if (!s) return undefined;
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

function isToolResultBlock(block: ContentBlock): block is Extract<ContentBlock, { type: 'tool_result' }> {
  return block.type === 'tool_result';
}

/**
 * compact 压缩摘要前缀（ux-port-v2 P3）。2026-10-02 探针实证：SDK 0.3.267
 * manual /compact 轮不发 compact_boundary，summary assistant 文本以此开头，
 * 是唯一可靠识别信号（bridge delta 期同款前缀兜底）。
 */
export const COMPACT_SUMMARY_MARKER = '<conversation_history_summary>';

export function normalize(msg: Message): UIEvent[] {
  switch (msg.type) {
    case 'system': {
      if (msg.subtype === 'init') {
        return [
          {
            ...base(),
            type: 'system_init',
            sessionId: msg.session_id,
            model: msg.model,
            permissionMode: msg.permissionMode,
            tools: msg.tools,
            // custom-commands P5 T5：/mcp 数据源（CLI 本就下发，早期版本丢弃）
            mcpServers: msg.mcp_servers ?? [],
          },
        ];
      }
      if (msg.subtype === 'status') {
        return [{ ...base(), type: 'status', status: msg.status ?? 'idle' }];
      }
      if (msg.subtype === 'compact_boundary') {
        // ux-port-v2 P3.1：升级为一等事件（bridge 渲染分隔线 + 摘要卡片时序标志）
        return [
          {
            ...base(),
            type: 'compact_boundary',
            trigger: msg.compact_metadata.trigger,
            preTokens: msg.compact_metadata.pre_tokens,
          },
        ];
      }
      // subagent-visibility P1：后台任务四类消息（Bash run_in_background / Agent 子代理 /
      // workflow）。到达顺序不保证（`task_updated(pending)` 可早于 `task_started`，
      // 2026-10-06 探针实证），消费侧按 taskId upsert。
      if (msg.subtype === 'task_started') {
        return [
          {
            ...base(),
            type: 'task_started',
            taskId: msg.task_id,
            ...(msg.tool_use_id ? { toolUseId: msg.tool_use_id } : {}),
            description: msg.description,
            ...(msg.task_type ? { taskType: msg.task_type } : {}),
            ...(msg.workflow_name ? { workflowName: msg.workflow_name } : {}),
          },
        ];
      }
      if (msg.subtype === 'task_progress') {
        return [
          {
            ...base(),
            type: 'task_progress',
            taskId: msg.task_id,
            ...(msg.usage ? { usage: taskUsage(msg.usage) } : {}),
            ...(msg.last_tool_name ? { lastToolName: msg.last_tool_name } : {}),
            // 跨边界强转：SDK 类型是宽松 unknown[]，真实形态 = WorkflowTimelineItem[]
            // （协议 §5.2 + T1 runtime 实测 A3）
            ...(msg.workflow_progress
              ? { workflowProgress: msg.workflow_progress as unknown as WorkflowTimelineItem[] }
              : {}),
          },
        ];
      }
      if (msg.subtype === 'task_updated') {
        return [
          {
            ...base(),
            type: 'task_updated',
            taskId: msg.task_id,
            ...(msg.status ? { status: msg.status } : {}),
            patch: msg.patch ?? {},
          },
        ];
      }
      if (msg.subtype === 'task_notification') {
        return [
          {
            ...base(),
            type: 'task_notification',
            taskId: msg.task_id,
            status: msg.status,
            summary: msg.summary,
            ...(msg.output_file ? { outputFile: msg.output_file } : {}),
            ...(msg.output_stderr_file ? { outputStderrFile: msg.output_stderr_file } : {}),
            ...(msg.usage ? { usage: taskUsage(msg.usage) } : {}),
          },
        ];
      }
      return [];
    }

    case 'stream_event': {
      const ev = msg.event;
      if (ev.type === 'content_block_delta') {
        const delta = ev.delta;
        if (delta.type === 'text_delta') {
          return [{ ...base(), type: 'text_delta', text: delta.text }];
        }
        if (delta.type === 'thinking_delta') {
          return [{ ...base(), type: 'thinking_delta', text: delta.thinking }];
        }
      }
      return [];
    }

    case 'assistant': {
      const events: UIEvent[] = [];
      let text = '';
      for (const block of msg.message.content) {
        if (block.type === 'text') {
          text += block.text;
        } else if (block.type === 'tool_use') {
          const input = block.input ?? {};
          const diff = computeToolDiff(block.name, input);
          events.push({
            ...base(),
            type: 'tool_start',
            toolUseId: block.id,
            toolName: block.name,
            summary: summarizeInput(block.name, input),
            detail: clipDetail(JSON.stringify(input, null, 2)),
            ...(diff ? { diff } : {}),
          });
        }
      }
      if (text.trim().length > 0) {
        // compact 摘要识别（P3）：前缀命中 → 打标，bridge 渲染为摘要卡片
        const compactSummary = text.trimStart().startsWith(COMPACT_SUMMARY_MARKER);
        events.push({ ...base(), type: 'text_final', text, ...(compactSummary ? { compactSummary: true } : {}) });
      }
      // ux-port P4.2：每次 API 调用的真实用量（result.usage 是累计值，context 段只能用它）。
      // 注意 SDK 每轮发两条 assistant：thinking 占位消息的 usage 全 0（2026-10-01 探针实证），
      // 若照发会把状态栏闪成 0% 并把 contextBaseline（min）污染成 0 → 全 0 跳过。
      // 真实调用 input 不可能为 0（system prompt ~50k 恒在），判定安全。
      const u = msg.message.usage;
      if (
        u &&
        (u.input_tokens > 0 ||
          (u.cache_read_input_tokens ?? 0) > 0 ||
          (u.cache_creation_input_tokens ?? 0) > 0)
      ) {
        events.push({
          ...base(),
          type: 'context_usage',
          inputTokens: u.input_tokens,
          cacheReadInputTokens: u.cache_read_input_tokens ?? undefined,
          cacheCreationInputTokens: u.cache_creation_input_tokens ?? undefined,
          outputTokens: typeof u.output_tokens === 'number' ? u.output_tokens : undefined,
        });
      }
      if (msg.error) {
        // permission-surface P2.4：拒绝带 `interrupt: true` 时，CLI 用一个**合成的 assistant
        // 错误消息**承载回执 `Permission denied for tool(s): X`。它不是执行错误，是「用户拒绝」
        // （codebuddy 对应 `No, and tell … what to do differently`）→ 单独分类给 UI 用。
        events.push({
          ...base(),
          type: 'error',
          kind: isPermissionDenied(msg.error) ? 'permission_denied' : 'execution',
          message: msg.error,
        });
      }
      return events;
    }

    case 'user': {
      // 只关心携带 tool_result 的用户消息
      const content = msg.message.content;
      if (typeof content === 'string') return [];
      const events: UIEvent[] = [];
      for (const block of content) {
        if (isToolResultBlock(block)) {
          const images = resultImages(block.content);
          events.push({
            ...base(),
            type: 'tool_result',
            toolUseId: block.tool_use_id,
            summary: summarizeResult(block.content),
            detail: clipDetail(resultText(block.content)),
            isError: block.is_error === true,
            ...(images.length > 0 ? { images } : {}),
          });
        }
      }
      return events;
    }

    case 'result': {
      const usage = {
        inputTokens: msg.usage.input_tokens,
        outputTokens: msg.usage.output_tokens,
        // ux-port P4.1：保留 cache 字段供上下文用量条计算（末轮 input+cache / window）
        cacheReadInputTokens: msg.usage.cache_read_input_tokens ?? undefined,
        cacheCreationInputTokens: msg.usage.cache_creation_input_tokens ?? undefined,
        totalCostUsd: msg.total_cost_usd,
        durationMs: msg.duration_ms,
      };
      if (msg.subtype === 'success') {
        return [{ ...base(), type: 'result', success: true, result: msg.result, usage }];
      }
      return [{ ...base(), type: 'result', success: false, errors: msg.errors ?? [msg.subtype], usage }];
    }

    case 'tool_progress': {
      return [
        {
          ...base(),
          type: 'status',
          status: `tool_progress ${msg.tool_name} ${Math.round(msg.elapsed_time_seconds)}s`,
        },
      ];
    }

    // rewind P1.0：文件检查点锚点（`snapshot.messageId` = 该轮 user item id，可直接
    // 作 CLI `rewind` 的 `user_message_id`）。UI 不渲染，供 `/rewind` 候选列表。
    case 'file-history-snapshot': {
      // 备份记录透传（rewind 本地恢复兜底）：SDK 类型未声明 existedAtTrack（CLI 实发有），
      // 这里按运行时表示原样带出，缺省字段由下游按 existedAtTrack=true 兜底
      const raw = msg.snapshot.trackedFileBackups as Record<
        string,
        { backupFileName?: string; version: number; existedAtTrack?: boolean }
      >;
      const backups: Record<string, { backupFileName?: string; version: number; existedAtTrack?: boolean }> = {};
      for (const [path, rec] of Object.entries(raw)) {
        backups[path] = {
          ...(rec.backupFileName ? { backupFileName: rec.backupFileName } : {}),
          version: rec.version,
          ...(rec.existedAtTrack !== undefined ? { existedAtTrack: rec.existedAtTrack } : {}),
        };
      }
      return [
        {
          ...base(),
          type: 'checkpoint',
          messageId: msg.snapshot.messageId,
          files: Object.keys(msg.snapshot.trackedFileBackups),
          isUpdate: msg.isSnapshotUpdate,
          backups,
        },
      ];
    }

    case 'error': {
      return [{ ...base(), type: 'error', kind: 'unknown', message: msg.error }];
    }

    default:
      return [];
  }
}

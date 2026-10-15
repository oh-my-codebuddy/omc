/**
 * memory-tool.ts — `save_memory` 进程内 MCP 工具（active-memory P1.2）。
 *
 * 载体（P0 定论 1）：`createSdkMcpServer({name,tools:[tool(...)]})` → `SessionOptions.mcpServers`，
 * 工具名口径 `mcp__<server>__save_memory`；`permissionMode:'default'` 下走 `canUseTool`
 * 且顶层名即全名（P0 定论 2）→ 权限弹窗无需特殊处理。
 *
 * 双通道（P0 定论 5）：
 * - `scope:'private'` → `<projectStoreDir(cwd)>/memory/<type>_<slug>.md` + 同步 `MEMORY.md` 索引
 *   （见 `memory-store.ts`；该目录 omc 独占 → 可整文件重写）
 * - `scope:'shared'`  → `<cwd>/AGENTS.md`，**复用 `appendMemory`**（只 append / 去重 / 白名单校验）
 *
 * 硬约束：本文件**不得** import `../ui` / pi-tui（纯逻辑 + SDK 工具注册）。写盘逻辑集中在
 * `handleSaveMemory`（纯函数、可单测），`tool` 包装只做参数透传与结果格式化 —— 这样单测
 * 不需要起会话。
 */
import { join } from 'node:path';
import { createSdkMcpServer, tool } from '@tencent-ai/agent-sdk';
import { z } from 'zod';
import { collectMemoryFileCandidates } from './context-data';
import { appendMemory, memoryDebug } from './memory-append';
import {
  isMemoryType,
  memoryDir,
  readMemoryIndex,
  MEMORY_SERVER_NAME,
  SAVE_MEMORY_TOOL_NAME,
  upsertIndexEntry,
  writeMemoryTopic,
  type MemoryType,
} from './memory-store';

// 标识常量的真源在 memory-store.ts（轻量引用点，供 permission 层使用）；此处再导出保持既有 import 不变
export {
  MEMORY_SERVER_NAME,
  SAVE_MEMORY_TOOL_FULL_NAME,
  SAVE_MEMORY_TOOL_NAME,
  isMemoryToolName,
} from './memory-store';

/** 记忆通道 */
export const MEMORY_SCOPES = ['private', 'shared'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

/** 共享通道的固定目标（P0 定论 5：业界跨工具标准，别家工具只认 AGENTS.md） */
export const SHARED_MEMORY_FILE = 'AGENTS.md';

/** `save_memory` 入参（zod 校验后的形状） */
export interface SaveMemoryArgs {
  /** 短标题（也是索引显示名 / 主题文件名来源） */
  name: string;
  /** 一行摘要（索引里 `—` 后的内容；也是将来判断相关性的依据） */
  description: string;
  type: MemoryType;
  /** 正文（private 通道写进主题文件；shared 通道忽略，只用一行 name+description） */
  body?: string;
  scope: MemoryScope;
}

/** `handleSaveMemory` 结果（`text` 为返回给模型的可读文案） */
export interface SaveMemoryOutcome {
  ok: boolean;
  text: string;
  /** 落盘绝对路径（成功时） */
  path?: string;
  /** 裸文件名（private）/ `AGENTS.md`（shared） */
  file?: string;
}

/** 把 name/description 折成一行（shared 通道的条目文本） */
function oneLine(parts: Array<string | undefined>): string {
  return parts
    .map((p) => (p ?? '').replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 0)
    .join('：');
}

/**
 * 记忆落盘主入口（纯函数，供单测直接调用）。
 *
 * 返回文案刻意包含「新会话生效」提示 —— 索引在**会话构造时**注入（P0 定论 3），
 * 同一会话内新写的私有记忆不会立即进索引（正文仍可由模型 `Read` 读到）。
 */
export function handleSaveMemory(args: SaveMemoryArgs, cwd: string = process.cwd()): SaveMemoryOutcome {
  const name = (args.name ?? '').trim();
  const description = (args.description ?? '').trim();

  if (!name) return { ok: false, text: '未记录：name 不能为空。' };
  if (!isMemoryType(args.type)) {
    return { ok: false, text: `未记录：type 非法（${String(args.type)}），只接受 user/feedback/project/reference。` };
  }
  if (args.scope !== 'private' && args.scope !== 'shared') {
    return { ok: false, text: `未记录：scope 非法（${String(args.scope)}），只接受 private/shared。` };
  }

  if (args.scope === 'private') {
    const written = writeMemoryTopic(cwd, {
      name,
      description,
      type: args.type,
      body: args.body ?? '',
    });
    if (!written.ok || !written.file || !written.path) {
      memoryDebug(`TOOL private FAIL name=${name} error=${written.error ?? ''}`);
      return { ok: false, text: `未记录（私有）：${written.error ?? '写入失败'}` };
    }
    upsertIndexEntry(cwd, { name, file: written.file, description });
    memoryDebug(`TOOL private OK file=${written.file}`);
    return {
      ok: true,
      text:
        `已记住（私有）：${name}\n` +
        `位置：${written.path}\n` +
        `索引 MEMORY.md 已更新；新写的记忆在**新会话/重建会话后**进入上下文（当前会话可直接 Read 该文件）。`,
      path: written.path,
      file: written.file,
    };
  }

  // shared：固定写 <cwd>/AGENTS.md，复用 appendMemory（只 append + 去重 + 白名单校验）
  const target = join(cwd, SHARED_MEMORY_FILE);
  const candidates = collectMemoryFileCandidates(cwd);
  const allowedPaths = candidates.map((c) => c.path);
  // name 与 description 完全相同时避免写成「X：X」（模型常把标题当摘要给）
  const entry = description && description !== name ? oneLine([name, description]) : name;
  const appended = appendMemory(target, entry, { allowedPaths });

  if (!appended.ok) {
    memoryDebug(`TOOL shared FAIL name=${name} error=${appended.error ?? ''}`);
    return { ok: false, text: `未记录（共享）：${appended.error ?? '写入失败'}` };
  }

  // 遮蔽提示（P0 定论 5）：项目存在 CODEBUDDY.md 时 AGENTS.md 不被 omc/CLI 加载
  const shadowedBy = candidates.find((c) => c.path === target && !c.active && !c.sameAs)?.shadowedBy;

  memoryDebug(`TOOL shared OK dup=${appended.duplicate} path=${target}`);
  if (appended.duplicate) {
    return {
      ok: true,
      text: `该条目已存在于 ${target}（内容完全一致），未重复写入。`,
      path: target,
      file: SHARED_MEMORY_FILE,
    };
  }
  const shadowNote = shadowedBy
    ? `\n⚠ 注意：项目里有 ${shadowedBy}，它会遮蔽 AGENTS.md —— omc 与 codebuddy CLI 当前都**不会**加载 ${SHARED_MEMORY_FILE}。若需要立即生效，请考虑改写到 ${shadowedBy}。`
    : '';
  return {
    ok: true,
    text: `已记住（共享）：${name}\n已追加到 ${target}${shadowNote}`,
    path: target,
    file: SHARED_MEMORY_FILE,
  };
}

/**
 * 工具描述（= 模型看到的提示词，P1.5）。
 * 借 CodeBuddy 的指引结构：何时该记 / 不该记 / 双通道选择规则 / 组织与索引预算。
 */
export const SAVE_MEMORY_DESCRIPTION = `Save a durable memory so it survives across sessions.

WHEN to save (call this tool):
- The user explicitly asks you to remember something.
- The user corrects you ("no, not that"), or confirms a non-obvious approach ("yes, exactly" / a surprising choice accepted without pushback).
- A preference, convention, or fact shows up across more than one turn (a pattern, not a one-off).
- You learn a durable fact about the user (role, preferences, expertise), the project (goals, constraints, stakeholders, deadlines), or an external reference (where something is tracked).

WHEN NOT to save:
- Ephemeral task state, in-progress work, or anything only useful in this conversation.
- Unverified conclusions, guesses, or a single one-off command.
- Anything already documented in the project's CODEBUDDY.md/AGENTS.md (avoid duplicates).

CHANNEL (scope):
- "private": personal/local knowledge, not shared with the repo — user preferences, this machine's quirks, debugging lessons, per-machine facts.
- "shared": team/project conventions any tool or teammate should follow — coding standards, project workflows, naming rules. Appended to the project's AGENTS.md (one line per entry).

ORGANIZATION:
- One topic per memory. Reuse the same "name" to update an existing memory instead of creating near-duplicates.
- Keep the index small: "description" is a one-line, self-contained hook shown in the always-loaded index — put the detail in "body".
- "body" is markdown. Lead with the rule/decision, then add a "**Why:**" line (the reason or the past incident) and a "**How to apply:**" line (when/where this guidance kicks in), when relevant.`;

/**
 * 注入文本里的「简短指引」（P1.5 的另一半）：只讲「索引是什么 / 怎么写新记忆」，
 * 不与工具描述重复。索引本身在下方 inline。
 */
const MEMORY_INJECTION_GUIDE = [
  'You have a persistent memory system for this project. The always-loaded MEMORY.md index is below;',
  'each entry links to a topic file you can open with Read when it is relevant. Keep the index small —',
  'detail lives in the topic files.',
  'Use the save_memory tool to add or update a memory when the user asks you to remember something,',
  'corrects you, or you learn a durable fact worth keeping across sessions.',
];

/** 记忆 server 结果类型（从 SDK 构造签名取，避开深路径 import） */
export type MemoryMcpServer = ReturnType<typeof createSdkMcpServer>;

/**
 * 构造索引注入文本（P0 定论 3：`SessionOptions.systemPrompt = { append }` 的唯一用途）。
 *
 * - 无索引（`MEMORY.md` 缺失/为空）→ `null`（不注入）：此时 `save_memory` 的工具描述已足够
 *   教会模型如何记录，空注入只是白白占 token。
 * - 有索引 → 以 **system reminder** 形态（对齐 CLI `<system-reminder data-role="memory">`）
 *   注入「简短指引 + 索引全文」；正文按需由模型 `Read`（P0 定论 6）。
 * - ⚠ 内容在**会话构造时**定稿 → 新写的记忆要新会话/重建后才进索引（与 `#` 快捷同口径）。
 */
export function buildMemorySystemPrompt(cwd: string = process.cwd()): string | null {
  const index = readMemoryIndex(cwd).trim();
  if (!index) {
    // 冒烟埋点（OMC_DEBUG_MEMORY）：确认「无索引 → 不注入」分支被走到
    memoryDebug('INJECT none');
    return null;
  }
  memoryDebug(`INJECT len=${index.length}`);
  return [
    '<system-reminder data-role="memory">',
    ...MEMORY_INJECTION_GUIDE,
    `Topic files live in: ${memoryDir(cwd)}`,
    '',
    index,
    '</system-reminder>',
  ].join('\n');
}

/**
 * 构造记忆 MCP server（omc 在会话构造时注入 `mcpServers`）。
 * 写盘目标由闭包固定的 `cwd` 决定 —— 与会话的 cwd 一致。
 */
export function createMemoryServer(cwd: string = process.cwd()): MemoryMcpServer {
  const saveMemory = tool(
    SAVE_MEMORY_TOOL_NAME,
    SAVE_MEMORY_DESCRIPTION,
    {
      name: z
        .string()
        .describe(
          'Short human-readable title of the memory (also used to derive the topic filename). Reuse the same name to update an existing memory. Example: "No commit until diff reviewed".',
        ),
      description: z
        .string()
        .describe('One-line summary shown in the always-loaded memory index. Be specific and self-contained.'),
      type: z
        .enum(['user', 'feedback', 'project', 'reference'])
        .describe('Category: user profile | feedback/correction | project context | external reference.'),
      body: z
        .string()
        .optional()
        .describe(
          'Full memory content in markdown (private channel only). Structure as: the rule/fact, then "**Why:**" and "**How to apply:**" lines when applicable.',
        ),
      scope: z
        .enum(['private', 'shared'])
        .describe('"private" = this user/machine only; "shared" = project AGENTS.md, visible to all tools.'),
    },
    async (args) => {
      const outcome = handleSaveMemory(args as SaveMemoryArgs, cwd);
      const content = [{ type: 'text' as const, text: outcome.text }];
      return outcome.ok ? { content } : { content, isError: true };
    },
  );

  return createSdkMcpServer({ name: MEMORY_SERVER_NAME, version: '1.0.0', tools: [saveMemory] });
}

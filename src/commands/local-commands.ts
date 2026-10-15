/**
 * local-commands.ts — 本地型内置命令（custom-commands P5）。
 *
 * 「本地型」= omc 读本机状态直接出结果、不经模型（对齐 CLI `NON_MODEL_COMMANDS` 语义）。
 * 背景实证（[p5-command-surface.md](../../docs/plan/custom-commands/p5-command-surface.md) E2/E3/E7）：
 * CLI 的内置命令**既不能靠发送字面量触发**（`send('/cost')` 直达模型），**也不能让模型
 * 经 `Skill` 工具代调**（本地命令被 `getAllowedBuiltinCommands()` 拒绝），SDK 也没有命令
 * 执行 API ⇒ omc 只能自实现。
 *
 * 本文件收录 P5 的本地型命令 9 个（+ model-variants-and-workflows P2 追加 /workflows）：
 *   /plan  —— 切计划模式（复用 /mode 的切换语义：清 always 白名单）
 *   /status —— 会话状态一行行摘要（数据全部来自既有 `CommandContext`）
 *   /todos —— 待办列表快照（Task* 工具状态机，`bridge.taskSnapshot()`）
 *   /tasks —— 子代理 / 后台任务列表（`TaskRegistry`）
 *   /workflows —— 动态工作流只读列表（运行中 / 已保存 / 内置，model-variants-and-workflows P2）
 *   /deep-research —— 内置深度研究工作流（转发型；无参给成本提示，P2）
 *   /mcp —— MCP server 名单（`SystemInit.mcp_servers`，P5 起 normalize 透传）
 *   /memory —— 自定义指令文件清单（路径 + 大小）
 *   /copy —— 最近一条助手回复 → 系统剪贴板
 *   /doctor —— 环境自检（版本 / 平台 / 配置根 / 凭据 / 指令文件）
 *   /keybindings —— omc 键位表（静态）
 *
 * 设计取舍：
 * - 一律 `ctx.print` 打印，**不新增浮层**（避免新增 UI 面与 pi-tui 限高约束）
 * - 凭据只报「存在与否 + 条数」，**绝不打印值**
 * - 覆盖语义对齐 P4 定案：registry 内置优先，不被同名自定义命令劫持
 */
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import pkg from '../../package.json';
import { collectMemoryFileCandidates } from '../app/context-data';
import { copyLastOutcomeText, copyLastReply } from '../app/copy-last';
import { formatVariantSummary } from '../app/model-variants';
import { formatMcpReport } from '../app/mcp-view';
import type { TaskItem } from '../app/task-list';
import type { TaskEntry } from '../app/task-registry';
import { collectRunningWorkflows } from '../app/workflow-data';
import { isOverrideSet, userRoot } from '../config/paths';
import type { CommandRegistry } from './registry';
import type { SlashCommand } from './types';

const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

/** /plan —— 计划模式开关（对齐 CLI `/plan`；omc 侧复用 /mode 的切换 + 清 always 语义） */
const plan: SlashCommand = {
  name: 'plan',
  description: '切到计划模式（只读分析，不动文件）；/plan off 退回 default',
  usage: '[off]',
  async run(ctx, args) {
    const off = args.trim().toLowerCase() === 'off';
    const target = off ? 'default' : 'plan';
    await ctx.session.setPermissionMode(target);
    ctx.clearAlways();
    ctx.setCurrentMode(target);
    ctx.print([
      off
        ? `${DIM}[plan] 已退出计划模式 → default${RESET}`
        : `${DIM}[plan] 已进入计划模式：只读分析，计划经 ExitPlanMode 审批后执行（/plan off 退出）${RESET}`,
    ]);
  },
};

/** /status —— 会话状态摘要（模型 / 权限 / 目录 / 用量 / 工具），数据源全在 CommandContext */
const status: SlashCommand = {
  name: 'status',
  description: '当前会话状态（模型 / 权限模式 / 目录 / 用量 / 工具 / 场景变体）',
  run(ctx) {
    const s = ctx.stats();
    const tools = ctx.currentTools();
    const sid = ctx.session.sessionId;
    ctx.print([
      `  会话    ${sid ?? '(未初始化)'}`,
      `  模型    ${ctx.currentModel() || '(未初始化)'}`,
      // model-variants-and-workflows P1：场景变体（lite / reasoning）指向与来源
      `  变体    ${formatVariantSummary(ctx.variantStates())}`,
      // prompt-suggestion 阶段：输入框浅色建议开关
      `  建议    ${ctx.suggestEnabled() ? '开启' : '关闭'}（输入框浅色建议，Tab 落实）`,
      `  权限    ${ctx.currentMode()}`,
      `  目录    ${process.cwd()}`,
      `  用量    轮数 ${s.turns} | in ${s.inputTokens.toLocaleString()} out ${s.outputTokens.toLocaleString()} | $${s.costUsd.toFixed(4)}`,
      `  工具    ${tools.length} 个${tools.length === 0 ? '（随首轮对话到达）' : ''}`,
    ]);
  },
};

/** /suggest —— 输入框浅色「提问建议」开关（prompt-suggestion 阶段；默认开，写用户级配置） */
const suggest: SlashCommand = {
  name: 'suggest',
  description: '输入框浅色建议开关（空闲时显示，Tab 落实为输入 / Enter 直发）',
  usage: '[on|off|status]',
  run(ctx, args) {
    const a = args.trim().toLowerCase();
    if (a === 'on' || a === 'off') {
      const enabled = a === 'on';
      ctx.setSuggestEnabled(enabled);
      ctx.print([`${DIM}[suggest] 已${enabled ? '开启' : '关闭'}输入框建议${RESET}`]);
      return;
    }
    if (a && a !== 'status') {
      ctx.print([`${DIM}[suggest] 用法：/suggest [on|off|status]（缺省显示当前状态）${RESET}`]);
      return;
    }
    ctx.print([`  建议    ${ctx.suggestEnabled() ? '开启' : '关闭'}`]);
  },
};

/**
 * 扫描凭据环境变量（只报条数，不打印值）。
 * ⚠️ 必须用方括号访问 —— 点号访问 `env.CODEBUDDY_API_KEY` 在本项目运行时会被改写成
 * undefined（见 AGENTS.md「链式访问 CODEBUDDY_API_KEY 会被改写」）。
 */
export function credentialEnvNames(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env).filter(
    (k) =>
      (k === 'CODEBUDDY_API_KEY' || k.startsWith('CODEBUDDY_API_KEY_')) &&
      typeof env[k] === 'string' &&
      env[k]!.trim().length > 0,
  );
}

/** /doctor —— 环境自检（版本 / 平台 / 配置根 / 凭据 / 指令文件 / 会话） */
const doctor: SlashCommand = {
  name: 'doctor',
  description: '环境自检（版本 / 平台 / 配置目录 / 凭据 / 指令文件）',
  run(ctx) {
    const envNames = credentialEnvNames();
    const root = userRoot();
    const rootOk = existsSync(root);
    const cwd = process.cwd();
    const files: Array<[string, string]> = [
      ['AGENTS.md', join(cwd, 'AGENTS.md')],
      ['CODEBUDDY.md', join(cwd, 'CODEBUDDY.md')],
    ];
    const fileLine = files
      .map(([label, p]) => `${label} ${existsSync(p) ? `${GREEN}✓${RESET}` : `${DIM}✗${RESET}`}`)
      .join('   ');
    const homeDocs = join(homedir(), '.codebuddy', 'CODEBUDDY.md');
    ctx.print([
      `  omc        v${pkg.version}（Bun ${Bun.version} / ${process.platform} ${process.arch}）`,
      `  配置根     ${root} ${rootOk ? `${GREEN}✓${RESET}` : `${YELLOW}✗ 不存在（首次写入时创建）${RESET}`}${isOverrideSet() ? `${DIM}（OMC_CONFIG_DIR 覆盖）${RESET}` : ''}`,
      `  凭据       ${
        envNames.length > 0
          ? `${GREEN}✓${RESET} ${envNames.length} 个 API key 环境变量`
          : `${YELLOW}✗${RESET} 未发现 CODEBUDDY_API_KEY*（登录态可能由 CLI 自身持有）`
      }`,
      `  指令文件   ${fileLine}`,
      `  全局指令   ${existsSync(homeDocs) ? `${GREEN}✓${RESET} ${homeDocs}` : `${DIM}✗ ~/.codebuddy/CODEBUDDY.md${RESET}`}`,
      `  会话       ${ctx.session.sessionId ? `${GREEN}✓${RESET} ${ctx.session.sessionId}` : `${DIM}未初始化（首轮对话后建立）${RESET}`}`,
    ]);
  },
};

/** omc 键位表（静态；取自 ui/app.ts 的全局 input listener 与 composer 内建键位） */
const KEYBINDINGS: ReadonlyArray<readonly [string, string]> = [
  ['Ctrl+C', '清空输入；再按一次退出（生成中为中断）'],
  ['Ctrl+O', '展开 / 折叠工具卡与 thinking 全文（当前视口内；同一个展开/折叠手势）'],
  ['Ctrl+Shift+O', '工具活动区整体显隐（把所有工具调用折叠成一行）'],
  ['F2', '打开会话详情全屏视图（thinking 全文 + 工具输入/输出；同 /detail）'],
  ['Ctrl+T', '展开 / 折叠贴底待办列表（有任务时）'],
  ['Ctrl+G', '用 $VISUAL / $EDITOR 打开外部编辑器编辑当前草稿'],
  ['Ctrl+Y', '复制最近一条 AI 回复到剪贴板（同 /copy；已覆盖 pi-tui 默认 Emacs yank）'],
  ['Ctrl+R', '历史输入搜索'],
  ['Shift+Tab', '循环切换权限模式（`!` / `!!` shell 模式下为切换 bash ↔ local）'],
  ['Alt+↑', '把队尾排队消息取回编辑器'],
  ['↑ / ↓', '编辑历史上下翻 / 浮层内移动选择'],
  ['Ctrl+P / Ctrl+N', '同 ↑ / ↓（编辑历史上下翻）'],
  ['Ctrl+H', '删除前一个字符（同 Backspace）'],
  ['Enter', '提交 / 浮层内确认'],
  ['Esc', '取消浮层；vim 模式归 Normal；`!` / `!!` / `#` 模式下退出该模式'],
  ['! / !!', '输入行首进入 bash / 本地 bash 模式（命令+输出入上下文 / 仅本地）'],
  ['#', '输入行首把内容追加到记忆文件（选择项目 / 全局 CODEBUDDY.md）'],
  ['/', '斜杠命令补全'],
];

/** /keybindings —— 键位表 */
const keybindings: SlashCommand = {
  name: 'keybindings',
  description: '列出 omc 键盘快捷键',
  run(ctx) {
    ctx.print([
      '  快捷键：',
      ...KEYBINDINGS.map(
        ([key, desc]) => `  ${DIM}${key.padEnd(12)}${RESET} ${desc}`,
      ),
    ]);
  },
};

/** 毫秒 → 人类可读（`12ms` / `3.4s` / `2m05s`） */
function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${String(s).padStart(2, '0')}s`;
}

/** 待办状态标记（/todos） */
const TODO_MARK: Record<TaskItem['status'], string> = {
  pending: `${DIM}○${RESET}`,
  in_progress: `${YELLOW}●${RESET}`,
  completed: `${GREEN}✓${RESET}`,
};

/**
 * /todos —— 待办列表快照（Task* 工具状态机；与编辑器正上方的**贴底待办行**同源）。
 * 数据源 = `EventBridge.#taskStore`（P5 新增 `taskSnapshot()` 只读出口）。
 */
const todos: SlashCommand = {
  name: 'todos',
  description: '当前待办列表（Task* 工具维护；模型建计划后出现）',
  run(ctx) {
    const items = ctx.taskSnapshot();
    if (items.length === 0) {
      ctx.print([`${DIM}[todos] 当前无待办 —— 模型调用 TaskCreate 后在此可见${RESET}`]);
      return;
    }
    const done = items.filter((t) => t.status === 'completed').length;
    ctx.print([
      `  待办（${done}/${items.length} 完成）：`,
      ...items.map((t) => {
        const label = t.status === 'in_progress' && t.activeForm ? t.activeForm : t.subject;
        return `  ${TODO_MARK[t.status]} #${t.id} ${label}`;
      }),
    ]);
  },
};

/** 任务状态标记（/tasks） */
const TASK_MARK: Record<TaskEntry['state'], string> = {
  pending: `${DIM}…${RESET}`,
  running: `${YELLOW}▶${RESET}`,
  completed: `${GREEN}✓${RESET}`,
  failed: `${RED}✗${RESET}`,
  stopped: `${DIM}■${RESET}`,
  killed: `${RED}■${RESET}`,
};

/**
 * /tasks —— 子代理 / 后台任务列表（与常驻面板同源：`TaskRegistry`）。
 * 耗时优先用自报值 `reportedMs`（AGENTS.md 实证：Agent 任务不发终态事件，墙钟会无限增长）。
 */
const tasks: SlashCommand = {
  name: 'tasks',
  description: '子代理 / 后台任务列表（状态 · 耗时 · tokens）',
  run(ctx) {
    const list = ctx.tasks();
    if (list.length === 0) {
      ctx.print([`${DIM}[tasks] 当前无子代理 / 后台任务${RESET}`]);
      return;
    }
    const now = Date.now();
    ctx.print([
      `  任务（${list.length}）：`,
      ...list.map((t) => {
        const ms = t.reportedMs ?? (t.endedAt ?? now) - t.startedAt;
        const desc = t.description ? ` ${DIM}${t.description}${RESET}` : '';
        const usage = t.tokens > 0 ? ` ${DIM}${t.tokens} tok${RESET}` : '';
        return `  ${TASK_MARK[t.state]} ${t.name} ${DIM}${t.state} ${fmtDuration(ms)}${RESET}${usage}${desc}`;
      }),
    ]);
  },
};

/**
 * /workflows —— 动态工作流只读列表（运行中 / 已保存 / 内置）。
 * 数据源三块（见 `src/app/workflow-data.ts`）：运行中来自 `TaskRegistry`（`local_workflow`），
 * 已保存 + 内置自读磁盘（commands 频道**不含** workflow 命令，T1 E1 实证）。
 * 保存 / 中止 / 进度下钻仍在 CLI 的 `/workflows`（omc 首版只读）。
 */
const workflows: SlashCommand = {
  name: 'workflows',
  description: '动态工作流：运行中 / 已保存 / 内置（只读）',
  run(ctx) {
    const running = collectRunningWorkflows(ctx.tasks());
    const all = ctx.workflows();
    const savedList = all.filter((e) => e.scope !== 'builtin');
    const builtin = all.filter((e) => e.scope === 'builtin');
    if (running.length === 0 && all.length === 0) {
      ctx.print([`${DIM}[workflows] 无运行中 / 已保存 / 内置工作流${RESET}`]);
      return;
    }
    const lines: string[] = [];
    const now = Date.now();
    if (running.length > 0) {
      lines.push(`  运行中（${running.length}）：`);
      for (const w of running) {
        const ms = w.reportedMs ?? (w.endedAt ?? now) - w.startedAt;
        lines.push(`  ${TASK_MARK[w.state]} ${w.name} ${DIM}${w.state} ${fmtDuration(ms)}${RESET}`);
      }
    }
    lines.push(`  已保存（${savedList.length}）：`);
    if (savedList.length === 0) {
      lines.push(`  ${DIM}(无；在 CLI 的 /workflows 里选中 run 按 s 保存到 .codebuddy/workflows/ 或 ~/.codebuddy/workflows/)${RESET}`);
    } else {
      for (const e of savedList) {
        const desc = e.description ? ` ${DIM}${e.description}${RESET}` : '';
        lines.push(`  /${e.name} ${DIM}(${e.scope})${RESET}${desc}`);
      }
    }
    lines.push(`  内置（${builtin.length}）：`);
    if (builtin.length === 0) {
      lines.push(`  ${DIM}(无)${RESET}`);
    } else {
      for (const e of builtin) {
        const desc = e.description ? ` ${DIM}${e.description}${RESET}` : '';
        lines.push(`  /${e.name} ${DIM}(built-in)${RESET}${desc}`);
      }
    }
    ctx.print(lines);
  },
};

/**
 * /deep-research —— 内置深度研究工作流（转发型，model-variants-and-workflows P2 T4）。
 *
 * 内置 workflow 仅此一个（T1 W3）。无参给用法 + **成本警告**（~97 次 agent 调用，
 * Scope → Search → Fetch → Verify → Synthesize）；有参转发 `Workflow({name:'deep-research',
 * args:<问题>})`（经 `ctx.runWorkflow` → 让模型调用 Workflow 工具）。
 * lite 变体前置提示：deep-research 每个 agent 写死 `model:"lite"`，未单独设置则跑主模型
 * （成本更高，见 P1 V6 的坑）。
 */
const deepResearch: SlashCommand = {
  name: 'deep-research',
  description: '多源交叉印证深度研究（内置 workflow；~97 次 agent 调用，成本高）',
  usage: '<问题>',
  run(ctx, args) {
    const q = args.trim();
    if (!q) {
      ctx.print([
        `${DIM}[deep-research] 用法：/deep-research <问题>${RESET}`,
        `  ${YELLOW}成本提示${RESET}：一次运行 ≈ 97 次 agent 调用（Scope → Search → Fetch → Verify → Synthesize），${DIM}请先确认预算${RESET}`,
        `  ${DIM}子代理默认走 lite 变体；用 /model:lite 查看或设置${RESET}`,
      ]);
      return;
    }
    const lite = ctx.variantStates().find((v) => v.id === 'lite');
    const liteLine = lite
      ? lite.source === 'inherit'
        ? `${YELLOW}lite 未单独设置（继承主模型，子代理成本更高）${RESET}`
        : `${DIM}lite → ${lite.modelId}${RESET}`
      : `${DIM}lite → (未知)${RESET}`;
    ctx.print([
      `${DIM}[deep-research] 已启动：${q}${RESET}`,
      `  ${liteLine}`,
      `  ${DIM}运行中用 /workflows 查看进度（成本 ≈ 97 次 agent 调用）${RESET}`,
    ]);
    ctx.runWorkflow('deep-research', q);
  },
};

/**
 * /mcp —— MCP server 视图（mcp-console P2）与开关（P3）。
 * - 无参 / `list`：server + 连接状态 + 工具清单 + 配置来源 + 禁用标记
 * - `enable|disable <name>`：写 omc 自管禁用集（`~/.omc/config.json#mcp.disabled`），
 *   **需重启会话生效**；未配置的 name 照常记录 + 黄色提示（不阻断）
 *
 * 数据源 = `system_init.mcp_servers`（状态）+ `currentTools()` 反解 `mcp__<server>__<tool>`
 * + `readMcpServers().entries`（配置全集/来源）+ `mcpDisabled()`（禁用集）。格式化在
 * `src/app/mcp-view.ts`（纯函数）。资源枚举不可得（`ListMcpResources` 只是模型侧工具）。
 */
const mcp: SlashCommand = {
  name: 'mcp',
  description: 'MCP server 名单、连接状态与工具清单；enable|disable 开关',
  run(ctx, args) {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const sub = parts[0]?.toLowerCase();
    if (sub === 'enable' || sub === 'disable') {
      const name = parts[1];
      if (!name) {
        ctx.print([`  ${DIM}用法：/mcp enable|disable <name>${RESET}`]);
        return;
      }
      const cfg = ctx.mcpConfig();
      const known = new Set((cfg?.entries ?? []).map((e) => e.name));
      const next = new Set(ctx.mcpDisabled());
      const enabling = sub === 'enable';
      if (enabling) next.delete(name);
      else next.add(name);
      ctx.setMcpDisabled([...next]);
      const lines = [
        `${DIM}[mcp] 已${enabling ? '启用' : '禁用'} ${name}（需重启会话生效：退出重开或 /clear 开新对话）${RESET}`,
      ];
      if (!known.has(name)) {
        lines.push(
          `  ${YELLOW}⚠ 配置中未找到「${name}」（已记录；重启后若配置存在即生效）${RESET}`,
        );
      }
      ctx.print(lines);
      return;
    }
    const cfg = ctx.mcpConfig();
    ctx.print(
      formatMcpReport({
        servers: ctx.mcpServers(),
        tools: ctx.currentTools(),
        ...(cfg ? { entries: cfg.entries, sources: cfg.sources } : {}),
        disabled: ctx.mcpDisabled(),
      }),
    );
  },
};

/**
 * /memory —— 自定义指令（memory）文件候选与**生效状态**。
 *
 * 口径 = CLI 实测加载规则（`scripts/probe-memory-files.ts`，见
 * `collectMemoryFileCandidates` 注释）：项目 CODEBUDDY 系列存在时 `AGENTS.md` 被遮蔽 ——
 * 这正是 `/init`（建 CODEBUDDY.md）与旧 `/memory` 口径冲突暴露出来的坑，故此处显式标注。
 * 只报「加载了哪些、多大、在哪」，不做编辑（CLI 的 /memory 是编辑器入口，omc 不接）。
 */
const memory: SlashCommand = {
  name: 'memory',
  description: '自定义指令文件候选与生效状态（项目 CODEBUDDY.md / AGENTS.md + 全局）',
  run(ctx) {
    const cwd = process.cwd();
    const rows = collectMemoryFileCandidates(cwd).map((c) => {
      const exists = existsSync(c.path);
      if (!exists) return `  ${DIM}✗${RESET} ${c.label} ${DIM}(不存在)${RESET}`;
      let size = 0;
      try {
        size = statSync(c.path).size;
      } catch {
        // 读不到大小：按存在展示
      }
      const sizeText = `${DIM}${size.toLocaleString()} B${RESET}`;
      if (c.sameAs) {
        return `  ${DIM}=${RESET} ${c.label} ${sizeText} ${DIM}（与 ${c.sameAs} 同一文件）${RESET} ${c.path}`;
      }
      if (!c.active) {
        return `  ${YELLOW}⚠${RESET} ${c.label} ${sizeText} ${YELLOW}未生效（被 ${c.shadowedBy} 遮蔽）${RESET} ${DIM}${c.path}${RESET}`;
      }
      return `  ${GREEN}✓${RESET} ${c.label} ${sizeText} ${c.path}`;
    });
    ctx.print([
      '  记忆文件（生效口径见 CLI 实测；⚠ = 存在但不进上下文）：',
      ...rows,
      `${DIM}  规则：项目 CODEBUDDY.md / CODEBUDDY.local.md 存在时，项目 AGENTS.md 不生效${RESET}`,
      `${DIM}  追加记忆：输入行首 \`# <内容>\` 选择文件写入（新会话生效）${RESET}`,
    ]);
  },
};

/**
 * /copy —— 复制最近一条 assistant 定稿到系统剪贴板。
 * 数据源 = main 侧 `lastAssistantText`（`text_final` 时更新；换会话清零）。
 * 逻辑与 `Ctrl+Y` 共用（`src/app/copy-last.ts`）。
 */
const copy: SlashCommand = {
  name: 'copy',
  description: '把最近一条助手回复复制到系统剪贴板（同 Ctrl+Y）',
  run(ctx) {
    const outcome = copyLastReply(ctx.lastAssistantText(), ctx.copyToClipboard);
    const color = outcome.kind === 'fail' ? YELLOW : DIM;
    ctx.print([`${color}${copyLastOutcomeText(outcome)}${RESET}`]);
  },
};

export function registerLocalCommands(registry: CommandRegistry): void {
  for (const cmd of [plan, status, suggest, todos, tasks, workflows, deepResearch, mcp, memory, copy, doctor, keybindings]) {
    registry.register(cmd);
  }
}

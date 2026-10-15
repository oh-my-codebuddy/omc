/**
 * builtin.ts — 内置斜杠命令第一批（P5.5）。
 *
 * 语义决策：
 * - /clear = **开始新对话**（clear 阶段对齐 codebuddy）：关旧会话 → 新会话清空模型上下文 +
 *   清转录；旧对话仍可通过 /resume 找回；继承当前模型/权限模式；运行中拒绝。
 *   （旧行为「只清屏、不动上下文」已弃用；`ctx.clearScreen()` 仍保留供其他用途。）
 * - /mode 切换即清空 always 白名单（安全决策：白名单是「当前模式下的让渡」，
 *   模式变了让渡前提失效）。
 * - /mode 列表用静态 7 模式（SDK getAvailableModes 为 experimental，
 *   部分 CLI 不支持；类型层面这 7 个是合法值，切换失败由 SDK 报错兜底）。
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dedupePath, defaultExportFileName, renderSessionMarkdown } from '../app/export-markdown';
import { buildStatsReport } from '../app/stats-report';
import { loadUsageDaily } from '../app/usage-daily';
import { SessionLog, sessionTitle, titleFile, writeSidecarTitle } from '../session-store/jsonl';
import { PERMISSION_MODES, permissionModeList } from '../permission/modes';
import { registerLocalCommands } from './local-commands';
import { registerPromptCommands } from './prompt-commands';
import { registerVariantCommands } from './variant-commands';
import { registerGoalCommand } from './goal';
import type { CommandRegistry } from './registry';
import type { SlashCommand } from './types';

const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

const help: SlashCommand = {
  name: 'help',
  description: '列出所有斜杠命令',
  run(ctx) {
    const lines = ctx.registry.list().map((c) => {
      const usage = c.usage ? ` ${c.usage}` : '';
      return `  ${CYAN}/${c.name}${usage}${RESET} — ${c.description}`;
    });
    ctx.print(['可用命令：', ...lines]);
  },
};

const clear: SlashCommand = {
  name: 'clear',
  description: '开始新对话（清空上下文；旧对话仍可通过 /resume 访问）',
  run(ctx) {
    ctx.clearConversation();
  },
};

const model: SlashCommand = {
  name: 'model',
  description: '查看/切换模型（无参打开交互选择浮层）',
  usage: '[model-id]',
  async run(ctx, args) {
    if (args) {
      await ctx.session.setModel(args);
      ctx.setCurrentModel(args);
      ctx.print([`${DIM}[model] 已切换 → ${args}（下一轮生效）${RESET}`]);
      return;
    }
    // 无参：交互浮层（非 TTY 时 openModel 内部回退文本列表）
    ctx.openModel();
  },
};

const mode: SlashCommand = {
  name: 'mode',
  description: '查看/切换权限模式（无参打开选择浮层；切换会清空 always 白名单）',
  usage: '[mode]',
  async run(ctx, args) {
    if (!args.trim()) {
      ctx.openMode();
      return;
    }
    const key = args.trim().toLowerCase();
    const hit = PERMISSION_MODES.find((m) => m.id.toLowerCase() === key);
    if (!hit) {
      ctx.print([`${YELLOW}[mode] 未知模式：${args}（可选：${permissionModeList()}）${RESET}`]);
      return;
    }
    await ctx.session.setPermissionMode(hit.id);
    ctx.clearAlways();
    ctx.setCurrentMode(hit.id);
    ctx.print([`${DIM}[mode] 已切换 → ${hit.id}，always 白名单已清空${RESET}`]);
  },
};

const resume: SlashCommand = {
  name: 'resume',
  description: '选择并恢复当前目录的历史会话',
  run(ctx) {
    ctx.openResume();
  },
};

/**
 * /rewind（rewind P1.3）：回退到某个检查点（文件 / 对话 / 两者）。
 *
 * 无参 → 打开候选浮层（↑↓ 选轮次 → 选范围 → 预览 → 确认）；
 * 有参 → `<编号> [files|conversation|both]` 直接执行（非交互 / 冒烟用），`list` 只列候选。
 */
const rewind: SlashCommand = {
  name: 'rewind',
  usage: '[list | <编号> [files|conversation|both]]',
  description: '回退到某个检查点（文件 / 对话 / 两者）；无参打开选择浮层',
  async run(ctx, args) {
    const trimmed = args.trim();
    if (!trimmed) {
      ctx.openRewind();
      return;
    }
    if (trimmed === 'list') {
      ctx.print(ctx.rewindList());
      return;
    }
    const [numRaw, scopeRaw] = trimmed.split(/\s+/);
    const num = Number.parseInt(numRaw ?? '', 10);
    if (!Number.isInteger(num) || num <= 0) {
      ctx.print([`${YELLOW}用法：/rewind [list | <编号> [files|conversation|both]]${RESET}`]);
      return;
    }
    const lines = await ctx.rewindTo(num, scopeRaw);
    ctx.print(lines);
  },
};

const compact: SlashCommand = {
  name: 'compact',
  description: '压缩对话上下文（CLI 内建：发送 /compact 触发）',
  run(ctx) {
    ctx.sendToAgent('/compact');
  },
};

const summary: SlashCommand = {
  name: 'summary',
  description: '查看最近一次压缩摘要全文（浮层滚动；摘要卡展开限高，全文在此）',
  run(ctx) {
    ctx.openSummary();
  },
};

/** detail-view P1.3：会话详情全屏视图（含 thinking 全文与工具输出；`F2` 同效） */
const detail: SlashCommand = {
  name: 'detail',
  description: '全屏查看会话详情（thinking 全文 + 工具输入/输出，可滚动只读；同 F2）',
  run(ctx) {
    ctx.openDetail();
  },
};

const cost: SlashCommand = {
  name: 'cost',
  description: '本会话 token/轮数/费用统计（含恢复的历史）',
  run(ctx) {
    const s = ctx.stats();
    ctx.print([
      `  轮数 ${s.turns} | in ${s.inputTokens.toLocaleString()} out ${s.outputTokens.toLocaleString()} | $${s.costUsd.toFixed(4)}`,
    ]);
  },
};

const usage: SlashCommand = {
  name: 'usage',
  description: '打开用量 dashboard（session 累计 + 每日活动热力图）',
  run(ctx) {
    ctx.openUsage();
  },
};

const context: SlashCommand = {
  name: 'context',
  description: '上下文构成报告（网格 + 分类明细；all 展开 memory 文件明细）',
  usage: '[all]',
  run(ctx, args) {
    ctx.print(ctx.contextReport(args.trim().toLowerCase() === 'all'));
  },
};

/**
 * ux-port-v2 P2.2：/export [path] 导出当前会话为 markdown。
 * 数据源 = SessionLog 落盘记录（resume 的历史同文件，天然含全部历史）；
 * 未落盘的进行中轮次不在导出内（落盘口径即定稿口径）。
 * 默认路径防覆盖（-1 -2 后缀）；用户给 path 则用用户的（相对 cwd 解析，可覆盖）。
 */
const exportCmd: SlashCommand = {
  name: 'export',
  description: '导出当前会话为 markdown 文件并打印路径',
  usage: '[path]',
  run(ctx, args) {
    const cwd = process.cwd();
    const sid = ctx.session.sessionId;
    const records = sid ? SessionLog.load(cwd, sid) : [];
    if (records.length === 0) {
      ctx.print([`${DIM}[export] 当前会话无落盘记录——先进行一轮对话再导出${RESET}`]);
      return;
    }
    const md = renderSessionMarkdown(records, {
      sessionId: sid,
      exportedAt: new Date(),
      model: ctx.currentModel(),
    });
    const target = args.trim()
      ? resolve(cwd, args.trim())
      : dedupePath(join(cwd, defaultExportFileName(sid, new Date())), existsSync);
    try {
      writeFileSync(target, md);
    } catch (e) {
      ctx.print([
        `${YELLOW}[export] 写入失败：${e instanceof Error ? e.message : String(e)}${RESET}`,
      ]);
      return;
    }
    ctx.print([`${DIM}[export] 已导出 ${records.length} 条记录 → ${target}${RESET}`]);
  },
};

/**
 * ux-port-v2 P5.1：/rename [新标题] 查看/修改当前会话标题。
 * 标题写 sidecar 文件（{sessionDir}/{sid}.title），SessionLog.list 优先读它——
 * /resume 列表无需改动自动生效；不动 jsonl 本体（追加式存储改首行破坏 replay）。
 */
const rename: SlashCommand = {
  name: 'rename',
  description: '查看/修改当前会话标题（/resume 列表生效，重启不丢）',
  usage: '[新标题]',
  run(ctx, args) {
    const cwd = process.cwd();
    const sid = ctx.session.sessionId;
    if (!sid) {
      ctx.print([`${DIM}[rename] 会话尚未初始化——先进行一轮对话再命名${RESET}`]);
      return;
    }
    const title = args.trim();
    if (!title) {
      ctx.print([`${DIM}[rename] 当前标题：${sessionTitle(cwd, sid)}${RESET}`]);
      return;
    }
    if (writeSidecarTitle(cwd, sid, title)) {
      ctx.print([`${DIM}[rename] 标题已更新 → ${title}${RESET}`]);
      ctx.refreshSessionName(); // statusline session_name 段即时生效
    } else {
      ctx.print([`${YELLOW}[rename] 写入失败（${titleFile(cwd, sid)}）${RESET}`]);
    }
  },
};

/**
 * ux-port-v2 P5.2：/stats 跨会话用量数字快查。
 * 与 /usage（图形 dashboard）/cost（本会话单行）三角分工：/stats = 数字三段视图。
 * 数据源 usage-daily.jsonl（P4.3 落盘口径），tokens 为估算值（result 差分）。
 */
const stats: SlashCommand = {
  name: 'stats',
  description: '跨会话用量数字视图（今日/近 7 日/累计；usage-daily 口径）',
  run(ctx) {
    ctx.print(buildStatsReport(loadUsageDaily()));
  },
};

/**
 * ux-port-v2 P5.3：/tools 列当前会话实际加载的工具集（system_init 口径）。
 * 价值定位：快速确认 SDK 配置生效的工具列表，非 omp 的工具详情页。
 * 首轮对话前不可用：2026-10-03 探针实证 CLI 在首个用户消息前不发 system/init
 * （stream()-before-send 空等 30s），无法启动预热，维持「首轮后可用」。
 */
const tools: SlashCommand = {
  name: 'tools',
  description: '列出当前会话加载的工具（system_init 口径，首轮对话后可用）',
  run(ctx) {
    const list = ctx.currentTools();
    if (list.length === 0) {
      ctx.print([`${DIM}[tools] 会话未初始化——工具列表随首轮对话到达（SDK 延迟初始化）${RESET}`]);
      return;
    }
    ctx.print([`  当前会话工具（${list.length} 个）：`, `  ${list.join(', ')}`]);
  },
};

const verbose: SlashCommand = {
  name: 'verbose',
  description: '切换工具详情全显',
  run(ctx) {
    const on = ctx.toggleVerbose();
    ctx.print([`${DIM}[verbose] 已${on ? '开启' : '关闭'}${RESET}`]);
  },
};

const vim: SlashCommand = {
  name: 'vim',
  description: '切换 vim 编辑模式（写用户配置持久化）',
  run(ctx) {
    const on = ctx.toggleVim();
    ctx.print([
      on
        ? `${DIM}[vim] 已开启：Normal/Insert 模态编辑，Esc 归 vim，生成中断用 Ctrl-C${RESET}`
        : `${DIM}[vim] 已关闭${RESET}`,
    ]);
  },
};

const shape: SlashCommand = {
  name: 'shape',
  description: '查看/切换输入区形状（无参打开选择浮层）',
  usage: '[shape-id]',
  run(ctx, args) {
    if (args) {
      ctx.setComposerShape(args.trim());
      return;
    }
    ctx.openShape();
  },
};

/**
 * plugin 阶段 P5.4：/plugin 插件管理（列表 + Enter 启停 + r 重载）。
 * CLI 侧命令面是 `omc plugin <子命令>`；此处为 TUI 内入口。
 */
const plugin: SlashCommand = {
  name: 'plugin',
  description: '插件管理（列表 / 启停 / 重载；CLI 见 omc plugin help）',
  run(ctx) {
    ctx.openPlugins();
  },
};

const exit: SlashCommand = {
  name: 'exit',
  description: '退出',
  run(ctx) {
    ctx.exit();
  },
};

/**
 * skill-system P4.3：/skills 只读 skill 列表（omc 自读磁盘，**不是** CLI 的 skills 命令）。
 * 数据源 = collectSkillEntries 全量（含 user-invocable:false），按发现来源分组。
 */
const skills: SlashCommand = {
  name: 'skills',
  description: '列出本机全部 skill（omc 只读列表；按来源分组，含 user-invocable:false）',
  run(ctx) {
    ctx.openSkills();
  },
};

/** /quit 作为 /exit 别名 */
const quit: SlashCommand = { ...exit, name: 'quit' };

export function registerBuiltinCommands(registry: CommandRegistry): void {
  for (const cmd of [help, clear, model, mode, resume, rewind, compact, summary, detail, cost, usage, context, skills, exportCmd, rename, stats, tools, verbose, vim, shape, plugin, exit, quit]) {
    registry.register(cmd);
  }
  // custom-commands P5：本地型命令（/plan /status /doctor /keybindings …）注册于独立模块
  registerLocalCommands(registry);
  // custom-commands P5：prompt 型内置命令（/init /commit /commit-push-pr /security-review）
  registerPromptCommands(registry);
  // model-variants-and-workflows P1：场景变体命令（/model:lite /model:reasoning）
  registerVariantCommands(registry);
  // goal P1：会话级停止条件命令（/goal）
  registerGoalCommand(registry);
}

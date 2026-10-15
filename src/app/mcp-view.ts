/**
 * mcp-view.ts — `/mcp` 报告格式化（mcp-console P2/P3，纯函数便于单测）。
 *
 * 数据源（全在 `CommandContext` 内，无需新控制通道）：
 * - server 名单 + status：`ctx.mcpServers()`（= `system_init.mcp_servers`，`[{name,status}]`）
 * - 配置全集 + 来源：`ctx.mcpConfig().entries`（P1 的 `readMcpServers` 结果；含 scope/sourceFile）
 * - 禁用集：`ctx.mcpDisabled()`（P3 omc 自管 ∪ `.mcp.json#disabledMcpServers`）
 * - 工具清单：从 `ctx.currentTools()` 反解 `mcp__<server>__<tool>`（**实证命名口径**；
 *   不用私有 `mcp_status` 控制通道 —— 它被 CLI 拒绝，见 AGENTS.md 耦合点）
 *
 * ⚠ P3 起**全集 = entries ∪ servers**：被禁用的 server 不在运行时 `servers` 里
 * （注入时已剔除），须靠 `entries` 才能展示并标 `⊘ disabled`。
 *
 * 缺口（不做）：`serverInfo.version` / `needs-auth` / `pending` 细分、资源（prompts/resources）
 * 枚举 —— 均不可得。
 */
import type { McpServerEntry } from './mcp-config';

const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

/** server 状态标记（connected/ok/ready → ✓；failed/error → ✗；其余 → …） */
export function mcpStatusMark(status: string): string {
  const s = status.toLowerCase();
  if (s === 'connected' || s === 'ready' || s === 'ok') return `${GREEN}✓${RESET}`;
  if (s === 'failed' || s === 'error') return `${RED}✗${RESET}`;
  return `${DIM}…${RESET}`;
}

/** 工具名口径：`mcp__<server>__<tool>`（双下划线分段；server 取第一个 `__` 前，tool 可含 `__`） */
const MCP_TOOL_RE = /^mcp__(.+?)__(.+)$/;

/**
 * 反解 per-server 工具清单：`mcp__<server>__<tool>` → `Map<server, tool[]>`。
 * 非 `mcp__` 开头的工具跳过；保持输入顺序。
 */
export function groupMcpTools(tools: readonly string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const t of tools) {
    const m = MCP_TOOL_RE.exec(t);
    if (!m) continue;
    const server = m[1]!;
    const tool = m[2]!;
    const arr = map.get(server) ?? [];
    arr.push(tool);
    map.set(server, arr);
  }
  return map;
}

export interface McpReportInput {
  /** `system_init.mcp_servers`（运行时状态；被禁用的 server 因未注入而不在此） */
  servers: Array<{ name: string; status: string }>;
  /** `currentTools()`（含 `mcp__*`；反解工具清单） */
  tools: readonly string[];
  /** `readMcpServers().entries`（配置全集，含来源 / 禁用标记；P3 起为主数据源） */
  entries?: readonly McpServerEntry[];
  /** 实际命中的配置文件（`/mcp` 尾部「配置来源」行；缺省不打印） */
  sources?: { user: string | null; project: string | null };
  /** 禁用名单（omc 自管 ∪ `.mcp.json#disabledMcpServers`；标 `⊘ disabled`） */
  disabled?: readonly string[];
}

/** status 判「连接失败」（决定无工具时的措辞） */
function isFailed(status: string): boolean {
  const s = status.toLowerCase();
  return s === 'failed' || s === 'error';
}

/**
 * 生成 `/mcp` 报告行（已着色；单测用 `toContain` 断言文本片段，色码不影响）。
 *
 * **全集 = `entries`（配置）∪ `servers`（运行时）**（P3）：这样被禁用的 server（不在
 * 运行时 `servers` 里，因为注入时已剔除）也能展示并标 `⊘ disabled`。顺序 = entries 优先。
 *
 * 输出形态：
 * ```
 *   MCP server（2）：
 *   ✓ echo    connected  [user]
 *     · mcp__echo__echo
 *   ⊘ other   disabled   [project]
 *     (已禁用，不注入会话)
 *   配置来源：user /…/.mcp.json · project （无）
 * ```
 */
export function formatMcpReport(input: McpReportInput): string[] {
  const { servers, tools, entries = [], sources, disabled = [] } = input;
  const lines: string[] = [];
  const sourceLine = sources
    ? `  ${DIM}配置来源：user ${sources.user ?? '（无）'} · project ${sources.project ?? '（无）'}${RESET}`
    : null;

  // 全集：entries 顺序优先，补 servers 独有项（避免重复）
  const names: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (!seen.has(e.name)) {
      seen.add(e.name);
      names.push(e.name);
    }
  }
  for (const s of servers) {
    if (!seen.has(s.name)) {
      seen.add(s.name);
      names.push(s.name);
    }
  }

  if (names.length === 0) {
    lines.push(`  ${DIM}[mcp] 当前会话无 MCP server（配置见 ~/.codebuddy/.mcp.json）${RESET}`);
    if (sourceLine) lines.push(sourceLine);
    return lines;
  }

  const statusOf = new Map(servers.map((s) => [s.name, s.status]));
  const scopeOf = new Map(entries.map((e) => [e.name, e.scope]));
  const disabledSet = new Set(disabled);
  const toolMap = groupMcpTools(tools);

  const rows = names.map((name) => {
    const isDisabled = disabledSet.has(name);
    return {
      name,
      disabled: isDisabled,
      status: isDisabled ? 'disabled' : (statusOf.get(name) ?? 'pending'),
      scope: scopeOf.get(name),
      tools: toolMap.get(name) ?? [],
    };
  });
  const nameWidth = Math.max(...rows.map((r) => r.name.length));
  const statusWidth = Math.max(...rows.map((r) => r.status.length));

  lines.push(`  MCP server（${rows.length}）：`);
  for (const r of rows) {
    const scopeTag = r.scope ? `  ${DIM}[${r.scope}]${RESET}` : '';
    if (r.disabled) {
      lines.push(`  ${DIM}⊘${RESET} ${r.name.padEnd(nameWidth)}  ${DIM}${r.status.padEnd(statusWidth)}${RESET}${scopeTag}`);
      lines.push(`    ${DIM}(已禁用，不注入会话)${RESET}`);
      continue;
    }
    lines.push(`  ${mcpStatusMark(r.status)} ${r.name.padEnd(nameWidth)}  ${DIM}${r.status.padEnd(statusWidth)}${RESET}${scopeTag}`);
    if (r.tools.length === 0) {
      lines.push(`    ${DIM}(无工具${isFailed(r.status) ? '：连接失败' : ''})${RESET}`);
    } else {
      for (const t of r.tools) lines.push(`    ${DIM}·${RESET} mcp__${r.name}__${t}`);
    }
  }
  if (sourceLine) lines.push(sourceLine);
  lines.push(`  ${DIM}改配置 / 开关需重启会话生效（退出重开，或 /clear 开新对话）${RESET}`);
  return lines;
}

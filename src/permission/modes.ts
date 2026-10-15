/**
 * modes.ts — 权限模式单一来源（/mode 命令、Shift+Tab 循环与 --permission-mode 启动参数共用）。
 *
 * SDK 对权限模式有意分三层（cbc-shared/node/settings/settings-types.d.ts:2-7 注释
 * 明确「三处是有意的三层，不要合并」）：
 *  1. 枚举全集 PermissionMode（10 值，含 ignore/work/delegate 等仅内部态）
 *  2. --permission-mode 启动 argv：CLI_PROCESS_PERMISSION_MODES（7 值，含 dontAsk/fullAccess）
 *  3. set_permission_mode 运期切换：控制信号最窄（6 值，含 auto、不含 fullAccess/delegate）
 *
 * SDK 公开的 TS 类型 `Options.permissionMode`（lib/types.d.ts:18）只等于第 1 层的
 * 一个 7 值子集：含 delegate/fullAccess、缺 auto —— 两处都对不上第 3 层。故本模块
 * 不直接复用它，分别显式声明「可切换集」与「启动集」，避免把只存在于类型层的模式
 * 塞进运行期切换（否则 CLI 抛 `Invalid permission mode: <x>`）。
 *
 * 面市集合（可切换集）进一步收敛为 5 个，对齐 codebuddy 的 Shift+Tab 循环：
 * default / bypassPermissions / acceptEdits / auto / plan；dontAsk 控制信号虽接受，
 * 但不进 /mode 与循环（与 codebuddy 一致）；delegate 运行期不可切换，仅指示行保留展示。
 *
 * 依据文件：
 *  - 运期切换集：cli/dist-server/types/node/control-signal/control-signal-protocol.d.ts:274
 *  - 启动集：cli/dist-server/types/node/cli/cli-runtime-options.d.ts:32
 */
/** 面市可切换的权限模式（/mode 列表、Shift+Tab 循环、setPermissionMode 的唯一来源） */
export type SwitchablePermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'auto';

/** 启动期 --permission-mode 合法集（CLI_PROCESS_PERMISSION_MODES）：可切换集 + dontAsk + fullAccess */
export type LaunchPermissionMode = SwitchablePermissionMode | 'dontAsk' | 'fullAccess';

export interface PermissionModeEntry {
  id: SwitchablePermissionMode;
  description: string;
}

/** 面市可切换的 5 个模式（/mode 列表与 setPermissionMode 的唯一来源） */
export const PERMISSION_MODES: readonly PermissionModeEntry[] = [
  { id: 'default', description: '每个需授权的工具都弹确认' },
  { id: 'acceptEdits', description: '自动放行文件编辑，其余仍确认' },
  { id: 'bypassPermissions', description: '跳过所有权限确认（危险）' },
  { id: 'plan', description: '计划模式：只读分析，不动文件' },
  { id: 'auto', description: '自动判定：按策略放行或确认' },
];

/** 逗号分隔的可切换模式列表（/mode 错误提示用） */
export function permissionModeList(): string {
  return PERMISSION_MODES.map((m) => m.id).join(' | ');
}

export function isPermissionMode(v: string): v is SwitchablePermissionMode {
  return PERMISSION_MODES.some((m) => m.id === v);
}

/**
 * Shift+Tab 循环顺序，照抄 codebuddy chat:cycleMode 的数组
 * （headless.js @10317062：Default → BypassPermissions → AcceptEdits → Auto → Plan；
 * 原数组尾部的 Delegate 因运行期不可切换而剔除）。
 */
export const PERMISSION_MODE_CYCLE: readonly SwitchablePermissionMode[] = [
  'default',
  'bypassPermissions',
  'acceptEdits',
  'auto',
  'plan',
];

/** 当前模式 → 循环中的下一个模式（不在循环内（如 dontAsk/fullAccess）回落到循环首位） */
export function nextPermissionMode(current: string): SwitchablePermissionMode {
  const i = PERMISSION_MODE_CYCLE.indexOf(current as SwitchablePermissionMode);
  return PERMISSION_MODE_CYCLE[(i + 1) % PERMISSION_MODE_CYCLE.length];
}

/**
 * 启动集：显式照抄 CLI_PROCESS_PERMISSION_MODES（cli-runtime-options.d.ts:32）。
 * 与可切换集的差异只有两处：
 *  - fullAccess：仅能启动时经 --permission-mode 设定，运行期 set_permission_mode 拒绝它；
 *  - dontAsk：运行期其实可切换（控制信号接受），但按 codebuddy 惯例不进 /mode 与循环，故仅留在启动集。
 * （delegate 不在启动集也不在切换集——它只存在于枚举/类型层。）
 */
export const LAUNCH_PERMISSION_MODES: readonly LaunchPermissionMode[] = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
  'fullAccess',
];

/** 逗号分隔的启动模式列表（--permission-mode 校验/help 用） */
export function launchPermissionModeList(): string {
  return LAUNCH_PERMISSION_MODES.join(' | ');
}

export function isLaunchPermissionMode(v: string): v is LaunchPermissionMode {
  return (LAUNCH_PERMISSION_MODES as readonly string[]).includes(v);
}

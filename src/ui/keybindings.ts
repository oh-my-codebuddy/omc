/**
 * 键位对齐 codebuddy CLI。
 *
 * 一、Ctrl+P / Ctrl+N 与 ↑ / ↓ 完全等价（Emacs 风格历史翻页）。
 * codebuddy 在 TtyInputService 的输入层把 `\x10`(Ctrl+P)→`\x1b[A`(↑)、
 * `\x0e`(Ctrl+N)→`\x1b[B`(↓) 硬别名（dist/codebuddy.js applyKeyMapping），
 * 所以那边二者毫无区别。pi-tui 没有这层别名，改在 keybindings 层绑定：
 *   - tui.editor.cursorUp/Down 覆盖输入框（历史上/下 + 多行光标移动）
 *   - tui.select.up/Down       覆盖补全菜单与浮层选择
 * 两处都补上，才与 codebuddy「全局等价」的行为一致。
 *
 * 二、Ctrl+H = Backspace（Emacs/readline 的 backward-delete-char）。
 * 普通终端 Ctrl+H 发 `\x08`(BS)，pi-tui 已解析为 "backspace"，本就可用；
 * 但 Kitty 键盘协议下 Ctrl+H 发 `\x1b[104;5u`(CSI-u) → "ctrl+h"，默认无绑定
 * （omc 主力终端是 Kitty，故表现为无效）。给 deleteCharBackward 补 `ctrl+h`
 * 覆盖该路径，editor / Input / settings-list 等文本输入处一并生效。
 *
 * 注意：omc 未接线 `app.model.cycleForward`（Ctrl+P 默认绑定），故 Ctrl+P 当前
 * 落入 editor 动作拦截链后因无 handler 直接透传，改绑到 cursorUp 即可生效，
 * 无需再解绑 model cycle。
 */
import { KeybindingsManager, TUI_KEYBINDINGS, setKeybindings, type KeybindingsConfig } from '@oh-my-pi/pi-tui';

/** omc 相对 pi-tui 默认键位的覆盖项（键位来源见文件头注释）。 */
export const OMC_USER_BINDINGS: KeybindingsConfig = {
  'tui.editor.cursorUp': ['up', 'ctrl+p'],
  'tui.editor.cursorDown': ['down', 'ctrl+n'],
  'tui.select.up': ['up', 'ctrl+p'],
  'tui.select.down': ['down', 'ctrl+n'],
  // 保留默认 backspace（覆盖 \x7f / 普通终端 \x08），追加 Kitty CSI-u 的 ctrl+h
  'tui.editor.deleteCharBackward': ['backspace', 'ctrl+h'],
  // todo-hud P1 修订（2026-10-12）：omc 的 thinking 显隐与工具卡展开是**同一个手势**
  // `ctrl+o`（见 app.ts 全局监听）→ 这里把 `app.thinking.toggle` 的默认键（pi-tui
  // 表里是 ctrl+t，而 omc 的 ctrl+t 已给「展开/折叠待办」）改绑到 ctrl+o，避免帮助表
  // 与实际行为不一致。原计划的 `alt+t` 已撤销：Kitty / Ghostty 实测都发 `†`
  // （macOS Option 被终端当打字），alt 组合不可达。
  'app.thinking.toggle': ['ctrl+o'],
};

/**
 * 安装 omc 全局键位。必须在任何组件构造之前调用（`createPiTuiApp` 里 `new Composer`
 * 之前），否则已按旧表解解析的组件不会感知。
 */
export function installOmcKeybindings(): void {
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, OMC_USER_BINDINGS));
}

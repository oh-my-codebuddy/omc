/**
 * cli-args.ts — 启动参数解析（纯函数，可单测）。
 * 支持：--continue/-c、--resume/-r <id>、--model/-m <id>、--permission-mode <mode>、
 * -p/--print、--output-format <format>、-y/--dangerously-skip-permissions、
 * --help/-h、--version/-v，其余位置参数拼为 prompt
 * （并保留 `positional` 数组供插件子命令分发，P4.3）。
 * 带值选项只接受空格分隔形式（--model x，不支持 --model=x）。
 */
export interface CliArgs {
  prompt: string;
  /** 位置参数（空格切分，保持原序）；prompt 是它们的 join。子命令分发用（P4.3） */
  positional: string[];
  cont: boolean;
  resumeId: string | null;
  /** --model/-m 指定的模型 id；未指定为 null（由调用方回退配置/默认值） */
  model: string | null;
  /** --permission-mode 指定的权限模式；未指定为 null（由调用方回退配置/默认值） */
  permissionMode: string | null;
  /** -p/--print：强制非交互一次性执行（压过 TTY 检测，不启动 pi-tui） */
  print: boolean;
  /**
   * --output-format 指定的输出格式；未指定为 'text'。
   * 保留原始字符串（同 permissionMode 口径），合法性由调用方在会话创建前校验。
   */
  outputFormat: string;
  /** -y/--dangerously-skip-permissions：跳过权限弹窗（等价 bypassPermissions 且显式放行） */
  dangerouslySkipPermissions: boolean;
  help: boolean;
  version: boolean;
}

export function parseArgv(argv: string[]): CliArgs {
  let cont = false;
  let resumeId: string | null = null;
  let model: string | null = null;
  let permissionMode: string | null = null;
  let print = false;
  let outputFormat = 'text';
  let dangerouslySkipPermissions = false;
  let help = false;
  let version = false;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--continue' || a === '-c') cont = true;
    else if (a === '--resume' || a === '-r') resumeId = argv[++i] ?? null;
    else if (a === '--model' || a === '-m') model = argv[++i] ?? null;
    else if (a === '--permission-mode') permissionMode = argv[++i] ?? null;
    else if (a === '--print' || a === '-p') print = true;
    else if (a === '--output-format') outputFormat = argv[++i] ?? '';
    else if (a === '--dangerously-skip-permissions' || a === '-y') dangerouslySkipPermissions = true;
    else if (a === '--help' || a === '-h') help = true;
    else if (a === '--version' || a === '-v') version = true;
    else rest.push(a);
  }
  return {
    prompt: rest.join(' ').trim(),
    positional: rest,
    cont,
    resumeId,
    model,
    permissionMode,
    print,
    outputFormat,
    dangerouslySkipPermissions,
    help,
    version,
  };
}

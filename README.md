# oh-my-codebuddy

基于 `@tencent-ai/agent-sdk` 的终端编码代理，UI 层基于 `@oh-my-pi/pi-tui`（omp 观感）。
Bun 锁定（pi-tui 含 Bun 专有 API + N-API 原生模块）| macOS arm64 | 个人工具。

## 安装

前置：已全局安装 codebuddy CLI（`npm i -g @tencent-ai/codebuddy-code`）并完成登录。

```sh
bun install
bun run build        # 产出 dist/omc + dist/pi_natives.darwin-arm64.node（两文件自包含）
```

## 用法

```sh
bun run dev                 # 开发模式（REPL）
./dist/omc                  # 编译产物（REPL）
./dist/omc "帮我重构 xxx"    # 一次性模式（仅把最终答案打到 stdout，不启动 TUI）
./dist/omc -p "帮我重构 xxx" # 同上，-p / --print 为显式开关（非交互一次性执行）
echo "总结这个报错" | ./dist/omc -p   # 无 prompt 时读一次 stdin
./dist/omc -p "..." --output-format json | jq -r .result   # 单行 JSON（text | json，默认 text）
./dist/omc --continue       # 恢复当前目录最近会话（-c）
./dist/omc --resume <id>    # 恢复指定会话（-r）
./dist/omc --model <id>     # 指定模型（-m），覆盖配置与 env；id 见 omc models
./dist/omc --permission-mode <mode>  # 本进程默认权限模式（不写配置）：default | acceptEdits
                                     # | bypassPermissions | plan | dontAsk | auto | fullAccess
./dist/omc -y               # 跳过权限确认（--dangerously-skip-permissions；非交互模式本就自动放行）
./dist/omc --help           # 帮助（-h）；--version / -v 打版本号
./dist/omc models           # 表格列出可用模型（ID/名称/上下文/最大输出/thinking 强度/能力/积分）
                              # 能力列的图片模态以 pi-catalog 注册表为准（CLI supportsImages 自报虚标）
./dist/omc plugin list      # 插件管理：list / add / remove / enable / disable / reload
                              # 安装：omc plugin add <本地路径 | github:owner/repo[#ref]>（github 需 --yes）
                              # REPL 内用 /plugin 浮层（列表 + Enter 启停 + r 重载）
                              # omc --help 分节：「子命令」（内置 models/plugin）+「插件子命令」（插件注册的）
                              # omc <子命令> help（或 --help）看该子命令详细帮助，如 omc codebuddy help
```

非 TTY（管道）或带 `-p`/位置参数时走**一次性执行**：跑一轮、只把最终答案打到 stdout（过程走 stderr），
成功退 0 / 失败非 0；权限自动放行。不再进入 readline 行模式（旧行为已移除，管道场景从此不悬挂）。

## 键位

| 键 | 作用 |
|---|---|
| Enter | 发送 |
| Ctrl/Shift+Enter | 换行 |
| ↑ / ↓ | 历史消息浏览 |
| Tab | 斜杠命令补全（单候选直接补全，多候选补公共前缀） |
| Esc | 中断生成 / 取消历史浏览 / 关闭弹窗 |
| Ctrl-V / ⌘V | 粘贴图片（截图等纯图片剪贴板经 pngpaste/osascript 直读；⌘V 经 kitty 键盘协议 super+v 上报触发）；无图时回落贴剪贴板文本（smart paste） |
| ⌘V（Finder 复制文件） | 粘贴图片文件路径（终端落盘路径场景，自动转附件） |
| Ctrl-C | 生成中=中断；空闲=双击退出（单按提示） |
| Ctrl-O | 展开 / 折叠工具卡**与 thinking 全文**（同一个「展开/折叠」手势；只影响当前视口内的块） |
| Ctrl-T | 展开 / 折叠贴底待办行（编辑器正上方的待办清单；无任务时此键不生效） |
| Ctrl-Shift-O | 工具活动区整体显隐（Kitty 需配置放行，见下文「终端配置」） |
| F2 | 打开**会话详情全屏视图**（thinking 全文 + 工具输入/输出，可滚动只读；同 `/detail`） |
| 权限弹窗 | `y` 允许 / `n` 拒绝 / `a` 本会话始终允许 / Esc 拒绝 |

图片：草稿附件在编辑器上方显示缩略图卡片（Kitty 协议终端为真缩略图，其余降级图标）；
消息中的 `🖼 #N` chip 可点击打开（Ghostty ⌘+点击，Kitty Ctrl+Shift+点击）；
滚动查看历史经终端原生 scrollback（消息退休自动提交）。

thinking 注记：展开/折叠**与工具卡共用 `Ctrl-O`**（一次按键同时翻两者，避免多一个键位）。
**刻意不用 `Alt+*` 组合**：macOS 下 Option 被终端当「打字键」，Kitty / Ghostty 实测都发不出
`alt+t`（会打出 `†`）。`Ctrl-O` 只影响**当前视口内**的块（退休进 scrollback 的旧块保持原样，
与工具卡一致）；**读全文（含历史 thinking 与工具输出）按 `F2` 或 `/detail`** 打开全屏详情视图
—— 该视图是 alt-buffer 全屏浮层，**转录区完全不受影响**。视图内滚动支持：
`↑↓` / `PgUp` / `PgDn` / `Home` / `End` / `Shift+↑↓`、**触控板两指滑动与鼠标滚轮**、
**右侧滚动条鼠标点击或拖动**（点哪滚到哪）；`q` / `Esc` 关闭。F 键的选择理由：
终端会把 F 键原样投递，不像 alt 组合会被吞。

⌘V 注记：Ghostty 开箱即用（协议激活时上报按键）；**Kitty 的 ⌘V 是终端原生文本粘贴**
（`paste_from_clipboard` 在 GUI 层消费、不上报应用，纯图片剪贴板发 0 字节），
Kitty 上贴图片用 **Ctrl-V**，⌘V 保持终端原生文本粘贴习惯。

### 终端配置（Kitty 用户需知）

omc 依赖两条 `kitty.conf` 自定义（不改功能会缺失，改了不影响其他程序）：

```conf
# 1) ⌘+点击打开超链接（对齐 Ghostty / 浏览器习惯）
mouse_map cmd+left click ungrabbed mouse_handle_click selection link prompt

# 2) 放行 Ctrl+Shift+O 直达应用
map kitty_mod+o no_op
```

**为什么要改：**

1. **⌘+点击**：omc 消息里的 `🖼 #N` 图片 chip、文件路径等超链接按 Ghostty 习惯用 ⌘+点击打开；
   Kitty 默认打开链接的按键是 `Ctrl+Shift+点击`，没有这条 `mouse_map` 时 ⌘+点击无响应
   （`Ctrl+Shift+点击` 仍可用，两条并存）。
2. **`kitty_mod+o no_op`**：omc 用 `Ctrl+Shift+O` 做「工具活动区整体显隐」（见键位表）；
   Kitty 默认把 `kitty_mod+o`（= Ctrl+Shift+O）绑定到 `pass_selection_to_program`，
   会在 GUI 层把键吃掉，应用永远收不到。`no_op` 解除这个占用，让按键以 CSI-u
   （`\x1b[111;6u`）直达 omc。代价：kitty 的「把选区发给程序」功能失去快捷键
   （该功能小众；如需要可自行另绑其他键）。

### 为什么 omc 不用 `Alt+*` 组合键

`Alt+T`（thinking 全文）曾短暂作为独立键位存在，**已撤销**：alt 组合要求终端把
**Option/Alt 原样上报**，而 macOS 终端的默认行为是「Option 打字」——真机实测
**Kitty 与 Ghostty 都发不出** `alt+t`（都打出 `†`）。因此 omc 的思考全文并入 `Ctrl-O`
（与工具卡同一个展开/折叠手势），不再依赖任何 alt 组合。

- 若确实想让终端上报 Option（例如为了 shell 的 word-wise 移动），Kitty 可加
  `macos_option_as_alt both`，Ghostty 用 `macos-option-as-alt = true`；
  代价是 Option 不能再输入 `†`/`´` 等字符（omc 自身不需要这个设置）。
- 读**历史**（已滚出视口）的 thinking/工具详情走全屏详情视图（`/detail`），
  `Ctrl-O` 只翻转当前视口内的块。

## 斜杠命令

| 命令 | 说明 |
|---|---|
| `/help` | 列出所有命令 |
| `/clear` | 清屏并重置显示（不清 agent 上下文） |
| `/model [id]` | 切换模型（无参打开交互浮层：名称/[id]/(credits)，Global 写用户配置 / Session 仅本会话，Tab 切域） |
| `/mode [mode]` | 查看/切换权限模式（切换清空 always 白名单） |
| `/resume` | 浮层选择并恢复当前目录的历史会话（↑↓+Enter） |
| `/compact` | 压缩对话上下文（CLI 内建） |
| `/detail` | 全屏查看会话详情：thinking 全文 + 工具输入/输出，可滚动只读（同 `F2`） |
| `/cost` | 本会话 token/轮数/费用统计 |
| `/verbose` | 切换工具详情全显 |
| `/plugin` | 插件管理浮层（列表 + Enter 启停 + r 重载；CLI 见 `omc plugin help`） |
| `/exit` `/quit` | 退出 |

## 配置

三级合并（后者覆盖前者）：

1. 用户级 `~/.omc/config.json`（`OMC_CONFIG_DIR` 可覆盖：绝对值作根 / 相对值取 `~/<值>`）
2. 项目级 `<cwd>/.omc/config.json`
3. 环境变量 `OMC_MODEL` / `OMC_PERMISSION_MODE` / `OMC_MAX_TURNS` / `OMC_VERBOSE`

```json
{
  "model": "hy3",
  "permissionMode": "default",
  "maxTurns": 40,
  "verbose": false
}
```

## 自动加载的上下文文件

启动会话时，SDK CLI 子进程自动读取以下文件注入提示词。本项目 `src/` 不参与加载（`settingSources: []`），仅 `src/app/context-data.ts` 为 `/context` 做本地枚举展示。

**指令 / 规则文件**（注入为无 `data-role` 的 `<system-reminder><rules>`，在首条消息 / resume / 压缩后注入；`CODEBUDDY_DISABLE_SYSTEM_REMINDER_MD` 可整体关闭）：

| 层级 | 路径 |
|---|---|
| 用户级 | `~/.codebuddy/CODEBUDDY.md`（或 `.mdc`）→ `~/.codebuddy/rules/` |
| 项目级 | 从 cwd 逐级向上到 `/`，每级取首个命中的 `CODEBUDDY.md` / `CODEBUDDY.mdc` / `AGENTS.md` / `AGENTS.mdc`；每级再试 `<dir>/.codebuddy/` 同名变体 |
| 项目 rules | `<cwd>/.codebuddy/rules/` |
| 项目本地 | `<cwd>/CODEBUDDY.local.md`（或 `.local.mdc`，不入库） |

- **条件规则**：规则文件 frontmatter 的 `paths` glob 在 Read/Edit 触达文件时按需注入（`alwaysApply` 或缺省 globs 为始终注入）。
- **Skills**：不走 system-reminder，而是注入 Skill 工具描述（`<available_skills>`）。来源：`<cwd>/.codebuddy/skills/`、`~/.codebuddy/skills/`、`~/.agent[s]/skills/`、插件 cache、内置；`CODEBUDDY_SESSION_SKILL_DIRS` 可追加。
- **MEMORY.md**（宿主 auto memory）：有独立的 `<system-reminder data-role="memory">` 通道，但 SDK transport 在 spawn CLI 时强制置 `CODEBUDDY_DISABLE_AUTO_MEMORY=1`（`lib/transport/process-transport.js:459`），故本项目下不注入。

**运行期环境变量开关**（env 不受 `settingSources` 影响，且优先于 settings 档）：

| 变量 | 作用 |
|---|---|
| `CODEBUDDY_DISABLE_SYSTEM_REMINDER_MD` | 关闭规则型 system-reminder 注入（`CODEBUDDY.md` / `AGENTS.md` 整族） |
| `CODEBUDDY_DISABLE_AUTO_MEMORY` | 关闭宿主 auto memory（SDK 模式已被 transport 强制置 1） |
| `CODEBUDDY_CODE_DISABLE_AUTO_MEMORY` | agent-memory 层 kill-switch（同上语义） |
| `CODEBUDDY_MEMORY_ENABLED` | 记忆功能总开关 |
| `CODEBUDDY_TYPED_MEMORY_ENABLED` | typed memory（user/feedback/project/reference + frontmatter）开关 |
| `CODEBUDDY_MEMORY_RELEVANCE_DISABLED` | 关闭记忆相关性检索（按 query 检索 topic 文件后注入） |
| `CODEBUDDY_MEMORY_EXTRACTION_DISABLED` | 关闭会话记忆提取 |
| `CODEBUDDY_SESSION_SKILL_DIRS` | 追加会话级 skill 目录 |
| `CODEBUDDY_SMALL_FAST_MODEL` | **场景变体 `lite` 的模型**（Explore 等轻量子任务用）。omc 从 `~/.codebuddy/settings.json#variantModels` 读取并在会话启动时注入；shell 自己 export 时优先（对齐 CLI「env > settings」）。改值需重启 omc 会话 —— 用 `/model:lite <id>` 更省事 |
| `CODEBUDDY_BIG_SLOW_MODEL` | 同上，对应 `reasoning` 变体（`/model:reasoning <id>`）。为什么走 env：omc 的 `settingSources: []` 令 settings 不加载，env 是唯一能穿透该隔离的覆盖层（见 `AGENTS.md` 耦合点表） |
| `OMC_ACCOUNT_FROM_ENV` | **仅账户插件读**（`omc-codebuddy-accounts`，宿主不读）。置真（`1`/`true`/`yes`）时，启动改为**尊重 shell 的 `CODEBUDDY_API_KEY` 命中的账户**，而不是插件记录的「所选账户」（默认「所选优先」）。用于临时试别的账户：`OMC_ACCOUNT_FROM_ENV=1 omc`。停用该插件后此变量无意义（宿主本就原样透传 `CODEBUDDY_API_KEY`） |
| `OMC_TITLE_DISABLE` | `1` 时关闭**自动会话标题**（默认开）。未命名会话在用户消息提交后用旁路 lite 会话生成一条短标题，写 `<sid>.autotitle`（statusline `session_name` 段与 `/resume` 列表自动显示）；`/rename` 的手改标题 `.title` 优先且**永不被覆盖**。诊断口：`OMC_DEBUG_TITLE=<path>`（`1`/`-` 写 stderr）；测试注入：`OMC_TITLE_FAKE` |

> 文件名族（`CODEBUDDY` → 自定义 baseName）、配置目录名（`.codebuddy`）、品牌由 SDK 的 `customization.json`（交付级，非运行期）控制，本项目无此文件 → 用官方默认；`AGENTS.md` / `AGENTS.mdc` 为跨产品兼容名，固定不派生。

## 数据位置

单根 `~/.omc/`（`OMC_CONFIG_DIR` 可覆盖）：

- 配置：`~/.omc/config.json`
- 会话：`~/.omc/projects/<escaped-cwd>/<sessionId>.jsonl`（只记定稿事件；目录名 = cwd 绝对路径 escaped，如 `Users-you-Projects-demo`，碰撞时退避 `-2`/`-3`，目录内 `.cwd` 记原路径）
  - `<sessionId>.title` = `/rename` 手改的标题（用户资产，永不被自动覆盖）
  - `<sessionId>.autotitle` = 自动生成的会话标题（见下「状态栏」的 `session_name` 段）
- 输入历史：`~/.omc/history`
- 用量记账：`~/.omc/usage-daily.jsonl`
- 插件：`~/.omc/plugins/`（安装落点）+ `~/.omc/plugins.json`（注册表：source/enabled/commit）
- 插件私有数据：`~/.omc/plugin-data/<插件名>/`（宿主给定目录，插件自管文件；经 `ctx.paths.dataDir()` 获取）

## herdr 集成

在 [herdr](https://herdr.dev) 面板里跑 omc 时，通过插件 **`omc-herdr`** 自报状态与会话身份 —— herdr 官方推荐的 B 路径，**herdr 侧零安装、零 PR**：

```sh
omc plugin add /path/to/omc-herdr          # 或 omc plugin add github:<owner>/omc-herdr --yes
omc plugin list                            # 确认 omc-herdr「启用·已加载」
```

装好后在 herdr 面板里跑 `omc`，另开终端即可查：

```sh
herdr agent list                  # 应列出 omc
herdr pane get "$HERDR_PANE_ID"   # 看 agent / agent_status
```

| omc 事件 | 上报 | 效果 |
|---|---|---|
| 回合开始 / 结束 | `working` / `idle` | 侧边栏与 `agent list` 状态 |
| 权限弹窗 / 问答 | `blocked`（带文案） | 标记「等你决策」 |
| 会话身份 | `resume_argv = ['omc','--resume',<id>]` | 支持面板内恢复 |
| 进程退出 | `release-agent`（同步 CLI） | 主动清面板 |

- 上报直接打进 `HERDR_SOCKET_PATH` 的 socket（`source` / `agent` 均为 `omc`）；**非 herdr 环境整插件 no-op**（不建连接、不写文件）。
- **重启恢复需 herdr ≥ 0.9.2**：herdr 重启后自动执行 `omc --resume <id>` 续上会话。旧版忽略恢复命令，状态/释放不受影响。
- **`omc` 必须在 PATH 上** —— 恢复命令首词是裸命令名，herdr 按 PATH 查找。
- **嵌套 omc 不上报**（omc 的工具里再起 omc），避免抢面板。

## 状态栏

默认单行：`vim | model | mode | in/out tokens（累计） | ctx 上下文条 | cwd | git branch`（branch 30s 轮询，非 git 目录省略）。

配置见 `~/.omc/config.json` 的 `statusline`（`rows` 最多两行、左右分组、separator/icons/colors）。
`rows` 里的段 = 内置段（`vim`/`model`/`mode`/`tokens`/`token_in`/`token_out`/`ctx`/`cwd`/`git`/`cost`/`turns`/`time`/`hostname`/`session`/`session_name`）
或**插件段** `plugin:<插件自报 id>`（如 `plugin:codebuddy:account`，由账户插件提供，显示当前生效账户；相关环境变量见上表）；未知段只跳过该段并给一行告警，**不影响其它段**。

`statusline` 配置项可自定义：**最多两行、每行分左右两组**、分隔符与颜色可配（重启生效，非法配置回退默认并打 stderr warning）：

```json
{
  "statusline": {
    "separator": "ascii",
    "rows": [
      { "left": ["model", "mode", "ctx"], "right": ["token_in", "token_out"] },
      { "left": ["cwd", "git"], "right": ["turns", "time"] }
    ],
    "colors": { "dim": true, "semantic": true }
  }
}
```

- 可用段（15）：`vim` `model` `mode` `tokens` `token_in` `token_out` `ctx` `cwd` `git` `cost` `turns` `time` `hostname` `session`（UUID 前 8 位，experimental）`session_name`（会话标题：`/rename` 手改 > **自动生成** > 首条 user 消息，无记录时隐藏）
- `cwd`：显示完整路径，home 前缀换 `~`（`~/Projects/oh-my-codebuddy`）；超 40 字符保留首段 + 末两段、中间缩首字母（`/Users/you/Projects/github/very-long-project-name` → `/Users/y/P/github/very-long-project-name`），仍超长则左侧 `…` 截断兜底
- 分隔符（8）：`pipe`（默认 ` | `）`slash` `dot`（` · `，omp sep.dot 同款）`powerline` `powerline-thin` `block` `none` `ascii`（powerline 系需 Nerd Font）
- `colors.dim`：整行 DIM（默认 true）；`colors.semantic`：ctx 段接近上限变色（默认 true）；`colors.segments`：每段独立语义色（默认 false，开启后与 dim 互斥）——omp dark 主题色板：model 粉 / cwd 青 / git 绿 / token_in 青 / out+cost 粉 / session_name 橙 / vim 按模式绿橙黄 / ctx 按用量石板蓝→黄→红 / 分隔符灰
- `icons`：段前图标（默认 false）——omp unicode preset 字形零字体依赖：model `⬢` / cwd `📁` / git `⑂` / tokens `🪙` / in `⤵` / out `⤴` / ctx `◫` / cost `💲` / turns `↻` / time `⏱` / hostname `🖥` / session `🆔` / session_name `✎`（vim/mode 无图标，omp 语义）
- 某行所有段都隐藏时该行整行不显示

## 项目结构

```
src/
  main.ts            入口：TTY REPL（pi-tui 装配）/ 一次性执行（-p、位置参数或无 TTY）
  agent/             SDK 会话、normalize（SDK Message → UIEvent）、UIEvent 类型
  ui/                pi-tui 层：app（Composer 装配）、bridge（UIEvent → chat 组件树）、
                     paste（图片粘贴）、permission-overlay、history-storage
  permission/        权限桥（弹窗决策）
  session-store/     会话持久化（JSONL）
  config/            三级配置合并
  app/               终端能力：clipboard（剪贴板图片）、osc5522、statusline
scripts/             PTY 冒烟（smoke-pty / smoke-perm-pty / smoke-image-pty / smoke-compile-pty）
```

## 开发

```sh
bun run dev          # 启动
bun test             # 单元测试
bunx tsc --noEmit    # 类型检查（node_modules 内 pi-tui src 报错为已知 lib target 噪音，非门禁）
bun run build        # 编译（dist/omc + pi_natives .node）
scripts/smoke-pty.sh          # PTY 冒烟（另见 smoke-perm/image/compile-pty.sh）
```

实施计划与阶段记录：`docs/plan/`。

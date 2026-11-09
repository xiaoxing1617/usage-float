# Usage Float · AI 用量浮窗

**简体中文** · [English](README.en.md) · [繁體中文](README.zh-Hant.md)

一个常驻在 Mac 桌面上的小浮窗，帮你随时看到 **Claude** 和 **GPT（Codex）** 的用量：还剩多少额度、什么时候重置、会员等级、按时间段统计的用量，以及折合多少钱（美元 / 人民币 / 日元 / 新币 / 欧元）。

> [!IMPORTANT]
> **只支持 macOS**（macOS 11 Big Sur 或更新，Apple 芯片和 Intel 都可以）。不支持 Windows、Linux、iPhone、iPad。

<p align="center">
  <img src="docs/panel.jpg" width="340" alt="面板">
  &nbsp;&nbsp;
  <img src="docs/ball.jpg" width="120" alt="悬浮球">
</p>

<sub>截图里是演示数据。</sub>

## 功能

- **剩余额度**：Claude 和 GPT 的 5 小时额度、每周额度，剩余百分比和重置倒计时。
- **会员等级**：Pro / Max / Plus 等。
- **用量统计**：今天、昨天、本周、上周、本月、上月、近 7 天、近 30 天、自定义日期；按模型、按天分别统计。
- **费用估算（可选）**：打开“自动获取模型价格”后，每 12 小时从 [LiteLLM 价格表](https://github.com/BerriAI/litellm) 更新一次价格。每次价格变化都会记录下来，每条用量按**当时的价格**计算（比如某模型昨天 $5、今天 $3，会分开算）。不打开就不显示费用。
- **货币换算**：美元、人民币、日元、新加坡元、欧元，汇率来自欧洲央行（[Frankfurter](https://frankfurter.dev)）。
- **悬浮球**：缩小成一个圆球，左边 Claude、右边 GPT；外圈是 5 小时额度，内圈是周额度。点一下展开，按住可拖动。
- **出口 IP**：显示网站看到的公网出口 IP，以及国家和省 / 州（跟随界面语言）。
- **IP 信任评分和延迟**：在 Claude、GPT 名称后面显示 🛡 评分（0–100，颜色从红到绿）和延迟毫秒数。点评分打开完整检测页，点毫秒数查看延迟是怎么测的。
- **三种语言**：简体中文、繁體中文、English。首次打开时按系统语言自动选择，其他语言默认用英文；可以在设置里改。
- 浅色 / 深色模式自动跟随系统；可设置“始终置顶”。

## 设备和系统要求

| 项目 | 要求 |
| --- | --- |
| 电脑 | Mac（Apple 芯片 M1 及以后，或 Intel） |
| 系统 | macOS 11 Big Sur 或更新 |
| 用量数据 | 这台 Mac 上用过 [Claude Code](https://docs.claude.com/en/docs/claude-code)（命令行 / IDE 插件）和 / 或 [Codex](https://github.com/openai/codex)。浮窗读取它们留在本机的记录 |
| 从源码安装时 | Xcode 命令行工具、Rust 1.77.2+、Node.js 20.19+ 或 22.12+；约 3 GB 磁盘空间，首次编译约 5–15 分钟 |

> [!NOTE]
> 只统计 **Claude Code** 和 **Codex** 产生的用量。claude.ai 网页、Claude 桌面版、ChatGPT 网页 / App 的对话不会写到本机记录里，所以不计入统计（但它们和 Claude Code 共用同一份额度，额度百分比是准的）。

## 安装

### 方法一：一句话让 AI 帮你装（推荐）

如果你的 Mac 上已经装了 **Claude Code** 或 **Codex**，打开终端运行 `claude` 或 `codex`，把下面这段话发给它：

```text
请帮我在这台 Mac 上安装 Usage Float：https://github.com/xiaoxing1617/usage-float
步骤：先确认这是 macOS 11 或更新的系统（不是 Mac 就停止并告诉我）；缺什么就装什么：Xcode 命令行工具、Rust（用 rustup 官方安装）、Node.js 22 LTS；把仓库克隆到 ~/usage-float，运行 npm install 和 npm run tauri build -- --bundles app；把 src-tauri/target/release/bundle/macos/Usage Float.app 复制到 /Applications 并打开。除此之外不要修改我电脑上的其他东西，每一步遇到问题先告诉我。
```

装好后菜单栏会出现浮窗图标。

### 方法二：自己从源码编译

1. 安装 Xcode 命令行工具：

   ```bash
   xcode-select --install
   ```

2. 安装 Rust：

   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```

3. 安装 Node.js 22 LTS（从 [nodejs.org](https://nodejs.org) 下载，或用 Homebrew：`brew install node@22`）。

4. 下载并编译：

   ```bash
   git clone https://github.com/xiaoxing1617/usage-float.git
   cd usage-float
   npm install
   npm run tauri build -- --bundles app
   ```

5. 把编译好的 app 放进“应用程序”并打开：

   ```bash
   cp -R "src-tauri/target/release/bundle/macos/Usage Float.app" /Applications/
   open "/Applications/Usage Float.app"
   ```

### 方法三：下载安装包

如果 [Releases](https://github.com/xiaoxing1617/usage-float/releases) 页面有 `.dmg`，下载后把 app 拖进“应用程序”。

这个 app 没有 Apple 开发者签名，第一次打开时 macOS 会拦截。处理方法：在 Finder 里**右键点 app → 打开 → 打开**；如果没有“打开”按钮，去“系统设置 → 隐私与安全性”，往下找到它点“仍要打开”。

## 使用

- **显示 / 隐藏**：点菜单栏的图标。app 不在程序坞里显示。
- **移动**：按住标题栏拖动；悬浮球直接按住拖动。
- **左上角红点**：隐藏浮窗（从菜单栏图标重新打开）。
- **右上角**：`↻ 刷新`、`⚙ 设置`、`● 悬浮球`。
- **开机自动启动**：“系统设置 → 通用 → 登录项”里添加 Usage Float。

### 让 Claude 额度显示出来（重要）

GPT 的额度会直接从 Codex 记录里读到。**Claude 的额度需要接入 Claude Code 的状态栏**：

1. 打开浮窗 **设置 → Claude Code 状态栏（推荐）→ 连接 Claude Code 状态栏**。浮窗会在 `~/.claude/settings.json` 里设置一个状态栏脚本（会先备份原文件，之前的状态栏会照常显示）。
2. 在终端里用一次 Claude Code（运行 `claude` 并发一条消息）。
3. 浮窗就会显示“来自 Claude Code 状态栏”的 5 小时和每周额度。之后每次在终端或 IDE 里用 Claude Code 都会自动更新。

> Claude 桌面版和网页版不会触发状态栏，只有命令行 / IDE 版的 Claude Code 会。
> 设置里还有一个可选的“Claude 剩余额度（非官方）”开关，会从钥匙串读取登录信息去调用非官方接口，经常被限流，一般不需要打开。

断开：设置里点“断开”，会把 `settings.json` 恢复成原来的样子。

### 费用和价格

设置里打开 **自动获取模型价格** 后才会显示费用。费用是按 API 公开价格估算的“等值金额”，**不是你实际被扣的钱**（订阅用户按月付费）。价格表里没有的模型会按同系列模型估算，早于第一次价格记录的用量会用最早的价格补算，这两种情况都用 `*` 标出。

## 隐私

**你的用量记录、会话内容、账号和密钥都只在本机读取，不会上传到任何地方。**

浮窗只会联网访问下面这些地址，都可以在设置里关闭（汇率除外）：

| 用途 | 访问的地址 | 发送的内容 |
| --- | --- | --- |
| 模型价格（可关） | raw.githubusercontent.com（LiteLLM 价格表） | 无 |
| 汇率 | api.frankfurter.dev | 无 |
| 出口 IP 和位置（可关） | Cloudflare `cdn-cgi/trace`、api.ipify.org、ipwho.is | 你的公网 IP（对方本来就能看到） |
| 信任评分和延迟（可关） | claude.ai、chatgpt.com 的 `cdn-cgi/trace`，ip.net.coffee | 你的公网 IP |
| Claude 额度接口（默认关） | api.anthropic.com | Claude Code 的登录令牌，只发给 Anthropic 官方 |

会写入的本机文件：

- `~/.claude/settings.json`（只在你点“连接状态栏”时修改，修改前备份为 `settings.json.usage-float.bak`）
- `~/.claude/usage-float/`（状态栏脚本和最新额度数据）
- `~/Library/Application Support/com.usagefloat.app/`（价格历史、缓存）

## 卸载

1. 如果连接过状态栏，先在设置里点 **断开**。
2. 退出 app（菜单栏图标 → Quit），删除 `/Applications/Usage Float.app`。
3. 可选：删除 `~/.claude/usage-float/` 和 `~/Library/Application Support/com.usagefloat.app/`。

## 开发

```bash
npm install
npm run tauri dev      # 运行 app（开发模式）
npm run dev            # 只在浏览器里看界面，使用演示数据
npm run tauri build    # 打包 .app / .dmg
cd src-tauri && cargo test
```

技术栈：Tauri 2 · Rust · React · TypeScript。

## 声明

本项目是个人开源项目，与 Anthropic、OpenAI、ip.net.coffee 没有任何关联。额度、价格、评分都来自公开或非官方的数据源，仅供参考。

---
name: catchtail-interactive
description: 当用户说“启动 CatchTail 控制台并启动交互式工作流”、“启动交互式工作流”，或要求 Codex 通过 CatchTail 继续长时间会话时使用。
---

# CatchTail 交互式工作流

当用户要求启动 CatchTail 时，先启动本地控制台服务，再进入 CatchTail interactive mode。interactive mode 已启动后，继续使用此 skill 处理队列消息。

协议：
- CatchTail CLI 来自本插件目录，不来自用户目标项目。运行命令时使用相对本 `SKILL.md` 的 `../../bin/catchtail.js`，或使用 hook 注入上下文里给出的完整 `node .../catchtail.js` 命令；不要运行目标项目里的 `./bin/catchtail.js`。
- 首次启动时，在当前目标项目作为工作目录后台启动 CatchTail CLI 的 `serve 0`，为当前 Codex session 启动独立 sidecar。保持该进程运行，捕获输出里的 `CatchTail Console: http://127.0.0.1:<port>` 地址后继续当前回合；不要假设固定端口，不要以前台常驻命令阻塞后续流程。
- 启动控制台后，触发或发送“启动交互式工作流”，让 UserPromptSubmit hook 打开 interactive mode。
- 运行状态按 Codex hook 的 session_id 隔离；手动 CLI 默认使用 default session。
- queue.json 只保存当前未领取的队列消息。
- session.jsonl 保存追加式完整历史。
- 处理用户输入时，先运行 CatchTail CLI 的 `claim` 领取一条消息；处理后运行 CatchTail CLI 的 `complete <id> <简短处理结果>`。
- claim 到消息后，必须严格按这个格式打印：先打印 `**处理队列消息：**`，空一行后打印 `---`，再空一行打印正文；正文后打印 `附件路径：`，有附件时每行 `- <绝对路径>`，没有附件时打印 `无`；再打印 `上下文提示：`，有 refs 时逐行列出，没有时打印 `无`；最后空一行打印 `---`。不要把附件标题缩写成“附件：”，不要省略标题，不要用 fenced code block 或 blockquote 包裹正文。
- complete 后如果 milestone 仍未 completed，立即运行 CatchTail CLI 的 `wait`，保持当前回合继续等待。
- wait 运行期间不要在聊天里发送心跳式空闲更新；保持工具等待，只有收到消息、停止、超时或错误需要处理时再说话。
- 消息里的文件是用户提供的本地路径；只有需要时再读取。
- 只有 milestone completed 才自然停止。
- 空闲时使用本地 wait 或 Stop hook 的长轮询；不要在聊天里高频轮询。
- 继续遵守 Codex 对文件编辑、shell、MCP 工具和权限审批的安全边界。

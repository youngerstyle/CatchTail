---
name: catchtail-interactive
description: 当用户说“启动交互式工作流”，或要求 Codex 通过 CatchTail 继续长时间会话时使用。
---

# CatchTail 交互式工作流

当 CatchTail interactive mode 已启动时使用此 skill。

协议：
- 运行状态按 Codex hook 的 `session_id` 隔离；手动 CLI 默认使用 `default` session。
- `queue.json` 只保存当前未领取的队列消息。
- `session.jsonl` 保存追加式完整历史。
- 处理用户输入时，先运行 `node {{CLI_PATH}} claim` 领取一条消息；处理后运行 `node {{CLI_PATH}} complete <id> <简短处理结果>`。
- claim 到消息后，先在当前 Codex 对话里用粗体格式打印 `处理队列消息：<正文>`，并列出附件路径，方便后续浏览 session 历史。
- complete 后如果 milestone 仍未 completed，立即运行 `node {{CLI_PATH}} wait`，保持当前回合继续等待。
- 消息里的文件是用户提供的本地路径；只有需要时再读取。
- 只有 milestone completed 才自然停止。
- 空闲时使用本地 wait 或 Stop hook 的长轮询；不要在聊天里高频轮询。
- 继续遵守 Codex 对文件编辑、shell、MCP 工具和权限审批的安全边界。

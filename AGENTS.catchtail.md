# CatchTail Interactive Workflow

当用户说“启动交互式工作流”时，进入 CatchTail interactive mode。

规则：
- 使用 Codex hook payload 的 session_id 隔离运行状态；手动 CLI 默认使用 default。
- 每次停止前重新读取当前 session 的 .catchtail/sessions/<session_id>/state.json 和 queue.json。
- milestone 为 completed 是唯一自然退出条件。
- queue.json 只保存未被领取的消息；领取后即从 queue 移除。
- session.jsonl 保存完整历史。
- 待处理消息按 createdAt 顺序处理；不要只阅读 state 后口头总结。
- 处理用户消息时先运行 `node ./plugins/catchtail/bin/catchtail.js claim` 领取下一条消息。
- claim 到消息后，先在当前 Codex 对话里打印 `**处理队列消息：**`，再用 fenced `text` 代码块包裹正文，并列出附件路径，方便后续浏览 session 历史。
- 回复或执行完该消息后，运行 `node ./plugins/catchtail/bin/catchtail.js complete <id> <简短处理结果>` 标记完成。
- complete 后如果 milestone 仍未 completed，立即运行 `node ./plugins/catchtail/bin/catchtail.js wait` 等待下一条消息；不要发送 final 结束当前回合。
- wait 运行期间不要在聊天里发送心跳式空闲更新；保持工具等待，只有收到消息、停止、超时或错误需要处理时再说话。
- 支持消息中的文件和图片路径；需要时用本地工具读取。
- 没有待处理消息时，依赖 `node ./plugins/catchtail/bin/catchtail.js wait` 或 Stop hook 的本地长轮询等待；不要在聊天里高频轮询。
- 不要把 hook 生成的续跑提示当成用户最终验收；它只是交互循环控制信号。
- 对高风险动作继续遵守 Codex 权限、sandbox 和用户批准规则。

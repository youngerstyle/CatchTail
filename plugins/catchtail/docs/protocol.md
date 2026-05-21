# CatchTail 协议

CatchTail 把 Codex 主循环当作黑盒，只在 Codex 暴露的生命周期点上增加交互能力。核心协议刻意保持轻量：一个队列，加一份会话历史。

## 状态模型

运行时数据按 Codex `session_id` 隔离：

```text
.catchtail/sessions/<session_id>/
├── state.json
├── queue.json
└── session.jsonl
```

`session_id` 来自 Codex hook payload。如果 payload 没有 session id，就使用 `default`。

`state.json` 保存压缩后的 workflow 状态：

```json
{
  "interactive": {
    "enabled": true,
    "milestone": "incomplete",
    "startedAt": "2026-05-15T00:00:00.000Z",
    "lastTurnId": "..."
  }
}
```

`milestone: "completed"` 是交互工作流唯一的自然退出条件。

## 队列和历史

`queue.json` 保存当前尚未领取的队列消息：

```json
{
  "sessionId": "codex-session-id",
  "updatedAt": "2026-05-15T00:00:00.000Z",
  "items": [
    {
      "id": "...",
      "kind": "message",
      "body": "继续处理下一步",
      "files": [],
      "refs": [],
      "createdAt": "2026-05-15T00:00:00.000Z"
    }
  ]
}
```

`claim` 会从 `queue.json` 中领取并移除第一条消息。`session.jsonl` 记录重要事件：用户消息、领取、完成、milestone 变化、启动提示和 Stop hook 回合。

消息类型：

- `message`：用户的对话反馈。
- `task`：在下一个 Codex 边界执行的工作。
- `question`：对 Codex 问题的澄清或回答。

每条消息可以包含 `files`，即本地文档、图片或其它 artifact 的路径。消息也可以包含 `refs`，用于提供轻量上下文提示，例如 `{ "type": "skill", "value": "..." }`、`{ "type": "plugin", "value": "..." }` 或 `{ "type": "path", "value": "..." }`。

这些 refs 只是 Codex 风格的注意力路由提示：它们不是附件，不授予权限，也不会自动安装或激活 skill/plugin。agent 仍然必须遵守正常的 Codex skill/plugin 加载规则和权限边界。

网页控制台会把上传附件保存到：

```text
.catchtail/uploads/<session_id>/
```

图片预览和系统默认文件打开都通过受限的本地 API 提供，只接受 `.catchtail/uploads/` 里面的路径。文本草稿按 Codex session 保存到浏览器 localStorage；附件草稿会从已上传的文件路径恢复。

第三方工具应该调用队列 API，而不是自动化网页控制台：

```text
GET  /api/queue?sessionId=<id>
POST /api/queue?sessionId=<id>
POST /api/queue/claim?sessionId=<id>
POST /api/queue/cancel?sessionId=<id>
POST /api/queue/complete?sessionId=<id>
```

队列接口包含 CORS headers。文件预览和文件打开 API 仍然是本地 sidecar 能力，不是公开集成面。

队列接口必须在 query string 中提供 `sessionId`。缺失时 API 返回 `400`，避免第三方工具猜错 Codex session。

## Hook 映射

核心工作流只需要两个 hook：

```text
UserPromptSubmit   启动模式并注入协议上下文
Stop               在 milestone completed 之前保持循环
```

CatchTail 的轻量核心不会安装 `PreToolUse`、`PermissionRequest` 或 `PostToolUse`。权限决策仍然由 Codex 原生机制处理。

## 空闲等待

当 `Stop` 触发且没有待处理消息时，hook 不应该要求模型轮询。它应该长轮询本地 sidecar：

```text
GET /api/wait?timeoutMs=540000
```

当用户消息或 milestone 更新到达时，sidecar 会结束等待。如果等待超时或 sidecar 不可用，hook 会返回兜底续跑提示。

## Agent 处理契约

当续跑提示报告有待处理输入时，agent 应该按创建顺序处理：

```powershell
<catchtail-cli> claim
<catchtail-cli> complete <id> <简短结果>
<catchtail-cli> wait
```

agent 应该在 hook 边界重新读取 state 和 queue，不要把 hook 生成的续跑提示当作用户最终验收。它只是循环控制信号。完成一条消息后，如果 milestone 仍未 completed，agent 应该立即进入本地 wait，保持当前回合继续等待。

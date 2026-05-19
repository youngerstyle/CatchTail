---
name: catchtail-interactive
description: 当用户说“启动交互式工作流”，或要求 Codex 通过 CatchTail 继续长时间会话时使用。
---

# CatchTail 交互式工作流

Use this skill when CatchTail interactive mode is already initialized in the
current project.

If the current project has not been initialized yet, ask the user to complete
the installation step first. Installation is a precondition, not a runtime
CatchTail skill.

Protocol:

- Runtime state is scoped by Codex `session_id`.
- `queue.json` contains only unclaimed user input.
- `session.jsonl` contains append-only history.
- Follow the CatchTail managed block in the target project's `AGENTS.md` for the
  exact project-local CLI path.
- When handling user input, claim one queued message before acting on it.
- After claiming a message, print `**处理队列消息：**`, then print the message
  body inside a fenced `text` code block, then list attachment paths and context
  refs before handling it.
- After handling the message, mark it complete with a short result.
- If the milestone is still incomplete after completion, immediately wait again
  instead of sending a final response.
- While waiting, do not post heartbeat-style idle updates in chat. Keep the wait
  tool running and speak only when a message, stop signal, timeout, or error
  needs attention.
- Only `milestone: completed` is the natural workflow exit condition.
- Continue to obey Codex file-editing, shell, sandbox, and approval rules.

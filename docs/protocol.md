# CatchTail Protocol

CatchTail treats the Codex loop as a black box and adds an interaction aspect at
the lifecycle points Codex exposes. The supported core is intentionally
lightweight: queue plus session history.

## State Model

Runtime data is scoped by Codex `session_id`:

```text
.catchtail/sessions/<session_id>/
├── state.json
├── queue.json
└── session.jsonl
```

`session_id` comes from the Codex hook payload. If no session id exists, use
`default`.

`state.json` is the compact workflow state:

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

`milestone: "completed"` is the only natural exit condition for the interactive
workflow.

## Queue And History

`queue.json` is the compact current queue. It contains only unclaimed input:

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
      "createdAt": "2026-05-15T00:00:00.000Z"
    }
  ]
}
```

`claim` removes the first item from `queue.json`. `session.jsonl` receives all
important events: user messages, claims, completions, milestone changes, prompt
activation, and Stop-hook turns.

Message kinds:

- `message`: conversational user feedback.
- `task`: work to execute on the next available Codex boundary.
- `question`: clarification or answer to a Codex question.

Each message can include `files`, which are local paths to documents, images, or
other artifacts the agent may inspect.

The web console saves uploaded attachments under:

```text
.catchtail/uploads/<session_id>/
```

Image previews and system-default file opening are served through restricted
local APIs that only accept paths inside `.catchtail/uploads/`. Text drafts are
stored in browser localStorage per Codex session; attachment drafts are restored
from uploaded file paths.

Third-party tools should use the queue API instead of automating the console UI:

```text
GET  /api/queue?sessionId=<id>
POST /api/queue?sessionId=<id>
POST /api/queue/claim?sessionId=<id>
POST /api/queue/cancel?sessionId=<id>
POST /api/queue/complete?sessionId=<id>
```

These queue endpoints include CORS headers. File preview/open APIs remain local
sidecar capabilities and are not the public integration surface.
`sessionId` is required in the query string for queue endpoints. The API returns
`400` when it is omitted, so third-party tools never guess the wrong Codex
session.

## Hook Mapping

Only two hooks are required for the core workflow:

```text
UserPromptSubmit   activate mode and inject protocol context
Stop               keep the loop alive until milestone is completed
```

CatchTail does not install `PreToolUse`, `PermissionRequest`, or `PostToolUse`
in the lightweight core. Permission decisions remain Codex-native.

## Idle Waiting

When `Stop` fires and there is no queued message, the hook should not ask the
model to poll. It should long-poll the local sidecar instead:

```text
GET /api/wait?timeoutMs=540000
```

The sidecar resolves the wait when a user message or milestone update arrives.
If the wait times out or the sidecar is unavailable, the hook returns a fallback
continuation prompt.

## Agent Processing Contract

When a continuation prompt reports pending input, the agent should process it in
created order:

```powershell
<catchtail-cli> claim
<catchtail-cli> complete <id> <short-result>
<catchtail-cli> wait
```

The agent should re-read state and queue at hook boundaries and should not treat
the hook-generated continuation prompt as final user acceptance. It is only the
loop-control signal. After completing a message, if the milestone is still
incomplete, the agent should immediately enter local wait again and keep the
current turn alive.

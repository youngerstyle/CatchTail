# CatchTail Plugin

This directory is the marketplace-style mirror of the root CatchTail plugin.
The repository root is also a complete plugin project with its own
`.codex-plugin/plugin.json`.

CatchTail is a Codex hook sidecar for long-running interactive sessions. It uses
only `UserPromptSubmit` and `Stop`, plus a local queue and session history.
The included web console supports rich text drafts, uploaded attachments, image
preview, and opening uploaded files with the system default application.

## Install Into A Project

Copy this plugin directory to the target project as:

```text
plugins/catchtail/
```

Then run from the target project root:

```powershell
node .\plugins\catchtail\scripts\install.mjs
node .\plugins\catchtail\bin\catchtail.js serve
```

If you install it as an npm package or unpacked tarball under
`node_modules/catchtail`, run:

```powershell
node .\node_modules\catchtail\scripts\install.mjs
node .\node_modules\catchtail\bin\catchtail.js serve
```

In Codex, trust the project hooks if prompted, then say:

```text
启动交互式工作流
```

Open the console at:

```text
http://127.0.0.1:3787
```

## Runtime Model

Runtime data is stored in:

```text
.catchtail/sessions/<session_id>/state.json
.catchtail/sessions/<session_id>/queue.json
.catchtail/sessions/<session_id>/session.jsonl
```

`queue.json` contains only unclaimed input. `session.jsonl` keeps the durable
history.

Uploaded files are copied to:

```text
.catchtail/uploads/<session_id>/
```

The console stores the current text draft in browser localStorage per session.
Attachment drafts are restored from the uploaded file paths.

Third-party tools can integrate without driving the browser UI through:

```text
GET  /api/queue?sessionId=<id>
POST /api/queue?sessionId=<id>
POST /api/queue/claim?sessionId=<id>
POST /api/queue/cancel?sessionId=<id>
POST /api/queue/complete?sessionId=<id>
```

Only these queue endpoints expose CORS headers by default.
Pass `?sessionId=<id>` for a specific Codex session. The queue API requires it
and returns `400` when it is omitted.

In the live workflow the agent should process `claim -> complete -> wait`.
`wait` keeps the current agent turn alive; the `Stop` hook is only a fallback
boundary.

## AGENTS.md

The installer updates `AGENTS.md` by default with a managed block:

```text
<!-- CatchTail:START -->
...
<!-- CatchTail:END -->
```

The uninstall helper prints removal instructions. It can remove only that block
when explicitly called with `--remove-agents-block`.

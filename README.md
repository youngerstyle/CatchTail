# CatchTail

CatchTail keeps a long-running Codex session interactive after the normal chat
turn would otherwise end. It adds a small local sidecar with a queue, session
history, file uploads, and a browser console, while leaving Codex itself
untouched.

Use it when you want to keep giving feedback to an agent that is still working:
send a message, attach an image or document, cancel queued input, or stop the
workflow from the local console.

## What You Get

- Codex hooks for `UserPromptSubmit` and `Stop`.
- A local console at `http://127.0.0.1:3787`.
- Queue + session history scoped by Codex `session_id`.
- Rich text drafts, image previews, file uploads, and system-default file open.
- Third-party queue API for companion tools or browser extensions.
- Project installer that writes the hook config, skill, and `AGENTS.md` block.

## Install

Clone or install this plugin, then run the installer against your target
project:

```powershell
node .\scripts\install.mjs C:\path\to\your-project
```

Start the local console from the plugin directory:

```powershell
node .\bin\catchtail.js serve
```

If CatchTail is installed under `node_modules/catchtail`, use:

```powershell
node .\node_modules\catchtail\scripts\install.mjs
node .\node_modules\catchtail\bin\catchtail.js serve
```

Then open:

```text
http://127.0.0.1:3787
```

In Codex, trust the project hooks if prompted, then say:

```text
启动交互式工作流
```

## How It Works

CatchTail stores runtime data inside the target project:

```text
.catchtail/sessions/<session_id>/state.json
.catchtail/sessions/<session_id>/queue.json
.catchtail/sessions/<session_id>/session.jsonl
.catchtail/uploads/<session_id>/
```

The queue only contains unclaimed input. Once Codex claims a message, it is
removed from `queue.json` and recorded in `session.jsonl`.

The normal agent loop is:

```text
claim -> handle -> complete -> wait
```

The `Stop` hook is a safety boundary that keeps the session alive while the
milestone is incomplete.

## Queue API

Third-party tools can talk to CatchTail without automating the browser UI:

```text
GET  /api/queue?sessionId=<id>
POST /api/queue?sessionId=<id>
POST /api/queue/claim?sessionId=<id>
POST /api/queue/cancel?sessionId=<id>
POST /api/queue/complete?sessionId=<id>
```

`sessionId` is required. Queue endpoints include CORS headers. File preview and
file-open endpoints stay local to the sidecar and only accept paths inside
`.catchtail/uploads/`.

## Project Files

```text
.codex-plugin/plugin.json        Plugin manifest
hooks.json                       Hook declaration
skills/catchtail-interactive/    Codex skill instructions
scripts/install.mjs              Project installer
scripts/uninstall.mjs            Managed-block cleanup helper
bin/catchtail.js                 CLI entrypoint
src/                             Runtime, hook, CLI, and console
docs/protocol.md                 Protocol details
```

## Uninstall

Remove the generated hook files from the target project, or run:

```powershell
node .\scripts\uninstall.mjs C:\path\to\your-project --remove-agents-block
```

## Limits

- CatchTail is a sidecar, not a Codex core-loop patch.
- Codex still controls permissions, sandboxing, and tool approval.
- If the environment cannot run hooks at all, CatchTail cannot re-enter Codex.

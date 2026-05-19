# CatchTail

CatchTail lets you keep talking to a long-running Codex session while the agent
is still working.

It does not patch Codex. It adds a local sidecar: a queue, session history,
file uploads, a browser console, and a small hook protocol that keeps the loop
alive until you explicitly stop it.

## Quickstart

Give Codex a tail:

```powershell
git clone https://github.com/youngerstyle/CatchTail.git
cd C:\path\to\your-project
node C:\path\to\CatchTail\scripts\install.mjs .
node C:\path\to\CatchTail\bin\catchtail.js serve
```

Open the console:

```text
http://127.0.0.1:3787
```

Start Codex in your project, trust the hooks if prompted, then say:

```text
启动交互式工作流
```

## How It Works

CatchTail treats the Codex agent loop as a black box and adds an interaction
surface around it.

When you start the workflow, CatchTail enables a session-scoped queue. While
Codex is working, you can use the local console to send feedback, upload files,
preview images, cancel queued messages, or stop the queue. The agent claims one
message at a time, handles it, marks it complete, and waits for the next one.

The core loop is:

```text
claim -> handle -> complete -> wait
```

The `Stop` hook is the fallback boundary. If the queue is still active, it keeps
Codex in the loop instead of treating the turn as done.

## Installation

### Codex App / Codex CLI

Until CatchTail is listed in a public plugin marketplace, install it from this
repository:

```powershell
git clone https://github.com/youngerstyle/CatchTail.git
cd C:\path\to\your-project
node C:\path\to\CatchTail\scripts\install.mjs .
node C:\path\to\CatchTail\bin\catchtail.js serve
```

The installer writes:

```text
.codex/hooks.json
.agents/skills/catchtail-interactive/SKILL.md
AGENTS.catchtail.md
AGENTS.md managed block
```

If CatchTail is installed under `node_modules/catchtail`, run from the target
project root:

```powershell
node .\node_modules\catchtail\scripts\install.mjs .
node .\node_modules\catchtail\bin\catchtail.js serve
```

## The Basic Workflow

1. Start CatchTail's console with `serve`.
2. Tell Codex `启动交互式工作流`.
3. Send follow-up messages or attachments in the console.
4. Codex claims queued input, handles it, completes it, and waits again.
5. Click the stop control in the console when you want the workflow to end.

## What's Inside

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

Runtime data is written to the target project:

```text
.catchtail/sessions/<session_id>/state.json
.catchtail/sessions/<session_id>/queue.json
.catchtail/sessions/<session_id>/session.jsonl
.catchtail/uploads/<session_id>/
```

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

## Updating

Pull the latest plugin code, then rerun the installer in any target project
where you want the managed hook and skill files refreshed:

```powershell
cd C:\path\to\CatchTail
git pull
node .\scripts\install.mjs C:\path\to\your-project
```

## Uninstall

Run:

```powershell
node C:\path\to\CatchTail\scripts\uninstall.mjs C:\path\to\your-project --remove-agents-block
```

## Limits

- CatchTail is a sidecar, not a Codex core-loop patch.
- Codex still controls permissions, sandboxing, and tool approval.
- If the environment cannot run hooks at all, CatchTail cannot re-enter Codex.

## License

MIT

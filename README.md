# CatchTail

CatchTail lets you keep talking to a long-running Codex session while the agent
is still working.

It does not patch Codex. It adds a local sidecar: a queue, session history,
file uploads, a browser console, and a small hook protocol that keeps the loop
alive until you explicitly stop it.

## Quickstart

1. Open the target project or folder in Codex.
2. Tell Codex:

   ```text
   安装并初始化 https://github.com/youngerstyle/CatchTail
   ```

3. If Codex asks whether to trust the installed hooks, review the hook command
   and choose trust. CatchTail uses Codex hooks to keep the session alive, and
   that trust step is intentionally controlled by Codex.

4. Open the local console:

   ```text
   http://127.0.0.1:3787
   ```

5. Start the workflow:

   ```text
   启动交互式工作流
   ```

After that, send follow-up messages, files, or stop requests through the local
console while Codex keeps working.

## How It Works

CatchTail treats the Codex agent loop as a black box and adds an interaction
surface around it.

Installation is a one-time project setup step, not a CatchTail runtime skill.
When you ask Codex to install and initialize the GitHub repository, it fetches
this project, runs `scripts/install.mjs` against the current target project, and
starts the local console. The installer writes the project hook config, a
project-local runtime skill, and a managed `AGENTS.md` block.

The core loop is:

```text
claim -> handle -> complete -> wait
```

The `Stop` hook is the fallback boundary. If the queue is still active, it keeps
Codex in the loop instead of treating the turn as done.

## Installation

### Codex App / Codex CLI

Open the target project or folder in Codex, then tell Codex:

```text
安装并初始化 https://github.com/youngerstyle/CatchTail
```

This tells Codex both where CatchTail is and which open project should receive
the CatchTail hook/runtime setup. No CatchTail skill is required before this
step; installation is the precondition for the runtime workflow.

Codex should clone or update CatchTail in a durable local location, such as
`~/.codex/catchtail`, before running the installer. Do not use a temporary
directory: the generated hooks reference the local CatchTail checkout.

The installer will set up the project hooks and start the local console. If
Codex prompts you to trust hooks, approve it after reviewing the command.
CatchTail cannot safely bypass that prompt because it is part of Codex's hook
security model.

### Manual Development Install

Use this when your Codex environment cannot install plugins directly from a
GitHub repository URL, or when developing CatchTail itself:

```powershell
git clone https://github.com/youngerstyle/CatchTail.git $env:USERPROFILE\.codex\catchtail
cd C:\path\to\your-project
node $env:USERPROFILE\.codex\catchtail\scripts\install.mjs .
node $env:USERPROFILE\.codex\catchtail\bin\catchtail.js serve
```

## The Basic Workflow

1. Open the target project or folder in Codex.
2. Ask Codex `安装并初始化 https://github.com/youngerstyle/CatchTail`.
3. Tell Codex `启动交互式工作流`.
4. Use the console to send follow-up messages or attachments.
5. Codex claims queued input, handles it, completes it, and waits again.
6. Stop the queue from the console when you want the workflow to end.

## What's Inside

```text
.codex-plugin/plugin.json        Plugin manifest
hooks.json                       Hook declaration
skills/catchtail-interactive/    Runtime workflow skill
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

Update CatchTail through your Codex plugin UI when installed from the GitHub
repository URL. For manual development installs, pull the latest plugin code and
rerun the installer:

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

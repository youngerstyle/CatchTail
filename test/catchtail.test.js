import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "../src/cli.js";
import { runHook } from "../src/hook.js";
import { createServer } from "../src/server.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function tempProject(name) {
  return mkdtempSync(join(tmpdir(), `catchtail-${name}-`));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
}

test("installer preserves existing hooks, replaces stale CatchTail hook, and tolerates BOM", () => {
  const project = tempProject("install");
  mkdirSync(join(project, ".codex"), { recursive: true });
  writeFileSync(
    join(project, ".codex", "hooks.json"),
    `\uFEFF${JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: "node other-user-prompt.js", timeout: 12 }] },
          { hooks: [{ type: "command", command: "node old/catchtail-hook.js", timeout: 1 }] }
        ],
        Stop: [{ hooks: [{ type: "command", command: "node other-stop.js", timeout: 34 }] }],
        PostToolUse: [{ hooks: [{ type: "command", command: "node keep-post.js" }] }]
      }
    })}`
  );

  const result = spawnSync(process.execPath, [join(ROOT, "scripts", "install.mjs"), project], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);

  const { hooks } = readJson(join(project, ".codex", "hooks.json"));
  const serialized = JSON.stringify(hooks);
  assert.match(serialized, /other-user-prompt\.js/);
  assert.match(serialized, /other-stop\.js/);
  assert.match(serialized, /keep-post\.js/);
  assert.doesNotMatch(serialized, /old\/catchtail-hook\.js/);
  assert.equal(serialized.match(/catchtail-hook\.js/g)?.length, 2);
});

test("plugin manifest has marketplace-facing assets and policy links", () => {
  const manifest = readJson(join(ROOT, ".codex-plugin", "plugin.json"));
  assert.equal(manifest.interface.composerIcon, "./assets/catchtail-small.svg");
  assert.equal(manifest.interface.logo, "./assets/catchtail-app.svg");
  assert.deepEqual(manifest.interface.screenshots, []);
  assert.match(manifest.interface.privacyPolicyURL, /PRIVACY\.md$/);
  assert.match(manifest.interface.termsOfServiceURL, /TERMS\.md$/);
});

test("CLI init accepts an explicit target path and preserves existing hooks", async () => {
  const project = tempProject("cli");
  await mkdir(join(project, ".codex"), { recursive: true });
  writeFileSync(
    join(project, ".codex", "hooks.json"),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node keep-stop.js" }] }] } })
  );

  const result = await runCli(["init", project], { root: tempProject("wrong-root") });
  assert.equal(result.exitCode, 0, result.stderr);

  const { hooks } = readJson(join(project, ".codex", "hooks.json"));
  const serialized = JSON.stringify(hooks);
  assert.match(serialized, /keep-stop\.js/);
  assert.match(serialized, /catchtail-hook\.js/);
});

test("UserPromptSubmit enables interactive mode and returns CatchTail context", async () => {
  const project = tempProject("hook");
  const payload = {
    hook_event_name: "UserPromptSubmit",
    session_id: "session-a",
    turn_id: "turn-a",
    prompt: "启动交互式工作流"
  };

  const result = await runHook({ root: project, stdin: JSON.stringify(payload) });
  assert.equal(result.exitCode, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(output.hookSpecificOutput.additionalContext, /claim/);

  const state = readJson(join(project, ".catchtail", "sessions", "session-a", "state.json"));
  assert.equal(state.interactive.enabled, true);
  assert.equal(state.interactive.milestone, "incomplete");
});

test("server queue API can enqueue, claim, and complete a message", async () => {
  const project = tempProject("server");
  mkdirSync(join(project, ".agents", "skills", "demo-skill"), { recursive: true });
  writeFileSync(join(project, ".agents", "skills", "demo-skill", "SKILL.md"), "---\nname: demo-skill\ndescription: Demo skill\n---\n");
  mkdirSync(join(project, ".codex", "plugins", "cache", "local", "demo-plugin", "1.0.0", ".codex-plugin"), { recursive: true });
  writeFileSync(join(project, ".codex", "plugins", "cache", "local", "demo-plugin", "1.0.0", ".codex-plugin", "plugin.json"), JSON.stringify({
    name: "demo-plugin",
    interface: { displayName: "Demo Plugin", shortDescription: "Demo plugin" }
  }));
  const server = createServer({ root: project });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const refs = await fetch(`${base}/api/refs`).then((response) => response.json());
    assert.equal(refs.skills.some((ref) => ref.value === "demo-skill"), true);
    assert.equal(refs.plugins.some((ref) => ref.value === "demo-plugin"), true);

    const enqueue = await fetch(`${base}/api/queue?sessionId=session-b`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "hello",
        kind: "message",
        files: [],
        refs: [{ type: "skill", value: "catchtail-interactive" }]
      })
    }).then((response) => response.json());
    assert.equal(enqueue.ok, true);

    const claim = await fetch(`${base}/api/queue/claim?sessionId=session-b`, {
      method: "POST"
    }).then((response) => response.json());
    assert.equal(claim.item.id, enqueue.id);
    assert.equal(claim.item.body, "hello");
    assert.deepEqual(claim.item.refs, [{ type: "skill", value: "catchtail-interactive" }]);

    const complete = await fetch(`${base}/api/queue/complete?sessionId=session-b`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: enqueue.id, response: "done" })
    }).then((response) => response.json());
    assert.equal(complete.ok, true);
  } finally {
    server.close();
    await rm(project, { recursive: true, force: true });
  }
});

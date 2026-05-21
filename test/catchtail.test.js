import { once } from "node:events";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "../plugins/catchtail/src/cli.js";
import { runHook } from "../plugins/catchtail/src/hook.js";
import { createServer } from "../plugins/catchtail/src/server.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(REPO_ROOT, "plugins", "catchtail");

function tempProject(name) {
  return mkdtempSync(join(tmpdir(), `catchtail-${name}-`));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
}

function copyPluginFixture(target) {
  for (const entry of [
    "bin",
    "hooks",
    "scripts",
    "src",
    "templates",
    "package.json"
  ]) {
    cpSync(join(ROOT, entry), join(target, entry), { recursive: true });
  }
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
  const pkg = readJson(join(ROOT, "package.json"));
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.interface.composerIcon, "./assets/catchtail-small.svg");
  assert.equal(manifest.interface.logo, "./assets/catchtail-app.svg");
  assert.deepEqual(manifest.interface.screenshots, []);
  assert.match(manifest.interface.privacyPolicyURL, /PRIVACY\.md$/);
  assert.match(manifest.interface.termsOfServiceURL, /TERMS\.md$/);
  assert.equal(manifest.interface.defaultPrompt[0], "启动交互式工作流");
});

test("published package includes the repo marketplace entry", () => {
  const pkg = readJson(join(REPO_ROOT, "package.json"));
  assert.equal(pkg.files.includes(".agents/"), true);
  assert.equal(pkg.files.includes("plugins/"), true);
  const marketplace = readJson(join(REPO_ROOT, ".agents", "plugins", "marketplace.json"));
  const entry = marketplace.plugins[0];
  assert.equal(entry.name, "catchtail");
  assert.equal(entry.source.source, "local");
  assert.equal(entry.source.path, "./plugins/catchtail");
  assert.equal(entry.policy.installation, "AVAILABLE");
  assert.equal(entry.policy.authentication, "ON_INSTALL");
  assert.equal(entry.category, "Productivity");

  const sourceRoot = resolve(REPO_ROOT, entry.source.path);
  const sourceManifest = readJson(join(sourceRoot, ".codex-plugin", "plugin.json"));
  assert.equal(sourceManifest.name, entry.name);
  assert.equal(Object.hasOwn(sourceManifest, "skills"), false);
});

test("installer quotes generated CLI commands when plugin path contains spaces", () => {
  const base = tempProject("plugin path with spaces");
  const pluginRoot = join(base, "plugin with spaces");
  const project = join(base, "target project");
  mkdirSync(pluginRoot, { recursive: true });
  mkdirSync(project, { recursive: true });
  copyPluginFixture(pluginRoot);

  const result = spawnSync(process.execPath, [join(pluginRoot, "scripts", "install.mjs"), project], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);

  const agents = readFileSync(join(project, "AGENTS.md"), "utf8");
  const statusCommand = agents.match(/`(node\s+"[^`]+catchtail\.js"\s+)claim`/)?.[1] + "status";
  assert.match(statusCommand, /^node\s+"[^"]+plugin with spaces[^"]+catchtail\.js"\s+status$/);

  const status = spawnSync(statusCommand, { cwd: project, encoding: "utf8", shell: true });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /"state":/);
  assert.match(status.stdout, /"queue": \[\]/);
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

  const agents = readFileSync(join(project, "AGENTS.md"), "utf8");
  const skill = readFileSync(join(project, ".agents", "skills", "catchtail-interactive", "SKILL.md"), "utf8");
  assert.match(agents, /启动交互式工作流/);
  assert.match(agents, /不要用 fenced code block/);
  assert.match(agents, /处理队列消息/);
  assert.match(agents, /附件路径：/);
  assert.match(agents, /上下文提示：/);
  assert.match(skill, /启动交互式工作流/);
  assert.match(skill, /不要用 fenced code block/);
  assert.match(skill, /附件路径：/);
  assert.match(skill, /上下文提示：/);
});

test("CLI serve refreshes stale project protocol files", async () => {
  const project = tempProject("serve-sync");
  await mkdir(join(project, ".codex"), { recursive: true });
  writeFileSync(
    join(project, "AGENTS.md"),
    [
      "<!-- CatchTail:START -->",
      "# CatchTail Interactive Workflow",
      "- claim 到消息后，先在当前 Codex 对话里打印 `**处理队列消息：**`，再用 fenced `text` 代码块包裹正文。",
      "<!-- CatchTail:END -->"
    ].join("\n")
  );

  const result = await runCli(["serve", "0"], { root: project, stayOpen: false });
  assert.equal(result.exitCode, 0, result.stderr);

  const agents = readFileSync(join(project, "AGENTS.md"), "utf8");
  const skill = readFileSync(join(project, ".agents", "skills", "catchtail-interactive", "SKILL.md"), "utf8");
  assert.doesNotMatch(agents, /再用 fenced `text` 代码块包裹正文/);
  assert.match(agents, /不要用 fenced code block/);
  assert.match(skill, /不要用 fenced code block/);
  assert.match(agents, /附件路径：/);
  assert.match(skill, /附件路径：/);
});

test("uninstall accepts remove flag before the project path", () => {
  const project = tempProject("uninstall");
  writeFileSync(
    join(project, "AGENTS.md"),
    [
      "before",
      "<!-- CatchTail:START -->",
      "managed",
      "<!-- CatchTail:END -->",
      "after"
    ].join("\n") + "\n"
  );

  const result = spawnSync(process.execPath, [
    join(ROOT, "scripts", "uninstall.mjs"),
    "--remove-agents-block",
    project
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const agents = readFileSync(join(project, "AGENTS.md"), "utf8");
  assert.doesNotMatch(agents, /CatchTail:START/);
  assert.match(agents, /before/);
  assert.match(agents, /after/);
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

test("UserPromptSubmit accepts the CatchTail nickname start prompt", async () => {
  const project = tempProject("hook-alias");
  const payload = {
    hook_event_name: "UserPromptSubmit",
    session_id: "session-alias",
    turn_id: "turn-alias",
    prompt: "\u542f\u52a8 \u5c0f\u5c3e\u5df4"
  };

  const result = await runHook({ root: project, stdin: JSON.stringify(payload) });
  assert.equal(result.exitCode, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");

  const state = readJson(join(project, ".catchtail", "sessions", "session-alias", "state.json"));
  assert.equal(state.interactive.enabled, true);
  assert.equal(state.interactive.milestone, "incomplete");
});

test("server queue API can enqueue, claim, and complete a message", async () => {
  const project = tempProject("server");
  mkdirSync(join(project, ".agents", "skills", "demo-skill"), { recursive: true });
  writeFileSync(
    join(project, ".agents", "skills", "demo-skill", "SKILL.md"),
    "---\nname: demo-skill\ndescription: Demo skill with \"quoted\" trigger text\n---\n"
  );
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
    assert.equal(
      refs.skills.find((ref) => ref.value === "demo-skill")?.detail,
      'Demo skill with "quoted" trigger text'
    );
    assert.equal(refs.plugins.some((ref) => ref.value === "demo-plugin"), true);

    const html = await fetch(base).then((response) => response.text());
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    assert.match(html, /data-ref-type/);
    assert.match(html, /data-ref-value/);
    assert.match(script, /dataset\.refType/);
    assert.match(script, /editorPromptText/);
    assert.match(script, /\[\$'/);
    assert.match(html, /data-queue-expand/);
    assert.match(html, /queue-summary-item/);
    assert.match(html, /queue-details/);
    assert.match(script, /data-queue-edit/);
    assert.match(script, /queue-detail-body/);
    assert.match(script, /editQueueItem/);
    assert.match(script, /saveQueueEdit/);
    assert.match(script, /\/api\/queue\/update/);
    assert.match(script, /\/api\/queue\/editing/);
    assert.match(script, /editablePlainText/);
    assert.match(script, /tag === 'BR'/);
    assert.match(script, /syncQueueExpandButtons/);
    assert.doesNotThrow(() => new vm.Script(script));

    const enqueue = await fetch(`${base}/api/queue?sessionId=session-b`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "hello",
        kind: "message",
        files: [],
        refs: [
          { type: "skill", value: "catchtail-interactive" },
          { type: "skill", value: "catchtail-interactive" },
          { type: "plugin", value: "browser" },
          { type: "plugin", value: "browser" }
        ]
      })
    }).then((response) => response.json());
    assert.equal(enqueue.ok, true);

    const claim = await fetch(`${base}/api/queue/claim?sessionId=session-b`, {
      method: "POST"
    }).then((response) => response.json());
    assert.equal(claim.item.id, enqueue.id);
    assert.match(claim.item.body, /^\[\$catchtail-interactive\]\(catchtail-interactive\) \[\$Browser\]\(.+plugin\.json\) hello$/);
    assert.equal(claim.item.refs[0].type, "skill");
    assert.equal(claim.item.refs[0].value, "catchtail-interactive");
    assert.equal(claim.item.refs[1].type, "plugin");
    assert.equal(claim.item.refs[1].value, "browser");
    assert.equal(claim.item.refs[1].label, "Browser");
    assert.match(claim.item.refs[1].source, /plugin\.json$/);

    const complete = await fetch(`${base}/api/queue/complete?sessionId=session-b`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: enqueue.id, response: "done" })
    }).then((response) => response.json());
    assert.equal(complete.ok, true);

    const oldMentionEnqueue = await fetch(`${base}/api/queue?sessionId=session-c`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "[$Demo Plugin](demo-plugin) already mentioned",
        kind: "message",
        files: [],
        refs: [{ type: "plugin", value: "demo-plugin" }]
      })
    }).then((response) => response.json());
    assert.equal(oldMentionEnqueue.ok, true);

    const oldMentionClaim = await fetch(`${base}/api/queue/claim?sessionId=session-c`, {
      method: "POST"
    }).then((response) => response.json());
    assert.equal(oldMentionClaim.item.id, oldMentionEnqueue.id);
    assert.equal(oldMentionClaim.item.body, "[$Demo Plugin](demo-plugin) already mentioned");

    const first = await fetch(`${base}/api/queue?sessionId=session-edit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "first draft", kind: "message", files: [], refs: [] })
    }).then((response) => response.json());
    const second = await fetch(`${base}/api/queue?sessionId=session-edit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "second draft", kind: "message", files: [], refs: [] })
    }).then((response) => response.json());

    const update = await fetch(`${base}/api/queue/update?sessionId=session-edit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: first.id, body: "first edited", files: [], refs: [] })
    }).then((response) => response.json());
    assert.equal(update.ok, true);
    assert.equal(update.item.id, first.id);
    assert.equal(update.item.body, "first edited");

    const editedQueue = await fetch(`${base}/api/queue?sessionId=session-edit`).then((response) => response.json());
    assert.deepEqual(editedQueue.items.map((item) => item.id), [first.id, second.id]);
    assert.deepEqual(editedQueue.items.map((item) => item.body), ["first edited", "second draft"]);

    const lockedFirst = await fetch(`${base}/api/queue?sessionId=session-edit-lock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "locked first", kind: "message", files: [], refs: [] })
    }).then((response) => response.json());
    const lockedSecond = await fetch(`${base}/api/queue?sessionId=session-edit-lock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "second waits", kind: "message", files: [], refs: [] })
    }).then((response) => response.json());
    const lock = await fetch(`${base}/api/queue/editing?sessionId=session-edit-lock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: lockedFirst.id, editing: true })
    }).then((response) => response.json());
    assert.equal(lock.ok, true);

    const lockedClaim = await fetch(`${base}/api/queue/claim?sessionId=session-edit-lock`, {
      method: "POST"
    }).then((response) => response.json());
    assert.equal(lockedClaim.item, null);
    const lockedQueue = await fetch(`${base}/api/queue?sessionId=session-edit-lock`).then((response) => response.json());
    assert.deepEqual(lockedQueue.items.map((item) => item.id), [lockedFirst.id, lockedSecond.id]);

    const unlock = await fetch(`${base}/api/queue/editing?sessionId=session-edit-lock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: lockedFirst.id, editing: false })
    }).then((response) => response.json());
    assert.equal(unlock.ok, true);
    const unlockedClaim = await fetch(`${base}/api/queue/claim?sessionId=session-edit-lock`, {
      method: "POST"
    }).then((response) => response.json());
    assert.equal(unlockedClaim.item.id, lockedFirst.id);
  } finally {
    server.close();
    await rm(project, { recursive: true, force: true });
  }
});

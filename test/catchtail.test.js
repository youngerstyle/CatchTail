import { once } from "node:events";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
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

async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error("Timed out waiting for condition");
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
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.interface.composerIcon, "./assets/catchtail-small.svg");
  assert.equal(manifest.interface.logo, "./assets/catchtail-app.svg");
  assert.deepEqual(manifest.interface.screenshots, []);
  assert.match(manifest.interface.privacyPolicyURL, /PRIVACY\.md$/);
  assert.match(manifest.interface.termsOfServiceURL, /TERMS\.md$/);
  assert.equal(manifest.interface.defaultPrompt[0], "启动 CatchTail 控制台并启动交互式工作流");
  assert.equal(manifest.interface.defaultPrompt[1], "启动交互式工作流");
});

test("published package includes the repo marketplace entry", () => {
  const pkg = readJson(join(REPO_ROOT, "package.json"));
  assert.equal(pkg.files.includes(".agents/"), true);
  assert.equal(pkg.files.includes("plugins/"), true);
  const marketplace = readJson(join(REPO_ROOT, ".agents", "plugins", "marketplace.json"));
  assert.equal(marketplace.name, "catchtail");
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
  assert.equal(sourceManifest.skills, "./skills/");

  const bundledSkill = readFileSync(join(sourceRoot, "skills", "catchtail-interactive", "SKILL.md"), "utf8");
  assert.match(bundledSkill, /\.\.\/\.\.\/bin\/catchtail\.js/);
  assert.match(bundledSkill, /后台启动/);
  assert.match(bundledSkill, /不要以前台常驻命令阻塞后续流程/);
  assert.match(bundledSkill, /--session <id>/);
  assert.doesNotMatch(bundledSkill, /node "\.\/bin\/catchtail\.js"/);

  const maintenanceSkill = readFileSync(join(sourceRoot, "skills", "catchtail-maintenance", "SKILL.md"), "utf8");
  assert.match(maintenanceSkill, /更新 CatchTail 插件/);
  assert.match(maintenanceSkill, /插件 cache/);
  assert.match(maintenanceSkill, /last_revision/);
  assert.match(maintenanceSkill, /不能报告“已更新成功”/);
  assert.match(maintenanceSkill, /只保留当前启用的 CatchTail 版本/);
  assert.match(maintenanceSkill, /旧版本 cache 已清理/);
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
  const statusCommand = agents.match(/`(node\s+"[^`]+catchtail\.js"\s+)claim`/)?.[1] + "--session quoted-session status";
  assert.match(statusCommand, /^node\s+"[^"]+plugin with spaces[^"]+catchtail\.js"\s+--session quoted-session status$/);

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

test("CLI serve does not write project-level install artifacts", async () => {
  const project = tempProject("serve-no-install");
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

  const result = await runCli(["--session", "session-serve", "serve", "0"], { root: project, stayOpen: false });
  assert.equal(result.exitCode, 0, result.stderr);

  const agents = readFileSync(join(project, "AGENTS.md"), "utf8");
  assert.match(agents, /再用 fenced `text` 代码块包裹正文/);
  assert.equal(existsSync(join(project, ".agents")), false);
  assert.equal(existsSync(join(project, "AGENTS.catchtail.md")), false);
  assert.equal(existsSync(join(project, ".catchtail", "sessions")), true);
  const state = readJson(join(project, ".catchtail", "sessions", "session-serve", "state.json"));
  assert.match(state.sidecar.consoleUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(state.sidecar.waitUrl, `${state.sidecar.consoleUrl}/api/wait`);

  assert.equal(existsSync(join(project, ".codex", "hooks.json")), false);
});

test("CLI serve records independent sidecars per session", async () => {
  const project = tempProject("serve-sessions");

  const first = await runCli(["--session", "session-one", "serve", "0"], { root: project, stayOpen: false });
  assert.equal(first.exitCode, 0, first.stderr);
  const second = await runCli(["--session", "session-two", "serve", "0"], { root: project, stayOpen: false });
  assert.equal(second.exitCode, 0, second.stderr);

  const one = readJson(join(project, ".catchtail", "sessions", "session-one", "state.json"));
  const two = readJson(join(project, ".catchtail", "sessions", "session-two", "state.json"));
  assert.match(one.sidecar.consoleUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(two.sidecar.consoleUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(one.sidecar.waitUrl, `${one.sidecar.consoleUrl}/api/wait`);
  assert.equal(two.sidecar.waitUrl, `${two.sidecar.consoleUrl}/api/wait`);
});

test("CLI serve exits when the session milestone is completed", async () => {
  const project = tempProject("serve-completed");
  const running = runCli(["--session", "session-done", "serve", "0"], {
    root: project,
    stayOpen: true,
    env: { CATCHTAIL_SIDECAR_IDLE_MS: "60000" }
  });

  const statePath = join(project, ".catchtail", "sessions", "session-done", "state.json");
  const state = await waitFor(() => existsSync(statePath) && readJson(statePath).sidecar);
  await fetch(`${state.consoleUrl}/api/milestone?sessionId=session-done`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ milestone: "completed" })
  });

  const result = await running;
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /completed/);
  assert.equal(readJson(statePath).sidecar, null);
});

test("CLI serve ignores completed milestones for other sessions", async () => {
  const project = tempProject("serve-other-session-completed");
  const running = runCli(["--session", "session-stays-open", "serve", "0"], {
    root: project,
    stayOpen: true,
    env: { CATCHTAIL_SIDECAR_IDLE_MS: "60000" }
  });

  const statePath = join(project, ".catchtail", "sessions", "session-stays-open", "state.json");
  const state = await waitFor(() => existsSync(statePath) && readJson(statePath).sidecar);
  await fetch(`${state.consoleUrl}/api/milestone?sessionId=other-session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ milestone: "completed" })
  });

  await sleep(100);
  assert.notEqual(readJson(statePath).sidecar, null);

  await fetch(`${state.consoleUrl}/api/milestone?sessionId=session-stays-open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ milestone: "completed" })
  });
  const result = await running;
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /completed/);
});

test("CLI serve exits after the sidecar idle timeout", async () => {
  const project = tempProject("serve-idle-timeout");
  const result = await runCli(["--session", "session-idle", "serve", "0"], {
    root: project,
    stayOpen: true,
    env: { CATCHTAIL_SIDECAR_IDLE_MS: "1000" }
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /idle-timeout/);
  const state = readJson(join(project, ".catchtail", "sessions", "session-idle", "state.json"));
  assert.equal(state.sidecar, null);
});

test("CLI wait fails when no sidecar is registered for the session", async () => {
  const project = tempProject("wait-no-sidecar");

  const result = await runCli(["--session", "session-without-sidecar", "wait", "1"], {
    root: project,
    fetchImpl: async () => {
      throw new Error("wait must not call a fallback URL");
    }
  });

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /No CatchTail sidecar is registered/);
  assert.match(result.stderr, /--session session-without-sidecar serve 0/);
});

test("CLI serve refuses to fall back to default when session is unavailable", async () => {
  const project = tempProject("serve-missing-session");

  const result = await runCli(["serve", "0"], {
    root: project,
    stayOpen: false
  });
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /without a Codex session id/);
  assert.match(result.stderr, /Refusing to fall back to `default`/);
  assert.equal(existsSync(join(project, ".catchtail", "sessions", "default")), false);
});

test("CLI explicit session is required for session-scoped commands", async () => {
  const project = tempProject("serve-explicit-session");

  const result = await runCli(["--session", "explicit-session", "serve", "0"], {
    root: project,
    stayOpen: false
  });
  assert.equal(result.exitCode, 0, result.stderr);

  assert.equal(existsSync(join(project, ".catchtail", "sessions", "explicit-session", "state.json")), true);
  assert.equal(existsSync(join(project, ".catchtail", "sessions", "default")), false);
});

test("CLI rejects --session without a value", async () => {
  const project = tempProject("serve-missing-session-value");

  const result = await runCli(["--session"], {
    root: project,
    stayOpen: false,
    env: {}
  });
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /Missing value for --session/);
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

test("uninstall purge removes CatchTail project artifacts and preserves unrelated hooks", () => {
  const project = tempProject("uninstall-purge");
  mkdirSync(join(project, ".codex"), { recursive: true });
  mkdirSync(join(project, ".agents", "skills", "catchtail-interactive"), { recursive: true });
  mkdirSync(join(project, ".catchtail", "sessions", "default"), { recursive: true });
  writeFileSync(
    join(project, ".codex", "hooks.json"),
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: "node keep-user-prompt.js", timeout: 12 }] },
          { hooks: [{ type: "command", command: "node old/catchtail-hook.js", timeout: 1 }] }
        ],
        Stop: [{ hooks: [{ type: "command", command: "node old/catchtail-hook.js", timeout: 1 }] }],
        PostToolUse: [{ hooks: [{ type: "command", command: "node keep-post.js" }] }]
      }
    })
  );
  writeFileSync(join(project, ".agents", "skills", "catchtail-interactive", "SKILL.md"), "managed\n");
  writeFileSync(join(project, ".catchtail", "sessions", "default", "state.json"), "{}\n");
  writeFileSync(join(project, "AGENTS.catchtail.md"), "managed\n");
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
    "--purge",
    project
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const hooks = readJson(join(project, ".codex", "hooks.json")).hooks;
  const serialized = JSON.stringify(hooks);
  assert.match(serialized, /keep-user-prompt\.js/);
  assert.match(serialized, /keep-post\.js/);
  assert.doesNotMatch(serialized, /catchtail-hook\.js/);
  assert.equal(existsSync(join(project, ".agents", "skills", "catchtail-interactive")), false);
  assert.equal(existsSync(join(project, ".catchtail")), false);
  assert.equal(existsSync(join(project, "AGENTS.catchtail.md")), false);

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
  assert.match(output.hookSpecificOutput.additionalContext, /--session "session-a"/);
  assert.match(output.hookSpecificOutput.additionalContext, /serve 0/);
  assert.match(output.hookSpecificOutput.additionalContext, /background/);

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

test("hook refuses to fall back to default when session is unavailable", async () => {
  const project = tempProject("hook-missing-session");
  const payload = {
    hook_event_name: "UserPromptSubmit",
    prompt: "鍚姩浜や簰寮忓伐浣滄祦"
  };

  const result = await runHook({ root: project, stdin: JSON.stringify(payload), env: {} });
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /missing session_id/);
  assert.match(result.stderr, /Refusing to use default/);
  assert.equal(existsSync(join(project, ".catchtail", "sessions", "default")), false);
});

test("hook refuses env-only sessions without payload session_id", async () => {
  const project = tempProject("hook-env-only-session");
  const payload = {
    hook_event_name: "UserPromptSubmit",
    prompt: "鍚姩浜や簰寮忓伐浣滄祦"
  };

  const result = await runHook({
    root: project,
    stdin: JSON.stringify(payload),
    env: { CODEX_THREAD_ID: "thread-from-env" }
  });
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /missing session_id/);
  assert.equal(existsSync(join(project, ".catchtail", "sessions", "thread-from-env")), false);
  assert.equal(existsSync(join(project, ".catchtail", "sessions", "default")), false);
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
    });
    assert.equal(enqueue.headers.has("access-control-allow-origin"), false);
    const enqueueBody = await enqueue.json();
    assert.equal(enqueueBody.ok, true);

    const claim = await fetch(`${base}/api/queue/claim?sessionId=session-b`, {
      method: "POST"
    }).then((response) => response.json());
    assert.equal(claim.item.id, enqueueBody.id);
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
      body: JSON.stringify({ id: enqueueBody.id, response: "done" })
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

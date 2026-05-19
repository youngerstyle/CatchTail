import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.js";

test("init writes Codex hook config and AGENTS protocol", async () => {
  const root = mkdtempSync(join(tmpdir(), "catchtail-cli-"));

  const result = await runCli(["init"], { root });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /CatchTail initialized/);
  assert.match(readFileSync(join(root, ".codex", "hooks.json"), "utf8"), /catchtail-hook/);
  const agents = readFileSync(join(root, "AGENTS.catchtail.md"), "utf8");
  assert.match(agents, /启动交互式工作流/);
  assert.match(agents, /catchtail\.js claim/);
  assert.match(agents, /catchtail\.js complete/);
  assert.match(agents, /catchtail\.js wait/);
  const activeAgents = readFileSync(join(root, "AGENTS.md"), "utf8");
  assert.match(activeAgents, /CatchTail:START/);
  assert.match(activeAgents, /不要发送 final/);
  assert.match(
    readFileSync(join(root, ".agents", "skills", "catchtail-interactive", "SKILL.md"), "utf8"),
    /保持当前回合继续等待/
  );
});

test("claim and complete process queued messages", async () => {
  const root = mkdtempSync(join(tmpdir(), "catchtail-cli-"));
  await runCli(["--session", "cli-session", "message", "没有回复呢？"], { root });

  const claimed = await runCli(["--session", "cli-session", "claim"], { root });
  const message = JSON.parse(claimed.stdout);

  assert.equal(message.body, "没有回复呢？");

  const completed = await runCli(["--session", "cli-session", "complete", message.id, "已处理"], {
    root
  });
  assert.equal(completed.exitCode, 0);

  const state = JSON.parse((await runCli(["--session", "cli-session", "status"], { root })).stdout);
  assert.deepEqual(state.queue, []);

  const defaultState = JSON.parse((await runCli(["status"], { root })).stdout);
  assert.equal(defaultState.queue.length, 0);
});

test("wait command calls the sidecar with selected session id", async () => {
  const result = await runCli(["--session", "cli-session", "wait", "123"], {
    fetchImpl: async (url) => {
      assert.equal(url.searchParams.get("sessionId"), "cli-session");
      assert.equal(url.searchParams.get("timeoutMs"), "123");
      return new Response(JSON.stringify({ ok: true, reason: "message" }), { status: 200 });
    }
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, reason: "message" });
});

test("wait command returns immediately when queue already has work", async () => {
  const root = mkdtempSync(join(tmpdir(), "catchtail-cli-"));
  const queued = await runCli(["--session", "cli-session", "message", "already queued"], { root });
  const id = queued.stdout.match(/Queued message (.+)/)?.[1].trim();

  const result = await runCli(["--session", "cli-session", "wait", "123"], {
    root,
    fetchImpl: async () => {
      throw new Error("fetch should not be called when queue is nonempty");
    }
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    reason: "queued",
    id,
    sessionId: "cli-session"
  });
});

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runHook } from "../src/hook.js";
import { CatchTailRuntime } from "../src/core.js";

test("runHook parses stdin JSON and returns Codex hook JSON", async () => {
  const root = mkdtempSync(join(tmpdir(), "catchtail-hook-"));

  const output = await runHook({
    root,
    stdin: JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      turn_id: "turn-1",
      prompt: "启动交互式工作流"
    })
  });

  assert.equal(output.exitCode, 0);
  assert.match(output.stdout, /CatchTail interactive mode is active/);
  assert.equal(output.stderr, "");
});

test("runHook reports invalid JSON as a blocking hook failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "catchtail-hook-"));

  const output = await runHook({
    root,
    stdin: "{not-json"
  });

  assert.equal(output.exitCode, 2);
  assert.match(output.stderr, /Invalid Codex hook payload/);
});

test("Stop hook waits for local activity before producing continuation", async () => {
  const root = mkdtempSync(join(tmpdir(), "catchtail-hook-"));
  const rt = new CatchTailRuntime({ root, sessionId: "hook-session" });
  rt.enableInteractive("turn-1");

  const output = await runHook({
    root,
    stdin: JSON.stringify({
      hook_event_name: "Stop",
      session_id: "hook-session",
      turn_id: "turn-2",
      stop_hook_active: false
    }),
    env: { CATCHTAIL_STOP_WAIT_MS: "100" },
    waitForActivity: async ({ sessionId }) => {
      assert.equal(sessionId, "hook-session");
      rt.addUserMessage({ body: "长连接唤醒", kind: "message" });
      return { ok: true, reason: "message" };
    }
  });

  assert.equal(output.exitCode, 0);
  assert.match(output.stdout, /长连接唤醒/);
});

test("hook runtime uses Codex session_id for isolation", async () => {
  const root = mkdtempSync(join(tmpdir(), "catchtail-hook-"));

  await runHook({
    root,
    stdin: JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "codex-session-1",
      turn_id: "turn-1",
      prompt: "启动交互式工作流"
    })
  });

  const rt = new CatchTailRuntime({ root, sessionId: "codex-session-1" });
  assert.equal(rt.getState().interactive.enabled, true);
});

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CatchTailRuntime } from "../src/core.js";

function runtime(options = {}) {
  return new CatchTailRuntime({
    root: mkdtempSync(join(tmpdir(), "catchtail-test-")),
    ...options
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readJsonl(path) {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("runtime isolates queue and history by Codex session id", () => {
  const root = mkdtempSync(join(tmpdir(), "catchtail-test-"));
  const a = new CatchTailRuntime({ root, sessionId: "session-a" });
  const b = new CatchTailRuntime({ root, sessionId: "session-b" });

  a.enqueueMessage({ body: "A", kind: "message" });
  b.enqueueMessage({ body: "B", kind: "message" });

  assert.equal(readJson(a.queuePath).items[0].body, "A");
  assert.equal(readJson(b.queuePath).items[0].body, "B");
  assert.match(a.sessionDir, /session-a/);
  assert.match(b.sessionDir, /session-b/);
});

test("claim removes from queue and appends to session history", () => {
  const rt = runtime();
  const first = rt.enqueueMessage({ body: "first", kind: "message" });
  const second = rt.enqueueMessage({ body: "second", kind: "message" });

  const claimed = rt.claimNextMessage();

  assert.equal(claimed.id, first);
  assert.deepEqual(
    readJson(rt.queuePath).items.map((item) => item.id),
    [second]
  );
  assert.deepEqual(
    readJsonl(rt.sessionLogPath).map((entry) => entry.type),
    ["message", "message", "claim"]
  );
});

test("cancel removes a queued message and appends history", () => {
  const rt = runtime();
  const first = rt.enqueueMessage({ body: "keep", kind: "message" });
  const second = rt.enqueueMessage({ body: "cancel me", kind: "message" });

  const cancelled = rt.cancelMessage(second, "user cancelled");

  assert.equal(cancelled.id, second);
  assert.deepEqual(
    readJson(rt.queuePath).items.map((item) => item.id),
    [first]
  );
  const last = readJsonl(rt.sessionLogPath).at(-1);
  assert.equal(last.type, "cancel");
  assert.equal(last.messageId, second);
  assert.equal(last.reason, "user cancelled");
});

test("cancel returns null for missing queued message", () => {
  const rt = runtime();

  assert.equal(rt.cancelMessage("missing"), null);
});

test("complete appends completion to session history without requeueing", () => {
  const rt = runtime();
  const id = rt.enqueueMessage({ body: "work", kind: "task" });
  rt.claimNextMessage();

  rt.completeMessage(id, "done");

  assert.deepEqual(readJson(rt.queuePath).items, []);
  const last = readJsonl(rt.sessionLogPath).at(-1);
  assert.equal(last.type, "complete");
  assert.equal(last.messageId, id);
  assert.equal(last.response, "done");
});

test("UserPromptSubmit starts interactive mode", () => {
  const rt = runtime();

  const result = rt.handleHook({
    hook_event_name: "UserPromptSubmit",
    session_id: "session-1",
    turn_id: "turn-1",
    prompt: "启动交互式工作流"
  });

  assert.equal(result.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(JSON.stringify(result), /CatchTail interactive mode is active/);
  assert.equal(readJson(rt.statePath).interactive.enabled, true);
});

test("Stop continues when queue has an item and does not consume it", () => {
  const rt = runtime();
  rt.enableInteractive("turn-1");
  const id = rt.enqueueMessage({ body: "请处理", kind: "message" });

  const result = rt.handleHook({
    hook_event_name: "Stop",
    turn_id: "turn-2",
    stop_hook_active: false
  });

  assert.equal(result.decision, "block");
  assert.match(result.reason, /请处理/);
  assert.equal(readJson(rt.queuePath).items[0].id, id);
});

test("Stop exits when milestone is completed", () => {
  const rt = runtime();
  rt.enableInteractive("turn-1");
  rt.setMilestone("completed");
  rt.enqueueMessage({ body: "ignored", kind: "message" });

  const result = rt.handleHook({
    hook_event_name: "Stop",
    turn_id: "turn-2",
    stop_hook_active: false
  });

  assert.deepEqual(result, {});
});

test("compact keeps queue and trims old history", () => {
  const rt = runtime({ maxHistoryEntries: 3 });
  rt.enqueueMessage({ body: "keep in queue", kind: "message" });
  for (let i = 0; i < 5; i += 1) {
    const id = rt.enqueueMessage({ body: `done ${i}`, kind: "message" });
    rt.claimNextMessage();
    rt.completeMessage(id, "done");
  }

  rt.compact();

  assert.equal(readJson(rt.queuePath).items.length, 1);
  assert.ok(readJsonl(rt.sessionLogPath).length <= 3);
  assert.equal(existsSync(rt.sessionLogPath), true);
});

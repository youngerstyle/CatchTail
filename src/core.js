import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(MODULE_DIR, "..");

const DEFAULT_STATE = {
  version: 2,
  interactive: {
    enabled: false,
    milestone: "incomplete",
    startedAt: null,
    lastTurnId: null
  }
};

export class CatchTailRuntime {
  constructor(options = {}) {
    this.root = options.root ?? process.cwd();
    this.stateDir = options.stateDir ?? join(this.root, ".catchtail");
    this.sessionId = sanitizeSessionId(options.sessionId ?? "default");
    this.sessionDir = join(this.stateDir, "sessions", this.sessionId);
    this.statePath = join(this.sessionDir, "state.json");
    this.queuePath = join(this.sessionDir, "queue.json");
    this.sessionLogPath = join(this.sessionDir, "session.jsonl");
    this.maxHistoryEntries = options.maxHistoryEntries ?? 1000;
    this.ensureDirs();
  }

  ensureDirs() {
    mkdirSync(this.sessionDir, { recursive: true });
    if (!existsSync(this.statePath)) this.writeState(DEFAULT_STATE);
    if (!existsSync(this.queuePath)) this.writeQueue([]);
    if (!existsSync(this.sessionLogPath)) writeFileSync(this.sessionLogPath, "");
  }

  getState() {
    return readJson(this.statePath, DEFAULT_STATE);
  }

  state() {
    const state = this.getState();
    return {
      ...state,
      queue: this.getQueue().items,
      messages: Object.fromEntries(this.getQueue().items.map((item) => [item.id, item]))
    };
  }

  writeState(state) {
    atomicWrite(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  updateState(mutator) {
    const state = this.getState();
    const result = mutator(state);
    this.writeState(state);
    return result;
  }

  getQueue() {
    return readJson(this.queuePath, {
      sessionId: this.sessionId,
      updatedAt: new Date().toISOString(),
      items: []
    });
  }

  writeQueue(items) {
    atomicWrite(
      this.queuePath,
      `${JSON.stringify(
        { sessionId: this.sessionId, updatedAt: new Date().toISOString(), items },
        null,
        2
      )}\n`
    );
  }

  appendHistory(entry) {
    appendFileSync(
      this.sessionLogPath,
      `${JSON.stringify({
        id: randomUUID(),
        at: new Date().toISOString(),
        sessionId: this.sessionId,
        ...entry
      })}\n`
    );
  }

  enableInteractive(turnId = null) {
    this.updateState((state) => {
      state.interactive.enabled = true;
      state.interactive.milestone = "incomplete";
      state.interactive.startedAt ??= new Date().toISOString();
      state.interactive.lastTurnId = turnId;
    });
    this.appendHistory({ type: "interactive.enabled", turnId });
  }

  setMilestone(value) {
    this.updateState((state) => {
      state.interactive.milestone = value;
    });
    this.appendHistory({ type: "milestone", value });
  }

  enqueueMessage({ body, kind = "message", files = [], refs = [] }) {
    const item = {
      id: randomUUID(),
      kind,
      body,
      files,
      refs,
      createdAt: new Date().toISOString()
    };
    const queue = this.getQueue().items;
    queue.push(item);
    this.writeQueue(queue);
    this.appendHistory({ type: "message", ...item });
    return item.id;
  }

  addUserMessage(input) {
    return this.enqueueMessage(input);
  }

  claimNextMessage() {
    const queue = this.getQueue().items;
    const item = queue.shift() ?? null;
    this.writeQueue(queue);
    if (item) this.appendHistory({ type: "claim", messageId: item.id, message: item });
    return item;
  }

  completeMessage(messageId, response = "") {
    this.appendHistory({ type: "complete", messageId, response });
  }

  cancelMessage(messageId, reason = "") {
    const queue = this.getQueue().items;
    const index = queue.findIndex((item) => item.id === messageId);
    if (index < 0) return null;
    const [item] = queue.splice(index, 1);
    this.writeQueue(queue);
    this.appendHistory({ type: "cancel", messageId, reason, message: item });
    return item;
  }

  pendingMessages() {
    return this.getQueue().items;
  }

  handleHook(input) {
    const eventName = input.hook_event_name ?? input.hookEventName;
    if (eventName === "UserPromptSubmit") return this.onUserPromptSubmit(input);
    if (eventName === "Stop") return this.onStop(input);
    if (eventName === "SessionStart") {
      this.appendHistory({ type: "session.start", source: input.source ?? null });
      return {};
    }
    return {};
  }

  onUserPromptSubmit(input) {
    this.appendHistory({
      type: "prompt.submit",
      turnId: input.turn_id ?? null,
      prompt: input.prompt ?? ""
    });
    if (String(input.prompt ?? "").includes("启动交互式工作流")) {
      this.enableInteractive(input.turn_id ?? null);
      return {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: interactiveContext()
        }
      };
    }
    return {};
  }

  onStop(input) {
    const state = this.getState();
    this.appendHistory({
      type: "stop",
      turnId: input.turn_id ?? null,
      stopHookActive: input.stop_hook_active ?? false
    });
    if (!state.interactive.enabled) return {};
    if (state.interactive.milestone === "completed") return {};
    if (input.stop_hook_active) return {};
    return {
      decision: "block",
      reason: buildContinuationPrompt(this.pendingMessages(), state.interactive)
    };
  }

  compact() {
    const history = readJsonl(this.sessionLogPath);
    const trimmed = history.slice(-this.maxHistoryEntries);
    atomicWrite(
      this.sessionLogPath,
      trimmed.map((entry) => JSON.stringify(entry)).join("\n") + (trimmed.length ? "\n" : "")
    );
  }
}

export function interactiveContext() {
  const command = cliCommand();
  return [
    "CatchTail interactive mode is active.",
    "Runtime is lightweight: queue.json contains only unclaimed user input; session.jsonl contains history.",
    `When prompted by CatchTail, run \`${command} claim\`, handle that message, then run \`${command} complete <id> <short response>\`.`,
    "After claiming a message, print `**处理队列消息：**`, then print the message body inside a fenced `text` code block, then list attachment paths and context hints.",
    `After complete, run \`${command} wait\` while milestone is incomplete; do not send final.`,
    "While wait is running, do not post heartbeat-style idle updates in chat; stay quiet until a message, stop signal, timeout, or error occurs.",
    "Stop only when milestone is completed."
  ].join("\n");
}

function cliCommand() {
  const cliPath = relative(process.cwd(), join(PROJECT_ROOT, "bin", "catchtail.js")) || join(PROJECT_ROOT, "bin", "catchtail.js");
  const normalized = cliPath.startsWith("..") ? cliPath : `.${cliPath.startsWith("\\") || cliPath.startsWith("/") ? "" : "/"}${cliPath}`;
  return `node ${normalized.replaceAll("\\", "/")}`;
}

function buildContinuationPrompt(messages, interactive) {
  const lines = [
    "CatchTail interactive workflow is still active.",
    `Milestone: ${interactive.milestone}.`,
    "Use queue + session history, not chat-side polling."
  ];
  if (messages.length) {
    lines.push("Queued user input:");
    for (const message of messages.slice(0, 10)) {
      const files = message.files?.length ? ` Files: ${message.files.join(", ")}` : "";
      const refs = message.refs?.length
        ? ` Hints: ${message.refs.map((ref) => `${ref.type}:${ref.value}`).join(", ")}`
        : "";
      lines.push(`- ${message.kind} ${message.id}: ${message.body}${files}${refs}`);
    }
    lines.push("Claim the next item before handling it.");
  } else {
    lines.push("No queued input is visible. The Stop hook may long-poll the sidecar before falling back here.");
  }
  return lines.join("\n");
}

function readJson(path, fallback) {
  if (!existsSync(path)) return structuredClone(fallback);
  return JSON.parse(stripBom(readFileSync(path, "utf8")));
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return stripBom(readFileSync(path, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function stripBom(value) {
  return value.replace(/^\uFEFF/, "");
}

function atomicWrite(path, content) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function sanitizeSessionId(value) {
  const raw = String(value || "default");
  return raw.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120) || "default";
}

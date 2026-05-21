import { readFileSync } from "node:fs";
import { CatchTailRuntime } from "./core.js";

export async function runHook({
  root = process.cwd(),
  stdin = null,
  env = process.env,
  waitForActivity = waitForSidecarActivity
} = {}) {
  let payload;
  try {
    payload = JSON.parse(stdin ?? readStdin());
  } catch (error) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `Invalid Codex hook payload: ${error.message}`
    };
  }

  try {
    const runtime = new CatchTailRuntime({
      root,
      sessionId: payload.session_id
    });
    if (shouldWaitBeforeStop(runtime, payload)) {
      await waitForActivity({
        root,
        env,
        sessionId: runtime.sessionId,
        timeoutMs: Number(env.CATCHTAIL_STOP_WAIT_MS ?? 540000)
      });
    }
    const result = runtime.handleHook(payload);
    return {
      exitCode: 0,
      stdout: `${JSON.stringify(result)}\n`,
      stderr: ""
    };
  } catch (error) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `CatchTail hook failed: ${error.stack ?? error.message}`
    };
  }
}

function shouldWaitBeforeStop(runtime, payload) {
  const eventName = payload.hook_event_name ?? payload.hookEventName;
  if (eventName !== "Stop") return false;
  if (payload.stop_hook_active) return false;
  const state = runtime.getState();
  if (!state.interactive.enabled) return false;
  if (state.interactive.milestone === "completed") return false;
  if (runtime.pendingMessages().length > 0) return false;
  return true;
}

async function waitForSidecarActivity({ root, env, sessionId, timeoutMs }) {
  const runtime = new CatchTailRuntime({ root, sessionId });
  const url = env.CATCHTAIL_WAIT_URL
    ?? runtime.getState().sidecar?.waitUrl
    ?? "http://127.0.0.1:3787/api/wait";
  const waitUrl = new URL(url);
  waitUrl.searchParams.set("sessionId", sessionId);
  waitUrl.searchParams.set("timeoutMs", String(Math.max(1, timeoutMs)));
  try {
    const response = await fetch(waitUrl);
    if (!response.ok) return { ok: false, reason: "http-error" };
    return await response.json();
  } catch {
    return { ok: false, reason: "sidecar-unavailable" };
  }
}

export async function runHookCli() {
  const result = await runHook();
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  process.exitCode = result.exitCode;
}

function readStdin() {
  return readFileSync(0, "utf8");
}

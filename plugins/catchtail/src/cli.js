import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "./server.js";
import { CatchTailRuntime } from "./core.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(MODULE_DIR, "..");
const HOOK_PATH = resolve(MODULE_DIR, "..", "hooks", "catchtail-hook.js");
const SKILL_TEMPLATE_PATH = resolve(MODULE_DIR, "..", "templates", "catchtail-skill.md");

export async function runCli(
  argv = process.argv.slice(2),
  { root = process.cwd(), fetchImpl = fetch, stayOpen = true, env = process.env } = {}
) {
  const parsed = parseGlobalArgs(argv);
  if (parsed.error) return errorResult(parsed.error);
  const command = parsed.argv[0] ?? "help";
  const sessionId = parsed.sessionId;

  if (command === "init") return initProject(resolve(parsed.argv[1] ?? root));
  if (requiresSession(command) && !sessionId) return missingSessionResult(command);
  if (command === "serve") return serve(root, Number(parsed.argv[1] ?? 0), { stayOpen, sessionId, env });
  if (command === "status") return status(root, sessionId);
  if (command === "wait") {
    return waitForSidecar(root, sessionId, parsed.argv[1], fetchImpl);
  }
  if (command === "claim") return claim(root, sessionId);
  if (command === "complete") {
    return complete(root, sessionId, parsed.argv[1], parsed.argv.slice(2).join(" "));
  }
  if (command === "message") {
    const runtime = new CatchTailRuntime({ root, sessionId });
    const id = runtime.enqueueMessage({
      body: parsed.argv.slice(1).join(" "),
      kind: "message"
    });
    return { exitCode: 0, stdout: `Queued message ${id}\n`, stderr: "" };
  }
  return { exitCode: 0, stdout: helpText(), stderr: "" };
}

export async function runCliMain() {
  const result = await runCli();
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

function parseGlobalArgs(argv) {
  const args = [...argv];
  let sessionId = null;
  if (args[0] === "--session" || args[0] === "-s") {
    if (!args[1]) return { argv: args, sessionId: null, error: "Missing value for --session" };
    sessionId = args[1];
    args.splice(0, 2);
  }
  return { argv: args, sessionId };
}

function requiresSession(command) {
  return new Set(["serve", "status", "wait", "claim", "complete", "message"]).has(command);
}

function missingSessionResult(command) {
  return errorResult(
    [
      `CatchTail cannot run \`${command}\` without a Codex session id.`,
      "Use the hook-injected command that includes \`--session <id>\`.",
      "Refusing to fall back to `default`, because that would mix independent Codex sessions."
    ].join("\n")
  );
}

function errorResult(message) {
  return { exitCode: 2, stdout: "", stderr: `${message}\n` };
}

function initProject(root) {
  const { cliPath } = syncProjectInstall(root);
  return {
    exitCode: 0,
    stdout:
      [
        "CatchTail initialized.",
        "Created .codex/hooks.json, .agents/skills/catchtail-interactive/, AGENTS.catchtail.md, and .catchtail/sessions/.",
        "Updated AGENTS.md with the CatchTail managed block.",
        `Run from hook context: node ${quoteCommandPath(cliPath)} --session <id> serve 0`
      ].join("\n") + "\n",
    stderr: ""
  };
}

export function syncProjectInstall(root) {
  const codexDir = join(root, ".codex");
  const skillDir = join(root, ".agents", "skills", "catchtail-interactive");
  mkdirSync(codexDir, { recursive: true });
  mkdirSync(skillDir, { recursive: true });
  mkdirSync(join(root, ".catchtail", "sessions"), { recursive: true });

  const hooksPath = join(codexDir, "hooks.json");
  const existingHooks = readJson(hooksPath, { hooks: {} });
  mergeHookConfig(existingHooks, hookConfig());
  writeFileSync(hooksPath, `${JSON.stringify(existingHooks, null, 2)}\n`);
  const cliPath = cliPathForProject(root);
  const protocol = agentsProtocol(cliPath);
  writeFileSync(join(root, "AGENTS.catchtail.md"), `${protocol}\n`);
  writeFileSync(join(skillDir, "SKILL.md"), `${skillProtocol(cliPath)}\n`);
  patchAgentsFile(join(root, "AGENTS.md"), protocol);
  return { cliPath };
}

function cliPathForProject(root) {
  return commandPathForProject(root, join(PROJECT_ROOT, "bin", "catchtail.js"));
}

async function serve(root, port, { stayOpen = true, sessionId, env = process.env } = {}) {
  const runtime = new CatchTailRuntime({ root, sessionId });
  let lastActivityAt = Date.now();
  let closeReason = "closed";
  let shutdown = null;
  const server = createServer({
    root,
    defaultSessionId: runtime.sessionId,
    onActivity: () => {
      lastActivityAt = Date.now();
    },
    onCompleted: (completedSessionId) => {
      if (completedSessionId === runtime.sessionId) shutdown?.("completed");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      const consoleUrl = `http://127.0.0.1:${address.port}`;
      runtime.setSidecar({
        consoleUrl,
        waitUrl: `${consoleUrl}/api/wait`,
        port: address.port
      });
      process.stdout.write(`CatchTail Console: ${consoleUrl}\n`);
      process.stdout.write(`CatchTail Session: ${runtime.sessionId}\n`);
      resolve();
    });
  });
  if (!stayOpen) {
    await closeServer(server);
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  const idleMs = sidecarIdleMs(env);
  const timer = setInterval(() => {
    const state = runtime.getState();
    if (state.interactive?.milestone === "completed") {
      shutdown?.("completed");
      return;
    }
    if (Date.now() - lastActivityAt >= idleMs) shutdown?.("idle-timeout");
  }, Math.min(idleMs, 30000));
  timer.unref?.();

  return new Promise((resolve) => {
    shutdown = async (reason = "closed") => {
      if (!server.listening) return;
      closeReason = reason;
      clearInterval(timer);
      server.catchTailNotifyWaiters?.({ ok: false, reason, sessionId: runtime.sessionId });
      await closeServer(server);
      runtime.clearSidecar(reason);
      resolve({ exitCode: 0, stdout: `CatchTail sidecar closed: ${closeReason}\n`, stderr: "" });
    };
    process.once("SIGINT", () => shutdown("sigint"));
    process.once("SIGTERM", () => shutdown("sigterm"));
  });
}

function sidecarIdleMs(env = process.env) {
  const value = Number(env.CATCHTAIL_SIDECAR_IDLE_MS ?? 30 * 60 * 1000);
  if (!Number.isFinite(value)) return 30 * 60 * 1000;
  return Math.max(1000, value);
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function status(root, sessionId) {
  const runtime = new CatchTailRuntime({ root, sessionId });
  return {
    exitCode: 0,
    stdout: `${JSON.stringify(
      { state: runtime.getState(), queue: runtime.getQueue().items },
      null,
      2
    )}\n`,
    stderr: ""
  };
}

async function waitForSidecar(root, sessionId, timeoutArg, fetchImpl) {
  const runtime = new CatchTailRuntime({ root, sessionId });
  const pending = runtime.pendingMessages();
  if (pending.length) {
    return {
      exitCode: 0,
      stdout: `${JSON.stringify(
        { ok: true, reason: "queued", id: pending[0].id, sessionId },
        null,
        2
      )}\n`,
      stderr: ""
    };
  }
  const totalTimeoutMs = Number(timeoutArg ?? 540000);
  const deadline = Date.now() + (Number.isFinite(totalTimeoutMs) ? totalTimeoutMs : 540000);
  let lastError = null;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const sidecar = runtime.getState().sidecar;
    if (!sidecar?.waitUrl) {
      return {
        exitCode: 2,
        stdout: "",
        stderr: `No CatchTail sidecar is registered for session ${sessionId}. Start it with the hook-injected \`--session ${sessionId} serve 0\` command.\n`
      };
    }
    const waitUrl = new URL(sidecar.waitUrl);
    waitUrl.searchParams.set("sessionId", sessionId);
    waitUrl.searchParams.set("timeoutMs", String(Math.min(remaining, 240000)));
    try {
      const response = await fetchImpl(waitUrl);
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        await sleep(1000);
        continue;
      }
      const payload = await response.json();
      if (payload.reason === "timeout") continue;
      return { exitCode: 0, stdout: `${JSON.stringify(payload, null, 2)}\n`, stderr: "" };
    } catch (error) {
      lastError = error.message;
      await sleep(1000);
    }
  }
  if (lastError) return { exitCode: 2, stdout: "", stderr: `Wait failed: ${lastError}\n` };
  return {
    exitCode: 0,
    stdout: `${JSON.stringify({ ok: false, reason: "timeout", sessionId }, null, 2)}\n`,
    stderr: ""
  };
}

function claim(root, sessionId) {
  const runtime = new CatchTailRuntime({ root, sessionId });
  return {
    exitCode: 0,
    stdout: `${JSON.stringify(runtime.claimNextMessage() ?? null, null, 2)}\n`,
    stderr: ""
  };
}

function complete(root, sessionId, id, response) {
  if (!id) return { exitCode: 2, stdout: "", stderr: "Missing message id\n" };
  const runtime = new CatchTailRuntime({ root, sessionId });
  runtime.completeMessage(id, response);
  return { exitCode: 0, stdout: `Completed ${id}\n`, stderr: "" };
}

function hookConfig() {
  const command = `node ${quoteCommandPath(normalizeCommandPath(HOOK_PATH))}`;
  const hook = { type: "command", command, timeout: 600 };
  return {
    hooks: {
      UserPromptSubmit: [{ hooks: [hook] }],
      Stop: [{ hooks: [hook] }]
    }
  };
}

function mergeHookConfig(target, source) {
  target.hooks ??= {};
  for (const [eventName, entries] of Object.entries(source.hooks ?? {})) {
    const existing = Array.isArray(target.hooks[eventName]) ? target.hooks[eventName] : [];
    target.hooks[eventName] = [
      ...existing.filter((entry) => !containsCatchTailHook(entry)),
      ...entries
    ];
  }
}

function containsCatchTailHook(entry) {
  return Array.isArray(entry?.hooks)
    && entry.hooks.some((hook) => String(hook?.command ?? "").includes("catchtail-hook.js"));
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(stripBom(readFileSync(path, "utf8")));
}

function stripBom(value) {
  return value.replace(/^\uFEFF/, "");
}

export function agentsProtocol(cliPath = "./bin/catchtail.js") {
  const cliCommandPath = quoteCommandPath(cliPath);
  const sessionCommand = `node ${cliCommandPath} --session <id>`;
  return `# CatchTail Interactive Workflow

当用户说“启动交互式工作流”时，进入 CatchTail interactive mode。

规则：
- 使用 Codex hook payload 的 session_id 隔离运行状态；手动 CLI 必须显式传入 \`--session <id>\`，不能回退到 default。
- 每次停止前重新读取当前 session 的 .catchtail/sessions/<session_id>/state.json 和 queue.json。
- milestone 为 completed 是唯一自然退出条件。
- queue.json 只保存未被领取的消息；领取后即从 queue 移除。
- session.jsonl 保存完整历史。
- 待处理消息按 createdAt 顺序处理；不要只阅读 state 后口头总结。
- 处理用户消息时先运行 \`${sessionCommand} claim\` 领取下一条消息。
- claim 到消息后，必须严格按这个格式打印：先打印 \`**处理队列消息：**\`，空一行后打印 \`---\`，再空一行打印正文；正文后打印 \`附件路径：\`，有附件时每行 \`- <绝对路径>\`，没有附件时打印 \`无\`；再打印 \`上下文提示：\`，有 refs 时逐行列出，没有时打印 \`无\`；最后空一行打印 \`---\`。不要把附件标题缩写成“附件：”，不要省略标题，不要用 fenced code block 或 blockquote 包裹正文。
- 回复或执行完该消息后，运行 \`${sessionCommand} complete <id> <简短处理结果>\` 标记完成。
- complete 后如果 milestone 仍未 completed，立即运行 \`${sessionCommand} wait\` 等待下一条消息；不要发送 final 结束当前回合。
- wait 运行期间不要在聊天里发送心跳式空闲更新；保持工具等待，只有收到消息、停止、超时或错误需要处理时再说话。
- 支持消息中的文件和图片路径；需要时用本地工具读取。
- 没有待处理消息时，依赖 \`${sessionCommand} wait\` 或 Stop hook 的本地长轮询等待；不要在聊天里高频轮询。
- 不要把 hook 生成的续跑提示当成用户最终验收；它只是交互循环控制信号。
- 对高风险动作继续遵守 Codex 权限、sandbox 和用户批准规则。`;
}

export function skillProtocol(cliPath = "./bin/catchtail.js") {
  return readFileSync(SKILL_TEMPLATE_PATH, "utf8").replaceAll("{{CLI_PATH}}", quoteCommandPath(cliPath));
}

function patchAgentsFile(path, protocol) {
  const start = "<!-- CatchTail:START -->";
  const end = "<!-- CatchTail:END -->";
  const block = `${start}\n${protocol}\n${end}`;
  const existing = existsSync(path) ? readFileSync(path, "utf8").trimEnd() : "";
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`);
  const next = pattern.test(existing)
    ? existing.replace(pattern, block)
    : [existing, block].filter(Boolean).join("\n\n");
  writeFileSync(path, `${next}\n`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function commandPathForProject(root, target) {
  const relativePath = relative(root, target);
  const path = relativePath && !isAbsolute(relativePath) ? relativePath : target;
  return normalizeCommandPath(path);
}

function normalizeCommandPath(path) {
  const normalized = String(path).replaceAll("\\", "/");
  if (
    normalized.startsWith("./")
    || normalized.startsWith("../")
    || normalized.startsWith("/")
    || /^[A-Za-z]:\//.test(normalized)
  ) {
    return normalized;
  }
  return `./${normalized}`;
}

function quoteCommandPath(path) {
  return JSON.stringify(path);
}

function helpText() {
  return `CatchTail

Commands:
  --session <id>     Required Codex session id for session-scoped commands
  init               Create Codex hook config and protocol files
  serve [port]       Start this session's local web console (default port: 0)
  status             Print state and queue for a session
  wait [timeoutMs]   Long-poll the local sidecar for a session event
  message <text>     Queue a user message
  claim              Claim and remove the next queued message
  complete <id>      Append completion to session history
`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

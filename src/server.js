import { createServer as createHttpServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { extname, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { CatchTailRuntime } from "./core.js";

export function createServer({ root = process.cwd(), openFile = openPathWithDefaultApp } = {}) {
  const waiters = new Set();
  return createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");

      if (request.method === "GET" && url.pathname === "/") {
        return sendHtml(response, renderConsole());
      }
      if (request.method === "OPTIONS" && url.pathname.startsWith("/api/queue")) {
        return sendCorsPreflight(response);
      }
      if (request.method === "GET" && url.pathname === "/api/queue") {
        const runtime = queueRuntimeFor(root, url);
        return sendJson(response, runtime.getQueue(), { cors: true });
      }
      if (request.method === "POST" && url.pathname === "/api/queue") {
        const runtime = queueRuntimeFor(root, url);
        const body = await readJson(request);
        const id = runtime.enqueueMessage({
          body: String(body.body ?? ""),
          kind: body.kind ?? "message",
          files: Array.isArray(body.files) ? body.files : [],
          refs: normalizeRefs(body.refs)
        });
        notifyWaiters(waiters, { ok: true, reason: "message", id, sessionId: runtime.sessionId });
        return sendJson(response, { ok: true, id, sessionId: runtime.sessionId }, { cors: true });
      }
      if (request.method === "POST" && url.pathname === "/api/queue/claim") {
        const runtime = queueRuntimeFor(root, url);
        return sendJson(response, {
          ok: true,
          item: runtime.claimNextMessage(),
          sessionId: runtime.sessionId
        }, { cors: true });
      }
      if (request.method === "POST" && url.pathname === "/api/queue/cancel") {
        const runtime = queueRuntimeFor(root, url);
        const body = await readJson(request);
        const id = String(body.id ?? "");
        if (!id) return sendJson(response, { ok: false, error: "Missing message id" }, { status: 400, cors: true });
        const item = runtime.cancelMessage(id, String(body.reason ?? ""));
        if (!item) return sendJson(response, { ok: false, error: "Queue item not found" }, { status: 404, cors: true });
        notifyWaiters(waiters, { ok: true, reason: "cancel", id, sessionId: runtime.sessionId });
        return sendJson(response, { ok: true, item, sessionId: runtime.sessionId }, { cors: true });
      }
      if (request.method === "POST" && url.pathname === "/api/queue/complete") {
        const runtime = queueRuntimeFor(root, url);
        const body = await readJson(request);
        const id = String(body.id ?? "");
        if (!id) return sendJson(response, { ok: false, error: "Missing message id" }, { status: 400, cors: true });
        runtime.completeMessage(id, String(body.response ?? ""));
        return sendJson(response, { ok: true, id, sessionId: runtime.sessionId }, { cors: true });
      }

      const runtime = runtimeFor(root, url);

      if (request.method === "GET" && url.pathname === "/api/state") {
        return sendJson(response, withSession(runtime, runtime.getState()));
      }
      if (request.method === "GET" && url.pathname === "/api/session") {
        return sendJson(response, {
          sessionId: runtime.sessionId,
          items: readJsonl(runtime.sessionLogPath)
        });
      }
      if (request.method === "GET" && url.pathname === "/api/file") {
        const path = assertOpenableUpload(root, url.searchParams.get("path"));
        return sendFile(response, path);
      }
      if (request.method === "GET" && url.pathname === "/api/wait") {
        const pending = runtime.pendingMessages();
        if (pending.length) {
          return sendJson(response, {
            ok: true,
            reason: "queued",
            id: pending[0].id,
            sessionId: runtime.sessionId
          });
        }
        return waitForActivity(
          response,
          waiters,
          url.searchParams.get("sessionId"),
          clampTimeout(Number(url.searchParams.get("timeoutMs") ?? 300000))
        );
      }
      if (request.method === "POST" && url.pathname === "/api/messages") {
        const body = await readJson(request);
        const id = runtime.enqueueMessage({
          body: String(body.body ?? ""),
          kind: body.kind ?? "message",
          files: Array.isArray(body.files) ? body.files : [],
          refs: normalizeRefs(body.refs)
        });
        notifyWaiters(waiters, { ok: true, reason: "message", id, sessionId: runtime.sessionId });
        return sendJson(response, { ok: true, id, sessionId: runtime.sessionId });
      }
      if (request.method === "POST" && url.pathname === "/api/files") {
        const files = await saveUploadedFiles(request, root, runtime.sessionId);
        return sendJson(response, { ok: true, files, sessionId: runtime.sessionId });
      }
      if (request.method === "POST" && url.pathname === "/api/open") {
        const body = await readJson(request);
        const path = assertOpenableUpload(root, body.path);
        openFile(path);
        return sendJson(response, { ok: true, path, sessionId: runtime.sessionId });
      }
      if (request.method === "POST" && url.pathname === "/api/milestone") {
        const body = await readJson(request);
        runtime.setMilestone(body.milestone);
        notifyWaiters(waiters, {
          ok: true,
          reason: "milestone",
          milestone: body.milestone,
          sessionId: runtime.sessionId
        });
        return sendJson(response, { ok: true, sessionId: runtime.sessionId });
      }

      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Not found" }));
    } catch (error) {
      response.writeHead(error.statusCode ?? 500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
  });
}

function runtimeFor(root, url) {
  return new CatchTailRuntime({
    root,
    sessionId: url.searchParams.get("sessionId") ?? latestActiveSessionId(root) ?? "default"
  });
}

function queueRuntimeFor(root, url) {
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    throw httpError(400, "Missing required sessionId");
  }
  return new CatchTailRuntime({ root, sessionId });
}

function latestActiveSessionId(root) {
  const sessionsDir = join(root, ".catchtail", "sessions");
  if (!existsSync(sessionsDir)) return null;
  let best = null;
  for (const name of readdirSync(sessionsDir)) {
    const statePath = join(sessionsDir, name, "state.json");
    if (!existsSync(statePath)) continue;
    try {
      const state = JSON.parse(stripBom(readFileSync(statePath, "utf8")));
      const interactive = state.interactive ?? {};
      if (!interactive.enabled || interactive.milestone === "completed") continue;
      const startedAt = Date.parse(interactive.startedAt ?? "") || 0;
      if (!best || startedAt > best.startedAt) best = { name, startedAt };
    } catch {
      continue;
    }
  }
  return best?.name ?? null;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function withSession(runtime, payload) {
  return { sessionId: runtime.sessionId, ...payload };
}

function waitForActivity(response, waiters, sessionId, timeoutMs) {
  let done = false;
  const waiter = (payload) => {
    if (sessionId && payload.sessionId && payload.sessionId !== sessionId) return;
    if (done) return;
    done = true;
    clearTimeout(timer);
    waiters.delete(waiter);
    sendJson(response, payload);
  };
  const timer = setTimeout(() => waiter({ ok: false, reason: "timeout" }), timeoutMs);
  waiters.add(waiter);
}

function notifyWaiters(waiters, payload) {
  for (const waiter of [...waiters]) waiter(payload);
}

function clampTimeout(value) {
  if (!Number.isFinite(value)) return 300000;
  return Math.max(1, Math.min(value, 600000));
}

function sendJson(response, payload, options = {}) {
  response.writeHead(options.status ?? 200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...(options.cors ? corsHeaders() : {})
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

function sendCorsPreflight(response) {
  response.writeHead(204, corsHeaders());
  response.end();
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type"
  };
}

function sendHtml(response, html) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(html);
}

function sendFile(response, path) {
  response.writeHead(200, {
    "content-type": contentTypeFor(path),
    "cache-control": "no-store"
  });
  createReadStream(path).pipe(response);
}

function contentTypeFor(path) {
  switch (extname(path).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".svg": return "image/svg+xml";
    case ".json": return "application/json";
    case ".txt": return "text/plain; charset=utf-8";
    default: return "application/octet-stream";
  }
}

async function readJson(request) {
  let data = "";
  for await (const chunk of request) data += chunk;
  return data ? JSON.parse(data) : {};
}

function normalizeRefs(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((ref) => ({
      type: String(ref?.type ?? "path").trim().toLowerCase(),
      value: String(ref?.value ?? "").trim()
    }))
    .filter((ref) => ref.value && ["skill", "plugin", "path"].includes(ref.type));
}

async function saveUploadedFiles(request, root, sessionId) {
  const webRequest = new Request("http://127.0.0.1/upload", {
    method: "POST",
    headers: request.headers,
    body: request,
    duplex: "half"
  });
  const form = await webRequest.formData();
  const uploadDir = join(root, ".catchtail", "uploads", sessionId);
  mkdirSync(uploadDir, { recursive: true });
  const saved = [];
  for (const value of form.getAll("files")) {
    if (!(value instanceof File)) continue;
    const filename = safeFilename(value.name || "upload.bin");
    const storedName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}-${filename}`;
    const path = join(uploadDir, storedName);
    writeFileSync(path, Buffer.from(await value.arrayBuffer()));
    saved.push({
      name: value.name,
      path,
      size: value.size,
      type: value.type
    });
  }
  return saved;
}

function safeFilename(name) {
  return String(name).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(0, 180) || "upload.bin";
}

function assertOpenableUpload(root, requestedPath) {
  const uploadRoot = resolve(root, ".catchtail", "uploads");
  const target = resolve(String(requestedPath ?? ""));
  const rel = relative(uploadRoot, target);
  if (!rel || rel.startsWith("..") || rel === ".." || resolve(uploadRoot, rel) !== target) {
    throw new Error("File is outside CatchTail uploads");
  }
  if (!existsSync(target)) throw new Error("File does not exist");
  return target;
}

function openPathWithDefaultApp(path) {
  const { command, args } = systemOpenCommand(path);
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

export function systemOpenCommand(path, platform = process.platform) {
  if (platform === "win32") {
    return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", path] };
  }
  if (platform === "darwin") return { command: "open", args: [path] };
  return { command: "xdg-open", args: [path] };
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

function renderConsole() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>小尾巴</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f7f8;
      --panel: #ffffff;
      --line: #e5e7eb;
      --line-strong: #d1d5db;
      --text: #1f2937;
      --muted: #6b7280;
      --soft: #f3f4f6;
      --accent: #111827;
      --blue: #2563eb;
      --danger: #dc2626;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
    }
    main {
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr auto;
    }
    header {
      height: 56px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 22px;
      border-bottom: 1px solid var(--line);
      background: rgba(255,255,255,.86);
      backdrop-filter: blur(10px);
      position: sticky;
      top: 0;
      z-index: 2;
    }
    h1 {
      margin: 0;
      font-size: 15px;
      font-weight: 650;
      letter-spacing: 0;
    }
    button {
      font: inherit;
      border: 0;
      cursor: pointer;
      background: transparent;
      color: inherit;
    }
    .session {
      max-width: min(48vw, 520px);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--muted);
      font-size: 12px;
    }
    .header-actions {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }
    .stop-queue {
      width: 32px;
      height: 32px;
      border: 1px solid var(--line);
      border-radius: 8px;
      display: inline-grid;
      place-items: center;
      color: var(--muted);
      background: var(--panel);
    }
    .stop-queue:hover {
      color: var(--danger);
      border-color: #fecaca;
      background: #fef2f2;
    }
    .queue-wrap {
      max-width: 980px;
      width: 100%;
      margin: 0 auto;
      padding: 22px 18px 170px;
    }
    .queue-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-height: 32px;
      padding: 0 2px 8px;
      color: var(--muted);
      font-size: 12px;
    }
    .queue-list {
      border: 1px solid rgba(209, 213, 219, .7);
      border-radius: 14px;
      overflow: hidden;
      background: rgba(255, 255, 255, .72);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, .65);
    }
    .queue-empty {
      min-height: 118px;
      display: grid;
      place-items: center;
      padding: 28px 18px;
      color: var(--muted);
      text-align: center;
      background: linear-gradient(180deg, rgba(255,255,255,.8), rgba(249,250,251,.72));
    }
    .queue-item {
      display: grid;
      grid-template-columns: 92px 1fr auto;
      gap: 12px;
      align-items: center;
      min-height: 46px;
      padding: 10px 14px;
      border-top: 1px solid var(--line);
    }
    .queue-item:first-child { border-top: 0; }
    .queue-kind {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
    }
    .queue-body {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      line-height: 1.45;
    }
    .queue-meta {
      display: flex;
      align-items: center;
      gap: 10px;
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }
    .queue-cancel {
      width: 28px;
      height: 28px;
      border-radius: 8px;
      display: inline-grid;
      place-items: center;
      color: var(--muted);
    }
    .queue-cancel:hover {
      background: #fef2f2;
      color: var(--danger);
    }
    .queue-cancel svg {
      width: 14px;
      height: 14px;
    }
    .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--blue);
      display: inline-block;
    }
    .composer-shell {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      padding: 18px;
      background: linear-gradient(to top, var(--bg) 78%, rgba(247,247,248,0));
      z-index: 3;
    }
    .composer {
      max-width: 980px;
      margin: 0 auto;
      border: 1px solid var(--line-strong);
      background: var(--panel);
      border-radius: 18px;
      box-shadow: 0 12px 30px rgba(15, 23, 42, .08);
      overflow: hidden;
    }
    .attachments {
      display: none;
      gap: 10px;
      flex-wrap: wrap;
      align-items: flex-start;
      padding: 12px 12px 0;
    }
    .attachments.has-items { display: flex; }
    .context-panel {
      display: grid;
      grid-template-columns: 116px 1fr auto;
      gap: 8px;
      padding: 0 12px 10px;
    }
    .context-panel[hidden] { display: none; }
    .context-panel select,
    .context-panel input {
      height: 34px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--soft);
      color: var(--text);
      font: inherit;
      font-size: 13px;
      padding: 0 10px;
      min-width: 0;
    }
    .context-panel button {
      height: 34px;
      border-radius: 10px;
      background: var(--text);
      color: white;
      padding: 0 14px;
      font-size: 13px;
    }
    .attachment-preview,
    .attachment-file {
      position: relative;
      border: 1px solid var(--line);
      background: var(--soft);
      color: var(--text);
      cursor: pointer;
    }
    .attachment-preview:focus-visible,
    .attachment-file:focus-visible {
      outline: 2px solid var(--blue);
      outline-offset: 2px;
    }
    .attachment-preview {
      width: 96px;
      height: 72px;
      border-radius: 12px;
      overflow: hidden;
    }
    .attachment-preview img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .attachment-file {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      max-width: 300px;
      border-radius: 12px;
      padding: 10px 36px 10px 10px;
      font-size: 12px;
    }
    .attachment-icon {
      display: grid;
      place-items: center;
      width: 24px;
      height: 24px;
      border: 1px solid var(--line);
      border-radius: 8px;
      color: var(--muted);
      flex: 0 0 auto;
      background: var(--panel);
    }
    .attachment-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .reference-chip .attachment-icon {
      color: var(--blue);
      border-color: #bfdbfe;
      background: #eff6ff;
    }
    .attachment-remove {
      position: absolute;
      top: 4px;
      right: 4px;
      display: grid;
      place-items: center;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: #111827;
      color: white;
      padding: 0;
      box-shadow: 0 4px 12px rgba(15, 23, 42, .18);
    }
    .attachment-remove svg {
      width: 13px;
      height: 13px;
    }
    .image-viewer {
      position: fixed;
      inset: 0;
      display: grid;
      grid-template-rows: auto 1fr;
      background: rgba(17, 24, 39, .82);
      z-index: 20;
    }
    .image-viewer[hidden] { display: none; }
    .image-viewer-bar {
      height: 52px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 0 18px;
      color: #fff;
    }
    .image-viewer-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
    }
    .image-viewer-close {
      width: 34px;
      height: 34px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      background: rgba(255, 255, 255, .14);
      color: #fff;
    }
    .image-viewer-close svg {
      width: 16px;
      height: 16px;
    }
    .image-viewer-stage {
      min-height: 0;
      display: grid;
      place-items: center;
      padding: 18px;
    }
    .image-viewer-stage img {
      max-width: min(100%, 1120px);
      max-height: 100%;
      object-fit: contain;
      border-radius: 10px;
      box-shadow: 0 24px 70px rgba(0, 0, 0, .35);
      background: #fff;
    }
    textarea {
      width: 100%;
      min-height: 74px;
      max-height: 240px;
      border: 0;
      outline: 0;
      resize: none;
      padding: 16px 18px 8px;
      color: var(--text);
      font: inherit;
      line-height: 1.55;
      background: transparent;
    }
    textarea::placeholder { color: #9ca3af; }
    .toolbar {
      min-height: 48px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 8px 10px 10px;
    }
    .tools {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .icon-btn {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      display: inline-grid;
      place-items: center;
      color: var(--muted);
    }
    .icon-btn:hover { background: var(--soft); color: var(--text); }
    .send {
      width: 34px;
      height: 34px;
      border-radius: 50%;
      display: inline-grid;
      place-items: center;
      background: var(--accent);
      color: white;
      flex: 0 0 auto;
    }
    .send:disabled {
      opacity: .35;
      cursor: default;
    }
    .drop-hint {
      display: none;
      position: fixed;
      inset: 14px;
      border: 2px dashed var(--blue);
      border-radius: 18px;
      background: rgba(239, 246, 255, .82);
      color: var(--blue);
      align-items: center;
      justify-content: center;
      font-weight: 650;
      z-index: 10;
      pointer-events: none;
    }
    .drop-hint.show { display: flex; }
    input[type="file"] { display: none; }
    @media (max-width: 720px) {
      header { padding: 0 14px; }
      .queue-wrap { padding: 12px 10px 170px; }
      .queue-item {
        grid-template-columns: 1fr auto;
        gap: 6px;
      }
      .queue-kind { display: none; }
      .queue-meta { font-size: 11px; }
      .composer-shell { padding: 10px; }
      .context-panel { grid-template-columns: 1fr; }
      .session { max-width: 58vw; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>小尾巴</h1>
      <div class="header-actions">
        <div class="session" id="sessionLabel">连接中</div>
        <button class="stop-queue" id="stopQueueButton" title="停止队列" aria-label="停止队列">
          <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"></rect>
          </svg>
        </button>
      </div>
    </header>

    <section class="queue-wrap" aria-label="待处理队列">
      <div class="queue-head">
        <span>待处理队列</span>
        <span id="queueCount">0</span>
      </div>
      <div class="queue-list" id="queueList"></div>
    </section>

    <section class="composer-shell" aria-label="输入">
      <div class="composer" id="composer">
        <div class="attachments" id="attachments"></div>
        <div class="context-panel" id="contextPanel" hidden>
          <select id="contextType" aria-label="引用类型">
            <option value="skill">Skill</option>
            <option value="plugin">Plugin</option>
            <option value="path">Path</option>
          </select>
          <input id="contextValue" type="text" placeholder="输入 skill、plugin 名称或本地路径" />
          <button id="contextAdd" type="button">添加</button>
        </div>
        <textarea id="message" placeholder="发消息、追加任务，或拖入文件"></textarea>
        <div class="toolbar">
          <div class="tools">
            <button class="icon-btn" id="fileButton" title="添加文件" aria-label="添加文件">
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path>
              </svg>
            </button>
            <button class="icon-btn" id="contextButton" title="添加上下文引用" aria-label="添加上下文引用">
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M7 8h10M7 12h6m-6 4h10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path>
                <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v13A2.5 2.5 0 0 1 17.5 21h-11A2.5 2.5 0 0 1 4 18.5z" fill="none" stroke="currentColor" stroke-width="1.7"></path>
              </svg>
            </button>
          </div>
          <button class="send" id="sendButton" title="发送" aria-label="发送">
            <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 19V5m0 0-6 6m6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"></path>
            </svg>
          </button>
        </div>
      </div>
      <input id="fileInput" type="file" multiple />
    </section>
  </main>
  <div class="image-viewer" id="imageViewer" hidden>
    <div class="image-viewer-bar">
      <div class="image-viewer-title" id="imageViewerTitle"></div>
      <button class="image-viewer-close" id="imageViewerClose" type="button" aria-label="关闭预览">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"></path>
        </svg>
      </button>
    </div>
    <div class="image-viewer-stage" id="imageViewerStage">
      <img id="imageViewerImage" alt="">
    </div>
  </div>
  <div class="drop-hint" id="dropHint">松开以上传文件</div>
  <script>
    const state = { files: [], refs: [], sessionId: 'default', draftLoaded: false };
    const message = document.getElementById('message');
    const fileInput = document.getElementById('fileInput');
    const attachments = document.getElementById('attachments');
    const sendButton = document.getElementById('sendButton');
    const contextPanel = document.getElementById('contextPanel');
    const contextType = document.getElementById('contextType');
    const contextValue = document.getElementById('contextValue');
    const contextAdd = document.getElementById('contextAdd');
    const dropHint = document.getElementById('dropHint');
    const imageViewer = document.getElementById('imageViewer');
    const imageViewerImage = document.getElementById('imageViewerImage');
    const imageViewerTitle = document.getElementById('imageViewerTitle');

    async function api(path, options) {
      const res = await fetch(path, options);
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    }

    async function refresh() {
      const appState = await api('/api/state');
      state.sessionId = appState.sessionId;
      const queue = await api('/api/queue?sessionId=' + encodeURIComponent(state.sessionId));
      document.getElementById('sessionLabel').textContent = appState.sessionId;
      document.getElementById('queueCount').textContent = String(queue.items.length);
      document.getElementById('queueList').innerHTML = queue.items.length
        ? queue.items.map(renderQueueItem).join('')
        : '<div class="queue-empty">队列是空的，新的消息会出现在这里</div>';
      if (!state.draftLoaded) loadDraft();
    }

    function renderQueueItem(item) {
      const parts = [];
      if (item.files?.length) parts.push(item.files.length + ' 个附件');
      if (item.refs?.length) parts.push(item.refs.length + ' 个引用');
      const attachmentText = parts.length ? parts.join(' · ') : '无附件';
      return '<div class="queue-item">' +
        '<div class="queue-kind">' + escapeHtml(item.kind) + '</div>' +
        '<div class="queue-body" title="' + escapeHtml(item.body) + '">' + escapeHtml(item.body || '(空消息)') + '</div>' +
        '<div class="queue-meta"><span>' + attachmentText + '</span><span class="dot"></span>' +
          '<button class="queue-cancel" type="button" title="取消队列项" aria-label="取消队列项" onclick="cancelQueueItem(\\'' + escapeHtml(item.id) + '\\')">' +
            '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>' +
          '</button></div>' +
      '</div>';
    }


    function renderAttachments() {
      attachments.classList.toggle('has-items', state.files.length > 0 || state.refs.length > 0);
      attachments.innerHTML = state.refs.map(renderReference).join('') + state.files.map(renderAttachment).join('');
      updateSendState();
    }

    function renderReference(ref, index) {
      const label = ref.type + ': ' + ref.value;
      const title = escapeHtml(label);
      return '<div class="attachment-file reference-chip" title="' + title + '">' +
        '<span class="attachment-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M7 8h10M7 12h6m-6 4h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v13A2.5 2.5 0 0 1 17.5 21h-11A2.5 2.5 0 0 1 4 18.5z" stroke="currentColor" stroke-width="1.6"/></svg></span>' +
        '<span class="attachment-name">' + title + '</span>' +
        '<button class="attachment-remove" type="button" onclick="event.stopPropagation(); removeRef(' + index + ')" aria-label="移除引用">' +
          '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>' +
        '</button>' +
      '</div>';
    }

    function renderAttachment(file, index) {
      const title = escapeHtml(file.path || file.name);
      const name = escapeHtml(file.name);
      const removeButton =
        '<button class="attachment-remove" type="button" onclick="event.stopPropagation(); removeFile(' + index + ')" aria-label="移除附件">' +
          '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>' +
        '</button>';
      if (isImageFile(file)) {
        const previewUrl = escapeHtml(ensurePreviewUrl(file));
        return '<div class="attachment-preview" title="' + title + '" role="button" tabindex="0" onclick="openAttachment(' + index + ')" onkeydown="handleAttachmentKey(event,' + index + ')">' +
          '<img src="' + previewUrl + '" alt="' + name + '">' +
          removeButton +
        '</div>';
      }
      return '<div class="attachment-file" title="' + title + '" role="button" tabindex="0" onclick="openAttachment(' + index + ')" onkeydown="handleAttachmentKey(event,' + index + ')">' +
        '<span class="attachment-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M7 3h7l5 5v13H7z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M14 3v5h5" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></span>' +
        '<span class="attachment-name">' + name + '</span>' +
        removeButton +
      '</div>';
    }

    function isImageFile(file) {
      return file.type?.startsWith('image/') || /\\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.name || '');
    }

    function ensurePreviewUrl(file) {
      if (!file.previewUrl && file.file) {
        file.previewUrl = URL.createObjectURL(file.file);
        file.previewIsObjectUrl = true;
      }
      if (!file.previewUrl && file.uploadedPath && isImageFile(file)) {
        file.previewUrl = '/api/file?path=' + encodeURIComponent(file.uploadedPath);
      }
      return file.previewUrl || file.path || file.name;
    }

    function revokePreview(file) {
      if (file?.previewUrl && file.previewIsObjectUrl) URL.revokeObjectURL(file.previewUrl);
    }

    function clearFiles() {
      state.files.forEach(revokePreview);
      state.files = [];
      state.refs = [];
      renderAttachments();
      clearDraft();
    }

    window.removeRef = function removeRef(index) {
      state.refs.splice(index, 1);
      renderAttachments();
      saveDraft();
    };

    window.removeFile = function removeFile(index) {
      const removed = state.files.splice(index, 1);
      removed.forEach(revokePreview);
      renderAttachments();
      saveDraft();
    };

    window.openAttachment = async function openAttachment(index) {
      const file = state.files[index];
      if (!file) return;
      const url = ensurePreviewUrl(file);
      if (isImageFile(file)) {
        imageViewerImage.src = url;
        imageViewerImage.alt = file.name;
        imageViewerTitle.textContent = file.name;
        imageViewer.hidden = false;
        return;
      }
      try {
        const path = await ensureAttachmentUploaded(file);
        if (path) {
          await api('/api/open', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path })
          });
          return;
        }
      } catch (error) {
        console.error(error);
      }
      const opened = window.open(url, '_blank', 'noopener,noreferrer');
      if (!opened) window.location.href = url;
    };

    window.handleAttachmentKey = function handleAttachmentKey(event, index) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openAttachment(index);
      }
    };

    function closeImageViewer() {
      imageViewer.hidden = true;
      imageViewerImage.removeAttribute('src');
      imageViewerTitle.textContent = '';
    }

    window.cancelQueueItem = async function cancelQueueItem(id) {
      await api('/api/queue/cancel?sessionId=' + encodeURIComponent(state.sessionId), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, reason: 'cancelled from console' })
      });
      await refresh();
    };

    function addFiles(files) {
      for (const file of files) {
        const name = file.name || pastedFilename(file);
        const key = [name, file.size, file.type].join(':');
        const item = { key, name, path: name, type: file.type, size: file.size, file };
        state.files.push(item);
        ensureAttachmentUploaded(item).then(() => {
          renderAttachments();
          saveDraft();
        }).catch(console.error);
      }
      renderAttachments();
      saveDraft();
    }

    function addReference() {
      const type = contextType.value;
      const value = contextValue.value.trim();
      if (!value) return;
      state.refs.push({ type, value });
      contextValue.value = '';
      contextPanel.hidden = true;
      renderAttachments();
      saveDraft();
    }

    function pastedFilename(file) {
      const ext = file.type === 'image/jpeg' ? 'jpg' : file.type === 'image/webp' ? 'webp' : 'png';
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\\.\\d+Z$/, '').replace('T', '-');
      return 'pasted-' + stamp + '.' + ext;
    }

    async function sendMessage() {
      const body = message.value.trim();
      if (!body && !state.files.length && !state.refs.length) return;
      sendButton.disabled = true;
      const uploaded = await uploadFiles();
      await api('/api/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'message',
          body,
          files: uploaded.map(file => file.path),
          refs: state.refs
        })
      });
      message.value = '';
      clearFiles();
      resizeTextArea();
      await refresh();
      updateSendState();
    }

    async function uploadFiles() {
      await Promise.all(state.files.map(ensureAttachmentUploaded));
      saveDraft();
      return state.files
        .filter(file => file.uploadedPath || file.path)
        .map(file => ({ path: file.uploadedPath || file.path }));
    }

    async function ensureAttachmentUploaded(file) {
      if (file.uploadedPath) return file.uploadedPath;
      if (!file.file) return file.path;
      if (file.uploadPromise) return file.uploadPromise;
      file.uploadPromise = uploadSingleFile(file);
      try {
        return await file.uploadPromise;
      } finally {
        file.uploadPromise = null;
      }
    }

    async function uploadSingleFile(file) {
      const form = new FormData();
      form.append('files', file.file, file.name);
      const result = await api('/api/files', { method: 'POST', body: form });
      const uploaded = result.files?.[0];
      if (!uploaded) return null;
      file.uploadedPath = uploaded.path;
      file.path = uploaded.path;
      file.type = uploaded.type || file.type;
      file.size = uploaded.size || file.size;
      return uploaded.path;
    }

    function draftKey() {
      return 'catchtail:draft:' + state.sessionId;
    }

    function serializableFiles() {
      return state.files
        .filter(file => file.uploadedPath || (!file.file && file.path))
        .map(file => ({
          name: file.name,
          path: file.uploadedPath || file.path,
          uploadedPath: file.uploadedPath || file.path,
          type: file.type || '',
          size: file.size || 0
        }));
    }

    function saveDraft() {
      const body = message.value;
      const files = serializableFiles();
      const refs = state.refs;
      if (!body && !files.length && !refs.length) {
        clearDraft();
        return;
      }
      localStorage.setItem(draftKey(), JSON.stringify({ body, files, refs }));
    }

    function loadDraft() {
      state.draftLoaded = true;
      const raw = localStorage.getItem(draftKey());
      if (!raw) return;
      try {
        const draft = JSON.parse(raw);
        message.value = draft.body || '';
        state.files.forEach(revokePreview);
        state.files = Array.isArray(draft.files)
          ? draft.files.map(file => ({
              name: file.name || file.path,
              path: file.path,
              uploadedPath: file.uploadedPath || file.path,
              type: file.type || '',
              size: file.size || 0
            }))
          : [];
        state.refs = Array.isArray(draft.refs)
          ? draft.refs
              .map(ref => ({ type: ref.type || 'path', value: ref.value || '' }))
              .filter(ref => ref.value)
          : [];
        renderAttachments();
        resizeTextArea();
        updateSendState();
      } catch {
        clearDraft();
      }
    }

    function clearDraft() {
      localStorage.removeItem(draftKey());
    }

    function resizeTextArea() {
      message.style.height = 'auto';
      message.style.height = Math.min(message.scrollHeight, 240) + 'px';
    }

    function updateSendState() {
      sendButton.disabled = !message.value.trim() && state.files.length === 0 && state.refs.length === 0;
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    document.getElementById('fileButton').addEventListener('click', () => fileInput.click());
    document.getElementById('contextButton').addEventListener('click', () => {
      contextPanel.hidden = !contextPanel.hidden;
      if (!contextPanel.hidden) contextValue.focus();
    });
    contextAdd.addEventListener('click', addReference);
    contextValue.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        addReference();
      }
    });
    document.getElementById('imageViewerClose').addEventListener('click', closeImageViewer);
    document.getElementById('imageViewerStage').addEventListener('click', closeImageViewer);
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !imageViewer.hidden) closeImageViewer();
    });
    document.getElementById('stopQueueButton').addEventListener('click', async () => {
      await api('/api/milestone', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ milestone: 'completed' })
      });
      await refresh();
    });
    fileInput.addEventListener('change', event => {
      addFiles(event.target.files);
      fileInput.value = '';
    });
    sendButton.addEventListener('click', sendMessage);
    message.addEventListener('input', () => {
      resizeTextArea();
      updateSendState();
      saveDraft();
    });
    message.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
      }
    });
    function handlePaste(event) {
      const files = [];
      const directFiles = Array.from(event.clipboardData?.files || []);
      if (directFiles.length) {
        files.push(...directFiles);
      } else {
        for (const item of event.clipboardData?.items || []) {
          if (item.kind === 'file') {
            const file = item.getAsFile();
            if (file) files.push(file);
          }
        }
      }
      if (files.length) {
        event.preventDefault();
        addFiles(files);
      }
    }
    document.addEventListener('paste', handlePaste, true);

    window.addEventListener('dragover', event => {
      event.preventDefault();
      dropHint.classList.add('show');
    });
    window.addEventListener('dragleave', event => {
      if (event.clientX === 0 && event.clientY === 0) dropHint.classList.remove('show');
    });
    window.addEventListener('drop', event => {
      event.preventDefault();
      dropHint.classList.remove('show');
      addFiles(event.dataTransfer.files);
    });

    renderAttachments();
    refresh();
    setInterval(refresh, 3000);
  </script>
</body>
</html>`;
}

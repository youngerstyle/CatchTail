import { createServer as createHttpServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
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
        const refs = enrichRefs(root, normalizeRefs(body.refs));
        const id = runtime.enqueueMessage({
          body: bodyWithMentions(String(body.body ?? ""), refs),
          kind: body.kind ?? "message",
          files: Array.isArray(body.files) ? body.files : [],
          refs
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
      if (request.method === "GET" && url.pathname === "/api/refs") {
        return sendJson(response, discoverRefs(root));
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
        const refs = enrichRefs(root, normalizeRefs(body.refs));
        const id = runtime.enqueueMessage({
          body: bodyWithMentions(String(body.body ?? ""), refs),
          kind: body.kind ?? "message",
          files: Array.isArray(body.files) ? body.files : [],
          refs
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
  const seen = new Set();
  return value
    .map((ref) => ({
      type: String(ref?.type ?? "path").trim().toLowerCase(),
      value: String(ref?.value ?? "").trim(),
      label: String(ref?.label ?? "").trim(),
      source: String(ref?.source ?? "").trim()
    }))
    .filter((ref) => ref.value && ["skill", "plugin", "path"].includes(ref.type))
    .map((ref) => ({
      type: ref.type,
      value: ref.value,
      ...(ref.label ? { label: ref.label } : {}),
      ...(ref.source ? { source: ref.source } : {})
    }))
    .filter((ref) => {
      const key = `${ref.type}:${ref.value}`.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function refMentionText(ref) {
  if (ref.type === "skill" || ref.type === "plugin") {
    const label = ref.type === "plugin" ? ref.label || ref.value : ref.value;
    const target = ref.source || ref.value;
    return `[$${label}](${target})`;
  }
  return ref.value;
}

function bodyWithMentions(body, refs) {
  const missing = refs
    .map(refMentionText)
    .filter((mention) => mention && !body.includes(mention));
  if (!missing.length) return body;
  return `${missing.join(" ")} ${body}`.trim();
}

function enrichRefs(root, refs) {
  if (!refs.length) return refs;
  const discovered = discoverRefs(root);
  const available = [...discovered.skills, ...discovered.plugins];
  return refs.map((ref) => {
    const match = available.find((entry) => entry.type === ref.type && entry.value === ref.value);
    if (!match) return ref;
    return {
      ...ref,
      label: ref.label || match.label,
      source: ref.source || match.source
    };
  });
}

function discoverRefs(root) {
  return {
    skills: uniqueRefs([
      ...discoverSkills(join(root, ".agents", "skills")),
      ...discoverSkills(join(homedir(), ".agents", "skills")),
      ...discoverSkills(join(homedir(), ".codex", "skills"))
    ]),
    plugins: uniquePluginRefs([
      ...discoverPlugins(join(root, ".codex", "plugins", "cache")),
      ...discoverPlugins(join(homedir(), ".codex", "plugins", "cache"))
    ].filter(isVisiblePluginRef))
  };
}

function discoverSkills(dir, depth = 0) {
  if (!existsSync(dir) || depth > 3) return [];
  const results = [];
  for (const entry of safeReaddir(dir)) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    const skillPath = join(path, "SKILL.md");
    if (existsSync(skillPath)) results.push(readSkillRef(skillPath, entry.name));
    results.push(...discoverSkills(path, depth + 1));
  }
  return results.slice(0, 200);
}

function readSkillRef(path, fallbackName) {
  const text = readFileSync(path, "utf8");
  const metadataPath = join(dirname(path), "agents", "openai.yaml");
  const metadata = existsSync(metadataPath) ? readFileSync(metadataPath, "utf8") : "";
  const name = frontMatterValue(text, "name") || fallbackName;
  const description = frontMatterValue(text, "description");
  return {
    type: "skill",
    value: name,
    label: yamlValue(metadata, "display_name") || formatDisplayName(name),
    detail: yamlValue(metadata, "short_description") || description
  };
}

function discoverPlugins(dir, depth = 0) {
  if (!existsSync(dir) || depth > 4) return [];
  const results = [];
  const manifestPath = join(dir, ".codex-plugin", "plugin.json");
  if (existsSync(manifestPath)) results.push(readPluginRef(manifestPath, basename(dir)));
  for (const entry of safeReaddir(dir)) {
    if (entry.isDirectory()) results.push(...discoverPlugins(join(dir, entry.name), depth + 1));
  }
  return results.slice(0, 100);
}

function readPluginRef(path, fallbackName) {
  try {
    const manifest = JSON.parse(stripBom(readFileSync(path, "utf8")));
    return {
      type: "plugin",
      value: manifest.name || fallbackName,
      label: manifest.interface?.displayName || manifest.name || fallbackName,
      detail: manifest.interface?.shortDescription || manifest.description || "",
      source: path
    };
  } catch {
    return { type: "plugin", value: fallbackName, label: fallbackName, detail: "", source: path };
  }
}

function isVisiblePluginRef(ref) {
  const source = ref.source.toLowerCase();
  return !source.includes("openai-primary-runtime") && !source.includes("openai-bundled-beta");
}

function uniqueRefs(refs) {
  const seen = new Set();
  return refs.filter((ref) => {
    const key = `${ref.type}:${ref.value}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniquePluginRefs(refs) {
  const seen = new Set();
  return refs.filter((ref) => {
    const key = (ref.label || ref.value).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function frontMatterValue(text, key) {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(new RegExp(`^${key}:\\s*(.*)$`));
    if (!match) continue;
    const value = stripOptionalQuotes(match[1].trim());
    if (value !== "|" && value !== ">") return value;
    const block = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      if (lines[next].startsWith("---")) break;
      if (!/^\s+/.test(lines[next]) && lines[next].trim()) break;
      const trimmed = lines[next].trim();
      if (trimmed) block.push(trimmed);
    }
    return block.join(" ").replace(/\s+/g, " ").trim();
  }
  return "";
}

function yamlValue(text, key) {
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(new RegExp(`^\\s*${key}:\\s*(.*)$`));
    if (match) return stripOptionalQuotes(match[1].trim());
  }
  return "";
}

function stripOptionalQuotes(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === `"` && last === `"`) || (first === "'" && last === "'")) {
      return value.slice(1, -1).trim();
    }
  }
  return value;
}

function formatDisplayName(value) {
  return String(value)
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
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
      position: relative;
      max-width: 980px;
      margin: 0 auto;
      border: 1px solid var(--line-strong);
      background: var(--panel);
      border-radius: 18px;
      box-shadow: 0 12px 30px rgba(15, 23, 42, .08);
      overflow: visible;
    }
    .attachments {
      display: none;
      gap: 10px;
      flex-wrap: wrap;
      align-items: flex-start;
      padding: 12px 12px 0;
    }
    .attachments.has-items { display: flex; }
    .reference-line {
      display: none;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
      padding: 0;
      flex: 0 1 auto;
    }
    .reference-line.has-items { display: flex; }
    .slash-palette {
      position: absolute;
      left: 0;
      right: 0;
      bottom: calc(100% + 10px);
      max-height: min(380px, calc(100vh - 210px));
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 0 8px 8px;
      background: rgba(255, 255, 255, .96);
      box-shadow: 0 18px 48px rgba(15, 23, 42, .14);
      z-index: 8;
      scroll-padding: 48px 0 16px;
    }
    .slash-palette[hidden] { display: none; }
    .slash-palette::-webkit-scrollbar {
      width: 10px;
    }
    .slash-palette::-webkit-scrollbar-track {
      background: transparent;
      margin: 10px 0;
    }
    .slash-palette::-webkit-scrollbar-thumb {
      background: rgba(107, 114, 128, .45);
      background-clip: content-box;
      border: 3px solid transparent;
      border-radius: 999px;
    }
    .slash-palette::-webkit-scrollbar-button {
      width: 0;
      height: 0;
      display: none;
    }
    .slash-group {
      position: sticky;
      top: 0;
      z-index: 1;
      margin: 0 -8px 4px;
      padding: 10px 20px 6px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 650;
      text-transform: uppercase;
      background: rgba(255, 255, 255, .96);
      backdrop-filter: blur(8px);
    }
    .slash-group:first-child {
      border-radius: 15px 15px 0 0;
    }
    .slash-item {
      display: grid;
      grid-template-columns: 24px minmax(0, 1fr) auto;
      gap: 12px;
      align-items: center;
      width: 100%;
      min-height: 46px;
      padding: 9px 12px;
      border-radius: 10px;
      text-align: left;
    }
    .slash-item:hover,
    .slash-item.active {
      background: var(--soft);
    }
    .slash-icon {
      display: grid;
      place-items: center;
      width: 24px;
      height: 24px;
      border-radius: 7px;
      color: var(--blue);
      background: #eff6ff;
    }
    .slash-text {
      min-width: 0;
      display: grid;
      grid-template-columns: max-content minmax(0, 1fr);
      gap: 8px;
      align-items: baseline;
    }
    .slash-label {
      min-width: 0;
      max-width: 240px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
      font-weight: 560;
    }
    .slash-detail {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--muted);
      font-size: 12px;
    }
    .slash-type {
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
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
    .reference-token {
      max-width: min(460px, 100%);
      padding: 0 1px;
      border-radius: 4px;
      color: #1d4ed8;
      background: transparent;
      font-size: 13px;
      font-weight: 650;
      line-height: inherit;
      vertical-align: baseline;
    }
    .reference-token:hover { background: #eff6ff; }
    .reference-token-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      place-items: center;
      width: 1em;
      height: 1em;
      margin-right: 3px;
      vertical-align: -0.12em;
    }
    .reference-token-icon svg,
    .slash-icon svg {
      width: 100%;
      height: 100%;
      display: block;
    }
    .reference-token-name {
      vertical-align: baseline;
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
    .message-editor {
      width: 100%;
      min-height: 74px;
      max-height: 240px;
      overflow-y: auto;
      border: 0;
      outline: 0;
      resize: none;
      padding: 16px 18px 8px;
      color: var(--text);
      font: inherit;
      line-height: 1.55;
      background: transparent;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .message-editor:empty::before {
      content: attr(data-placeholder);
      color: #9ca3af;
      pointer-events: none;
    }
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
    .icon-btn.active {
      background: #eff6ff;
      color: var(--blue);
    }
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
    .context-menu {
      position: fixed;
      z-index: 30;
      width: 190px;
      padding: 6px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: rgba(255, 255, 255, .98);
      box-shadow: 0 18px 48px rgba(15, 23, 42, .18), 0 2px 8px rgba(15, 23, 42, .08);
      color: var(--text);
    }
    .context-menu[hidden] { display: none; }
    .context-menu button {
      width: 100%;
      display: grid;
      grid-template-columns: 18px 1fr auto;
      align-items: center;
      gap: 9px;
      padding: 8px 9px;
      border-radius: 8px;
      color: inherit;
      font-size: 13px;
      text-align: left;
    }
    .context-menu button:hover,
    .context-menu button:focus-visible {
      background: var(--soft);
      outline: none;
    }
    .context-menu button:disabled {
      color: #cbd5e1;
      cursor: default;
    }
    .context-menu button:disabled:hover { background: transparent; }
    .context-menu svg {
      width: 16px;
      height: 16px;
      color: #64748b;
    }
    .context-shortcut {
      color: #94a3b8;
      font-size: 12px;
    }
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
      .slash-text { grid-template-columns: minmax(0, 1fr); gap: 2px; }
      .slash-label { max-width: none; }
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
        <div class="slash-palette" id="slashPalette" hidden></div>
        <div id="message" class="message-editor" contenteditable="true" role="textbox" aria-multiline="true" data-placeholder="发消息、追加任务，或拖入文件" spellcheck="false" autocorrect="off" autocapitalize="off" autocomplete="off"></div>
        <div class="toolbar">
          <div class="tools">
            <button class="icon-btn" id="fileButton" title="添加文件" aria-label="添加文件">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="m21.4 11.6-8.5 8.5a6 6 0 0 1-8.5-8.5l8.5-8.5a4 4 0 0 1 5.7 5.7l-8.6 8.5a2 2 0 1 1-2.8-2.8l8-8" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"></path>
              </svg>
            </button>
            <button class="icon-btn" id="skillButton" title="添加技能上下文" aria-label="添加技能上下文">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="m12 3 8 4.5-8 4.5-8-4.5L12 3Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"></path>
                <path d="m4 12 8 4.5 8-4.5M4 16.5l8 4.5 8-4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
              </svg>
            </button>
            <button class="icon-btn" id="pluginButton" title="添加插件上下文" aria-label="添加插件上下文">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M8 3h8v4h2a3 3 0 1 1 0 6h-2v8H8v-4H6a3 3 0 1 1 0-6h2V3Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"></path>
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
  <div class="context-menu" id="contextMenu" role="menu" aria-label="输入菜单" hidden>
    <button type="button" data-action="cut" role="menuitem">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4 6l16 12M4 18 20 6M5 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm0 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      </svg>
      <span>剪切</span><span class="context-shortcut">Ctrl+X</span>
    </button>
    <button type="button" data-action="copy" role="menuitem">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="8" y="8" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.8"/>
        <path d="M5 15V7a2 2 0 0 1 2-2h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      </svg>
      <span>复制</span><span class="context-shortcut">Ctrl+C</span>
    </button>
    <button type="button" data-action="paste" role="menuitem">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M9 5h6l1 2h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h2l1-2Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
        <path d="M9 11h6M9 15h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      </svg>
      <span>粘贴</span><span class="context-shortcut">Ctrl+V</span>
    </button>
    <button type="button" data-action="selectAll" role="menuitem">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="5" y="5" width="14" height="14" rx="2" stroke="currentColor" stroke-width="1.8" stroke-dasharray="3 3"/>
        <path d="M9 12h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      </svg>
      <span>全选</span><span class="context-shortcut">Ctrl+A</span>
    </button>
  </div>
  <script>
    const state = { files: [], refs: [], sessionId: 'default', draftLoaded: false };
    const slash = { entries: [], visible: [], active: 0, forced: false, filterType: null };
    const message = document.getElementById('message');
    const fileInput = document.getElementById('fileInput');
    const attachments = document.getElementById('attachments');
    const sendButton = document.getElementById('sendButton');
    const slashPalette = document.getElementById('slashPalette');
    const contextMenu = document.getElementById('contextMenu');
    const skillButton = document.getElementById('skillButton');
    const pluginButton = document.getElementById('pluginButton');
    const dropHint = document.getElementById('dropHint');
    const imageViewer = document.getElementById('imageViewer');
    const imageViewerImage = document.getElementById('imageViewerImage');
    const imageViewerTitle = document.getElementById('imageViewerTitle');

    async function api(path, options) {
      const res = await fetch(path, options);
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    }

    async function loadRefs() {
      const refs = await api('/api/refs');
      slash.entries = [
        ...(refs.skills || []).map(ref => ({ ...ref, group: '技能' })),
        ...(refs.plugins || []).map(ref => ({ ...ref, group: '插件' }))
      ];
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
      if (item.refs?.length) parts.push(item.refs.length + ' 个上下文提示');
      const attachmentText = parts.length ? parts.join(' · ') : '无附件';
      const body = item.body || '(空消息)';
      const bodyAlreadyMentionsRefs = (item.refs || []).some(ref => body.includes(referenceMentionText(ref)) || body.includes(ref.value));
      const refs = bodyAlreadyMentionsRefs ? '' : (item.refs || [])
        .map((ref, index) => renderReference({ id: 'queue-' + item.id + '-' + index, ...ref }))
        .join('');
      const title = (item.refs || []).map(ref => '[' + ref.type + ':' + ref.value + ']').join(' ') + (item.refs?.length ? ' ' : '') + body;
      return '<div class="queue-item">' +
        '<div class="queue-kind">' + escapeHtml(item.kind) + '</div>' +
        '<div class="queue-body" title="' + escapeHtml(title) + '">' + refs + (refs ? ' ' : '') + renderQueueBody(body, item.refs || [], item.id) + '</div>' +
        '<div class="queue-meta"><span>' + attachmentText + '</span><span class="dot"></span>' +
          '<button class="queue-cancel" type="button" title="取消队列项" aria-label="取消队列项" onclick="cancelQueueItem(&quot;' + escapeHtml(item.id) + '&quot;)">' +
            '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>' +
          '</button></div>' +
      '</div>';
    }

    function renderQueueBody(body, refs, itemId) {
      if (!refs.length) return escapeHtml(body);
      const segments = [{ type: 'text', text: body }];
      refs.forEach((ref, refIndex) => {
        const mention = referenceMentionText(ref);
        for (let index = 0; index < segments.length; index += 1) {
          const segment = segments[index];
          if (segment.type !== 'text' || !segment.text.includes(mention)) continue;
          const parts = segment.text.split(mention);
          const replacement = [];
          parts.forEach((part, partIndex) => {
            if (part) replacement.push({ type: 'text', text: part });
            if (partIndex < parts.length - 1) replacement.push({ type: 'ref', ref, refIndex });
          });
          segments.splice(index, 1, ...replacement);
          index += replacement.length - 1;
        }
      });
      return segments.map((segment, index) => {
        if (segment.type === 'text') return escapeHtml(segment.text);
        return renderReference({ id: 'queue-' + itemId + '-' + segment.refIndex + '-' + index, ...segment.ref });
      }).join('');
    }


    function renderAttachments() {
      attachments.classList.toggle('has-items', state.files.length > 0);
      attachments.innerHTML = state.files.map(renderAttachment).join('');
      updateSendState();
    }

    function renderReference(ref) {
      const meta = referenceMeta(ref);
      const title = escapeHtml(meta.title);
      return '<span class="reference-token" contenteditable="false" data-ref-id="' + escapeHtml(ref.id) + '" data-ref-type="' + escapeHtml(ref.type) + '" data-ref-value="' + escapeHtml(ref.value) + '" data-ref-label="' + escapeHtml(meta.label) + '" data-ref-source="' + escapeHtml(ref.source || '') + '" title="' + title + '">' +
        '<span class="reference-token-icon" aria-hidden="true">' + referenceIcon(ref.type) + '</span>' +
        '<span class="reference-token-name">' + escapeHtml(meta.label) + '</span>' +
      '</span>';
    }

    function referenceMeta(ref) {
      const entry = slash.entries.find(item => item.type === ref.type && item.value === ref.value);
      const label = ref.label || entry?.label || formatReferenceLabel(ref.value);
      const detail = ref.detail || entry?.detail || '';
      return { label, detail, title: detail ? label + ' - ' + detail : label };
    }

    function referenceMentionText(ref) {
      if (ref.type === 'skill' || ref.type === 'plugin') {
        const label = ref.type === 'plugin' ? (ref.label || ref.value) : ref.value;
        const target = ref.source || ref.value;
        return '[$' + label + '](' + target + ')';
      }
      return ref.value;
    }

    function formatReferenceLabel(value) {
      return String(value).split(/[-_:]+/).filter(Boolean).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
    }

    function referenceIcon(type) {
      if (type === 'plugin') {
        return '<svg viewBox="0 0 24 24" fill="none"><path d="M8 3h8v4h2a3 3 0 1 1 0 6h-2v8H8v-4H6a3 3 0 1 1 0-6h2V3Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"></path></svg>';
      }
      return '<svg viewBox="0 0 24 24" fill="none"><path d="m12 3 8 4.5-8 4.5-8-4.5L12 3Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"></path><path d="m4 12 8 4.5 8-4.5M4 16.5l8 4.5 8-4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
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

    window.removeRef = function removeRef(id) {
      state.refs = state.refs.filter(ref => ref.id !== id);
      Array.from(message.querySelectorAll('.reference-token'))
        .find(node => node.dataset.refId === id)
        ?.remove();
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

    function slashQuery() {
      if (slash.forced) return '';
      const before = textBeforeCursor();
      return before.match(/(?:^|\\s)\\/([^\\s/]*)$/)?.[1] ?? null;
    }

    function updateSlashPalette() {
      const query = slashQuery();
      if (query === null) {
        hideSlashPalette();
        return;
      }
      const normalized = query.toLowerCase();
      slash.visible = visibleSlashEntries(normalized, slash.filterType);
      slash.active = slash.visible.length ? Math.min(slash.active, slash.visible.length - 1) : 0;
      renderSlashPalette();
    }

    function visibleSlashEntries(query, type = null) {
      const matches = slash.entries
        .filter(entry => !type || entry.type === type)
        .filter(entry => [entry.label, entry.value, entry.detail].join(' ').toLowerCase().includes(query));
      if (query || type) return matches.slice(0, 24);
      const plugins = matches.filter(entry => entry.type === 'plugin').slice(0, 8);
      const skills = matches.filter(entry => entry.type === 'skill').slice(0, 14);
      return [...plugins, ...skills];
    }

    function renderSlashPalette() {
      slashPalette.hidden = slash.visible.length === 0;
      slashPalette.innerHTML = slash.visible.map((entry, index) => {
        const group = index === 0 || slash.visible[index - 1].group !== entry.group
          ? '<div class="slash-group">' + escapeHtml(entry.group) + '</div>'
          : '';
        return group + '<button class="slash-item' + (index === slash.active ? ' active' : '') + '" type="button" data-index="' + index + '">' +
          '<span class="slash-icon" aria-hidden="true">' + referenceIcon(entry.type) + '</span>' +
          '<span class="slash-text"><span class="slash-label">' + escapeHtml(entry.label || entry.value) + '</span><span class="slash-detail">' + escapeHtml(entry.detail || '') + '</span></span>' +
          '<span class="slash-type">' + (entry.type === 'skill' ? '技能' : '插件') + '</span>' +
        '</button>';
      }).join('');
      ensureActiveSlashItemVisible();
      updateToolActive();
    }

    function ensureActiveSlashItemVisible() {
      const active = slashPalette.querySelector('.slash-item.active');
      if (!active) return;
      const topInset = (slashPalette.querySelector('.slash-group')?.offsetHeight || 0) + 8;
      const bottomInset = 16;
      const itemTop = active.offsetTop;
      const itemBottom = itemTop + active.offsetHeight;
      const visibleTop = slashPalette.scrollTop + topInset;
      const visibleBottom = slashPalette.scrollTop + slashPalette.clientHeight - bottomInset;
      if (itemTop < visibleTop) {
        slashPalette.scrollTop = Math.max(0, itemTop - topInset);
      } else if (itemBottom > visibleBottom) {
        slashPalette.scrollTop = itemBottom - slashPalette.clientHeight + bottomInset;
      }
    }

    function hideSlashPalette() {
      slashPalette.hidden = true;
      slash.visible = [];
      slash.active = 0;
      slash.forced = false;
      slash.filterType = null;
      updateToolActive();
    }

    function openSlashPalette(type = null) {
      if (!slashPalette.hidden && slash.forced && slash.filterType === type) {
        hideSlashPalette();
        message.focus();
        return;
      }
      slash.forced = true;
      slash.filterType = type;
      slash.visible = visibleSlashEntries('', type);
      slash.active = 0;
      renderSlashPalette();
      updateToolActive();
      message.focus();
    }

    function updateToolActive() {
      skillButton.classList.toggle('active', !slashPalette.hidden && slash.filterType === 'skill');
      pluginButton.classList.toggle('active', !slashPalette.hidden && slash.filterType === 'plugin');
    }

    function selectSlashEntry(index = slash.active) {
      const entry = slash.visible[index];
      if (!entry) return;
      const ref = { id: crypto.randomUUID(), type: entry.type, value: entry.value, label: entry.label, detail: entry.detail, source: entry.source || '' };
      state.refs.push(ref);
      if (!slash.forced) deleteSlashQueryBeforeCursor();
      insertReferenceToken(ref);
      hideSlashPalette();
      renderAttachments();
      saveDraft();
      updateSendState();
      message.focus();
    }

    function pastedFilename(file) {
      const ext = file.type === 'image/jpeg' ? 'jpg' : file.type === 'image/webp' ? 'webp' : 'png';
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\\.\\d+Z$/, '').replace('T', '-');
      return 'pasted-' + stamp + '.' + ext;
    }

    async function sendMessage() {
      const body = editorPromptText().trim();
      const refs = currentEditorRefs();
      if (!body && !state.files.length && !refs.length) return;
      sendButton.disabled = true;
      const uploaded = await uploadFiles();
      await api('/api/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'message',
          body,
          files: uploaded.map(file => file.path),
          refs
        })
      });
      message.innerHTML = '';
      state.refs = [];
      clearFiles();
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
      const body = editorText();
      const files = serializableFiles();
      const refs = currentEditorRefs();
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
        message.textContent = draft.body || '';
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
              .map(ref => ({ id: ref.id || crypto.randomUUID(), type: ref.type || 'path', value: ref.value || '', label: ref.label || '', detail: ref.detail || '', source: ref.source || '' }))
              .filter(ref => ref.value)
          : [];
        for (const ref of state.refs) insertReferenceToken(ref, true);
        renderAttachments();
        updateSendState();
      } catch {
        clearDraft();
      }
    }

    function clearDraft() {
      localStorage.removeItem(draftKey());
    }

    function editorText() {
      const clone = message.cloneNode(true);
      clone.querySelectorAll('.reference-token').forEach(node => node.remove());
      return clone.textContent || '';
    }

    function editorPromptText() {
      const clone = message.cloneNode(true);
      const refs = currentEditorRefs();
      const byId = new Map(refs.map(ref => [ref.id, ref]));
      clone.querySelectorAll('.reference-token').forEach(node => {
        const ref = byId.get(node.dataset.refId) || {
          type: node.dataset.refType || 'path',
          value: node.dataset.refValue || '',
          label: node.dataset.refLabel || '',
          source: node.dataset.refSource || ''
        };
        node.replaceWith(document.createTextNode(referenceMentionText(ref)));
      });
      return (clone.textContent || '').replace(/\u00a0/g, ' ');
    }

    function currentEditorRefs() {
      const byId = new Map(state.refs.map(ref => [ref.id, ref]));
      const seen = new Set();
      return Array.from(message.querySelectorAll('.reference-token'))
        .map(node => byId.get(node.dataset.refId) || {
          id: node.dataset.refId || crypto.randomUUID(),
          type: node.dataset.refType || 'path',
          value: node.dataset.refValue || '',
          label: node.dataset.refLabel || node.textContent?.trim() || '',
          source: node.dataset.refSource || '',
          detail: ''
        })
        .filter(ref => ref.value && ['skill', 'plugin', 'path'].includes(ref.type))
        .filter(ref => {
          const key = ref.type + ':' + ref.value;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    }

    function textBeforeCursor() {
      const selection = window.getSelection();
      if (!selection?.rangeCount || !message.contains(selection.anchorNode)) return editorText();
      const range = selection.getRangeAt(0).cloneRange();
      const before = document.createRange();
      before.selectNodeContents(message);
      before.setEnd(range.endContainer, range.endOffset);
      const fragment = before.cloneContents();
      fragment.querySelectorAll?.('.reference-token').forEach(node => node.remove());
      return fragment.textContent || '';
    }

    function deleteSlashQueryBeforeCursor() {
      const before = textBeforeCursor();
      const match = before.match(/(?:^|\\s)\\/([^\\s/]*)$/);
      if (!match) return;
      const deleteCount = match[0].startsWith(' ') ? match[0].length - 1 : match[0].length;
      const selection = window.getSelection();
      if (!selection?.rangeCount) return;
      for (let index = 0; index < deleteCount; index += 1) selection.modify('extend', 'backward', 'character');
      document.execCommand('delete');
    }

    function insertReferenceToken(ref, atStart = false) {
      const template = document.createElement('template');
      template.innerHTML = renderReference(ref);
      const token = template.content.firstElementChild;
      const spacer = document.createTextNode('\\u00a0');
      if (atStart) {
        message.prepend(spacer);
        message.prepend(token);
        return;
      }
      const selection = window.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      if (!range || !message.contains(range.commonAncestorContainer)) {
        message.append(token, spacer);
        placeCursorAfter(spacer);
        return;
      }
      range.deleteContents();
      range.insertNode(spacer);
      range.insertNode(token);
      placeCursorAfter(spacer);
    }

    function placeCursorAfter(node) {
      const range = document.createRange();
      range.setStartAfter(node);
      range.collapse(true);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }

    function updateSendState() {
      sendButton.disabled = !editorText().trim() && state.files.length === 0 && currentEditorRefs().length === 0;
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function selectionInsideEditor() {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
      const range = selection.getRangeAt(0);
      return message.contains(range.commonAncestorContainer) || message === range.commonAncestorContainer;
    }

    function showContextMenu(event) {
      if (!message.contains(event.target) && event.target !== message) return;
      event.preventDefault();
      hideSlashPalette();
      message.focus();
      const hasSelection = selectionInsideEditor();
      contextMenu.querySelector('[data-action="cut"]').disabled = !hasSelection;
      contextMenu.querySelector('[data-action="copy"]').disabled = !hasSelection;
      contextMenu.hidden = false;
      const margin = 8;
      const width = contextMenu.offsetWidth || 190;
      const height = contextMenu.offsetHeight || 180;
      const left = Math.min(event.clientX, window.innerWidth - width - margin);
      const top = Math.min(event.clientY, window.innerHeight - height - margin);
      contextMenu.style.left = Math.max(margin, left) + 'px';
      contextMenu.style.top = Math.max(margin, top) + 'px';
    }

    function hideContextMenu() {
      contextMenu.hidden = true;
    }

    function selectEditorContents() {
      const range = document.createRange();
      range.selectNodeContents(message);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }

    async function runContextAction(action) {
      hideContextMenu();
      message.focus();
      if (action === 'selectAll') {
        selectEditorContents();
        return;
      }
      if (action === 'paste') {
        try {
          const text = await navigator.clipboard.readText();
          if (text) document.execCommand('insertText', false, text);
        } catch {
          document.execCommand('paste');
        }
      } else {
        document.execCommand(action);
      }
      setTimeout(() => {
        state.refs = currentEditorRefs();
        updateSendState();
        saveDraft();
      }, 0);
    }

    document.getElementById('fileButton').addEventListener('click', () => {
      hideSlashPalette();
      hideContextMenu();
      fileInput.click();
    });
    skillButton.addEventListener('click', () => openSlashPalette('skill'));
    pluginButton.addEventListener('click', () => openSlashPalette('plugin'));
    message.addEventListener('contextmenu', showContextMenu);
    contextMenu.addEventListener('mousedown', event => event.preventDefault());
    contextMenu.addEventListener('click', event => {
      const item = event.target.closest('button[data-action]');
      if (item && !item.disabled) runContextAction(item.dataset.action);
    });
    document.addEventListener('click', event => {
      if (!contextMenu.contains(event.target)) hideContextMenu();
    });
    window.addEventListener('blur', hideContextMenu);
    window.addEventListener('resize', hideContextMenu);
    window.addEventListener('scroll', hideContextMenu, true);
    slashPalette.addEventListener('click', event => {
      const item = event.target.closest('.slash-item');
      if (item) selectSlashEntry(Number(item.dataset.index));
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
      hideContextMenu();
      state.refs = currentEditorRefs();
      updateSendState();
      saveDraft();
      slash.forced = false;
      slash.filterType = null;
      updateSlashPalette();
    });
    message.addEventListener('keydown', event => {
      if (!slashPalette.hidden) {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          slash.active = Math.min(slash.active + 1, slash.visible.length - 1);
          renderSlashPalette();
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          slash.active = Math.max(slash.active - 1, 0);
          renderSlashPalette();
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          selectSlashEntry();
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          hideSlashPalette();
          return;
        }
      }
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
    loadRefs().catch(console.error);
    refresh();
    setInterval(refresh, 3000);
  </script>
</body>
</html>`;
}

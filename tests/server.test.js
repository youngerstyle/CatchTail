import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createServer, systemOpenCommand } from "../src/server.js";

async function withServer(t, callback, options = {}) {
  let root;
  let server;
  let port;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    root = mkdtempSync(join(tmpdir(), "catchtail-server-"));
    server = createServer({ root, ...options });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
    if (!FETCH_BLOCKED_PORTS.has(port)) break;
    await new Promise((resolve) => server.close(resolve));
  }
  t.after(() => server.close());
  await callback(`http://127.0.0.1:${port}`, root);
}

const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697,
  10080
]);

test("server accepts messages and exposes queue", async (t) => {
  await withServer(t, async (base) => {
    const created = await fetch(`${base}/api/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "继续跑下一步", kind: "task" })
    });

    assert.equal(created.status, 200);
    const queue = await (await fetch(`${base}/api/queue?sessionId=default`)).json();

    assert.equal(queue.items[0].body, "继续跑下一步");
    assert.equal(queue.items[0].kind, "task");
  });
});

test("server updates milestone only", async (t) => {
  await withServer(t, async (base) => {
    await fetch(`${base}/api/milestone`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ milestone: "completed" })
    });

    const state = await (await fetch(`${base}/api/state`)).json();

    assert.equal(state.interactive.milestone, "completed");
  });
});

test("server long-poll wait resolves when a message arrives", async (t) => {
  await withServer(t, async (base) => {
    const waiting = fetch(`${base}/api/wait?timeoutMs=1000`).then((res) =>
      res.json()
    );

    await fetch(`${base}/api/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "唤醒", kind: "message" })
    });

    const result = await waiting;

    assert.equal(result.ok, true);
    assert.equal(result.reason, "message");
  });
});

test("server wait returns immediately when queue already has work", async (t) => {
  await withServer(t, async (base) => {
    const created = await (
      await fetch(`${base}/api/messages?sessionId=target`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "already queued", kind: "message" })
      })
    ).json();

    const result = await (await fetch(`${base}/api/wait?sessionId=target&timeoutMs=1000`)).json();

    assert.deepEqual(result, {
      ok: true,
      reason: "queued",
      id: created.id,
      sessionId: "target"
    });
  });
});

test("server long-poll wait can be scoped to a session", async (t) => {
  await withServer(t, async (base) => {
    let resolved = false;
    const waiting = fetch(`${base}/api/wait?sessionId=target&timeoutMs=1000`)
      .then((res) => res.json())
      .then((payload) => {
        resolved = true;
        return payload;
      });

    await fetch(`${base}/api/messages?sessionId=other`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "wrong session", kind: "message" })
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(resolved, false);

    await fetch(`${base}/api/messages?sessionId=target`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "right session", kind: "message" })
    });

    const result = await waiting;

    assert.equal(result.ok, true);
    assert.equal(result.reason, "message");
    assert.equal(result.sessionId, "target");
  });
});

test("server long-poll wait times out cleanly", async (t) => {
  await withServer(t, async (base) => {
    const result = await (await fetch(`${base}/api/wait?timeoutMs=20`)).json();

    assert.equal(result.ok, false);
    assert.equal(result.reason, "timeout");
  });
});

test("server can target a specific session id", async (t) => {
  await withServer(t, async (base) => {
    await fetch(`${base}/api/messages?sessionId=session-web`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "web session", kind: "message" })
    });

    const queue = await (
      await fetch(`${base}/api/queue?sessionId=session-web`)
    ).json();
    const defaultQueue = await (await fetch(`${base}/api/queue?sessionId=default`)).json();

    assert.equal(queue.items[0].body, "web session");
    assert.equal(defaultQueue.items.length, 0);
  });
});

test("server exposes queue and session history separately", async (t) => {
  await withServer(t, async (base) => {
    await fetch(`${base}/api/messages?sessionId=session-history`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "history item", kind: "message" })
    });

    const queue = await (
      await fetch(`${base}/api/queue?sessionId=session-history`)
    ).json();
    const session = await (
      await fetch(`${base}/api/session?sessionId=session-history`)
    ).json();

    assert.equal(queue.items.length, 1);
    assert.equal(queue.items[0].body, "history item");
    assert.equal(session.items.at(-1).body, "history item");
  });
});

test("server exposes third-party queue operations", async (t) => {
  await withServer(t, async (base) => {
    const preflight = await fetch(`${base}/api/queue?sessionId=external`, {
      method: "OPTIONS",
      headers: { "access-control-request-method": "POST" }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "*");

    const created = await (
      await fetch(`${base}/api/queue?sessionId=external`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "external message", kind: "message", files: ["note.txt"] })
      })
    ).json();
    assert.equal(created.ok, true);

    const queueResponse = await fetch(`${base}/api/queue?sessionId=external`);
    assert.equal(queueResponse.headers.get("access-control-allow-origin"), "*");
    const queue = await queueResponse.json();
    assert.equal(queue.items.length, 1);
    assert.equal(queue.items[0].body, "external message");

    const claimed = await (
      await fetch(`${base}/api/queue/claim?sessionId=external`, { method: "POST" })
    ).json();
    assert.equal(claimed.item.id, created.id);

    const completed = await (
      await fetch(`${base}/api/queue/complete?sessionId=external`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: claimed.item.id, response: "handled" })
      })
    ).json();
    assert.equal(completed.ok, true);

    const empty = await (await fetch(`${base}/api/queue?sessionId=external`)).json();
    assert.equal(empty.items.length, 0);
  });
});

test("server validates third-party queue completion", async (t) => {
  await withServer(t, async (base) => {
    const response = await fetch(`${base}/api/queue/complete?sessionId=external`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });

    assert.equal(response.status, 400);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    const payload = await response.json();
    assert.equal(payload.ok, false);
  });
});

test("server cancels queued items through third-party queue API", async (t) => {
  await withServer(t, async (base) => {
    const created = await (
      await fetch(`${base}/api/queue?sessionId=cancel-session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "cancel me" })
      })
    ).json();

    const cancelled = await (
      await fetch(`${base}/api/queue/cancel?sessionId=cancel-session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: created.id, reason: "no longer needed" })
      })
    ).json();

    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.item.id, created.id);
    const queue = await (await fetch(`${base}/api/queue?sessionId=cancel-session`)).json();
    assert.equal(queue.items.length, 0);
  });
});

test("server reports missing queue item on cancel", async (t) => {
  await withServer(t, async (base) => {
    const response = await fetch(`${base}/api/queue/cancel?sessionId=cancel-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "missing" })
    });

    assert.equal(response.status, 404);
    const payload = await response.json();
    assert.equal(payload.ok, false);
  });
});

test("third-party queue requires an explicit session", async (t) => {
  await withServer(t, async (base) => {
    const response = await fetch(`${base}/api/queue`, { method: "POST" });

    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.match(payload.error, /Missing required sessionId/);
  });
});

test("server saves uploaded files and returns readable paths", async (t) => {
  await withServer(t, async (base) => {
    const form = new FormData();
    form.append("files", new Blob(["hello upload"], { type: "text/plain" }), "note.txt");

    const result = await (
      await fetch(`${base}/api/files?sessionId=file-session`, {
        method: "POST",
        body: form
      })
    ).json();

    assert.equal(result.ok, true);
    assert.equal(result.files.length, 1);
    assert.match(result.files[0].path, /note\.txt$/);
    assert.equal(existsSync(result.files[0].path), true);
    assert.equal(readFileSync(result.files[0].path, "utf8"), "hello upload");

    const downloaded = await fetch(`${base}/api/file?path=${encodeURIComponent(result.files[0].path)}`);
    assert.equal(downloaded.status, 200);
    assert.match(downloaded.headers.get("content-type"), /text\/plain/);
    assert.equal(await downloaded.text(), "hello upload");
  });
});

test("server opens uploaded files with injected default opener", async (t) => {
  const opened = [];
  await withServer(t, async (base) => {
    const form = new FormData();
    form.append("files", new Blob(["deck"], { type: "application/vnd.ms-powerpoint" }), "deck.ppt");

    const upload = await (
      await fetch(`${base}/api/files?sessionId=open-session`, {
        method: "POST",
        body: form
      })
    ).json();

    const openedResponse = await (
      await fetch(`${base}/api/open?sessionId=open-session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: upload.files[0].path })
      })
    ).json();

    assert.equal(openedResponse.ok, true);
    assert.deepEqual(opened, [upload.files[0].path]);
  }, {
    openFile: (path) => opened.push(path)
  });
});

test("server refuses to open files outside uploads", async (t) => {
  await withServer(t, async (base, root) => {
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "nope");

    const response = await fetch(`${base}/api/open?sessionId=open-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: outside })
    });

    assert.equal(response.status, 500);
    const payload = await response.json();
    assert.match(payload.error, /outside CatchTail uploads/);
  });
});

test("system default opener selects the platform command", () => {
  assert.deepEqual(systemOpenCommand("C:\\tmp\\note.json", "win32"), {
    command: "rundll32.exe",
    args: ["url.dll,FileProtocolHandler", "C:\\tmp\\note.json"]
  });
  assert.deepEqual(systemOpenCommand("/tmp/note.json", "darwin"), {
    command: "open",
    args: ["/tmp/note.json"]
  });
  assert.deepEqual(systemOpenCommand("/tmp/note.json", "linux"), {
    command: "xdg-open",
    args: ["/tmp/note.json"]
  });
});

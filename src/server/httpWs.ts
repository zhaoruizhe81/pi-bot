import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { WebSocketServer } from "ws";

const readJson = (req) =>
  new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });

const sendJson = (res, status, value) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
};

/**
 * A download. `filename` is sent twice: an ASCII fallback for old clients plus RFC 5987
 * UTF-8, so Chinese file names survive. `inline` is only used for text previews.
 */
const sendFile = (res, { filename, contentType, content, buffer, inline = false }) => {
  const ascii = String(filename).replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename);
  res.writeHead(200, {
    "content-type": contentType,
    "content-disposition": `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encoded}`,
    "cache-control": "no-store",
  });
  res.end(buffer ?? Buffer.from(String(content ?? ""), "utf8"));
};

/** Extension -> content-type for the static bundle (dist and the legacy web/ fallback). */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};
const contentTypeFor = (name) => MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream";

/** Resolve `rel` under `root`, or undefined when it would escape it (`..`, absolute). */
const safeJoin = (root, rel) => {
  if (!root) return undefined;
  const base = path.resolve(root);
  const target = path.resolve(base, rel);
  if (target !== base && !target.startsWith(base + path.sep)) return undefined;
  return target;
};

/** Read a regular file under `dir`; undefined when it is missing, a directory, or unsafe. */
const readStaticFrom = async (dir, rel) => {
  const target = safeJoin(dir, rel);
  if (!target) return undefined;
  try {
    const info = await stat(target);
    if (!info.isFile()) return undefined;
    return { buffer: await readFile(target), type: contentTypeFor(target) };
  } catch {
    return undefined;
  }
};

const readOnlyReject = (res) => {
  sendJson(res, 403, { error: "read-only viewer: this process does not accept writes" });
};

/** Shared error mapping for the group-context writes, so the UI can show the reason verbatim. */
const guard = async (res, run) => {
  try {
    sendJson(res, 200, await run());
  } catch (error) {
    const message = String(error?.message ?? error);
    const status = message.startsWith("unknown group")
      ? 404
      : message.includes("invalid bridge token") || message.includes("bridge is disabled")
        ? 403
        : message.startsWith("unknown bot") || message.startsWith("bot busy") || message.includes("is required")
          ? 409
          : 400;
    sendJson(res, status, { error: message });
  }
};

export async function startServer(options, deps) {
  const readOnly = options.readOnly === true;
  const startedAt = Date.now();
  const host = options.host ?? "127.0.0.1";
  /** Browsers currently connected over WS, newest first; shown on the 手机和设备 page. */
  const clients = new Map();
  /** Same browser on the same address collapses into one row with a connection count. */
  const clientList = () => {
    const grouped = new Map();
    for (const client of [...clients.values()].sort((a, b) => b.lastAt - a.lastAt)) {
      const key = `${client.ip}|${client.ua}`;
      const seen = grouped.get(key);
      if (seen) seen.connections += 1;
      else grouped.set(key, { ...client, connections: 1 });
    }
    return [...grouped.values()].slice(0, 10);
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean); // e.g. ["api","groups","g1","items"]

      if (req.method === "GET" && url.pathname === "/api/groups") {
        res.setHeader("cache-control", "no-store");
        sendJson(res, 200, { groups: await deps.groups() });
        return;
      }

      // Every bot that exists, so the members sheet can offer candidates the group lacks.
      if (req.method === "GET" && url.pathname === "/api/bots") {
        res.setHeader("cache-control", "no-store");
        sendJson(res, 200, { bots: deps.bots(), capabilities: deps.botCapabilities?.() ?? [] });
        return;
      }

      // Installed skills: the catalogue the bot panels toggle per bot.
      if (req.method === "GET" && url.pathname === "/api/skills") {
        res.setHeader("cache-control", "no-store");
        sendJson(res, 200, await deps.listSkills());
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/profile") {
        res.setHeader("cache-control", "no-store");
        sendJson(res, 200, await deps.getProfile());
        return;
      }

      if (readOnly && req.method !== "GET") {
        readOnlyReject(res);
        return;
      }

      // IM bridge: token in the path, no cookie; usable by a WeCom bot or a small relay.
      if (parts[0] === "api" && parts[1] === "im" && parts[2]) {
        const groupId = decodeURIComponent(parts[2]);
        if (req.method === "POST" && parts.length === 4) {
          const token = decodeURIComponent(parts[3]);
          const body = await readJson(req);
          await guard(res, () => deps.imInbound(groupId, token, body));
          return;
        }
        if (req.method === "GET" && parts.length === 5 && parts[4] === "outbox") {
          const token = decodeURIComponent(parts[3]);
          const since = Number(url.searchParams.get("since") ?? 0);
          await guard(res, () => deps.imOutbox(groupId, token, since));
          return;
        }
      }

      if (req.method === "PUT" && url.pathname === "/api/profile") {
        const body = await readJson(req);
        await guard(res, () => deps.updateProfile(body));
        return;
      }

      // Create a bot (optionally join it to one group in the same call).
      if (req.method === "POST" && url.pathname === "/api/bots") {
        const body = await readJson(req);
        await guard(res, () => deps.createBot(body));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/settings") {
        res.setHeader("cache-control", "no-store");
        sendJson(res, 200, await deps.getSettings());
        return;
      }

      if (req.method === "PUT" && url.pathname === "/api/settings") {
        const body = await readJson(req);
        await guard(res, () => deps.updateSettings(body));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/settings/check") {
        await guard(res, () => deps.checkSettings());
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/devices") {
        res.setHeader("cache-control", "no-store");
        const network = await deps.network();
        const port = options.port;
        // Only advertise URLs that the current bind address actually serves.
        const urls = [{ label: "本机", url: `http://127.0.0.1:${port}` }];
        if (host !== "127.0.0.1") {
          for (const entry of network.lan) urls.push({ label: entry.iface, url: `http://${entry.address}:${port}` });
          if (network.tailscale?.ready) {
            for (const ip of network.tailscale.ips ?? []) urls.push({ label: "tailnet", url: `http://${ip}:${port}` });
          }
        }
        const seen = new Set();
        const uniqueUrls = urls.filter((entry) => (seen.has(entry.url) ? false : seen.add(entry.url)));
        sendJson(res, 200, { ...network, bindHost: host, port, urls: uniqueUrls, clients: clientList() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/tailscale/serve") {
        const body = await readJson(req);
        const on = body.enabled !== false;
        await guard(res, () => (on ? deps.enableServe() : deps.disableServe()));
        return;
      }

      if (req.method === "PUT" && url.pathname === "/api/network") {
        const body = await readJson(req);
        await guard(res, async () => {
          const result = await deps.updateNetwork(body);
          return { ...result, bindHost: host, port: options.port };
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/status") {
        res.setHeader("cache-control", "no-store");
        const status = await deps.status();
        sendJson(res, 200, { ...status, port: options.port, bindHost: host, uptimeMs: Date.now() - startedAt });
        return;
      }

      // POST /api/dm/:botId/open — find-or-create the 1:1 DM group with one bot.
      // Top-level on purpose (not under /api/groups); an unknown bot answers 404.
      if (req.method === "POST" && parts[0] === "api" && parts[1] === "dm" && parts[2] && parts[3] === "open" && parts.length === 4) {
        const botId = decodeURIComponent(parts[2]);
        try {
          sendJson(res, 200, await deps.openDm(botId));
        } catch (error) {
          const message = String(error?.message ?? error);
          sendJson(res, message.startsWith("unknown bot") ? 404 : 400, { error: message });
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/groups") {
        const body = await readJson(req);
        const name = String(body.name ?? "").trim();
        if (!name) {
          sendJson(res, 400, { error: "name is required" });
          return;
        }
        sendJson(res, 201, { group: await deps.createGroup(name) });
        return;
      }

      if (req.method === "GET" && parts[0] === "api" && parts[1] === "groups" && parts[2] && parts.length === 3) {
        const detail = await deps.groupDetail(decodeURIComponent(parts[2]));
        if (!detail) {
          sendJson(res, 404, { error: `unknown group: ${parts[2]}` });
          return;
        }
        sendJson(res, 200, detail);
        return;
      }

      // /api/groups/:id (PUT) — rename
      if (req.method === "PUT" && parts[0] === "api" && parts[1] === "groups" && parts[2] && parts.length === 3) {
        const groupId = decodeURIComponent(parts[2]);
        const body = await readJson(req);
        await guard(res, () => deps.renameGroup(groupId, body.name));
        return;
      }

      // /api/groups/:id/items | /send | /requirements
      if (parts[0] === "api" && parts[1] === "groups" && parts[2] && parts[3]) {
        const groupId = decodeURIComponent(parts[2]);
        const action = parts[3];
        if (req.method === "GET" && action === "items") {
          const limit = Number(url.searchParams.get("limit") ?? 100);
          const beforeParam = url.searchParams.get("before");
          let before;
          if (beforeParam) {
            try {
              before = JSON.parse(beforeParam);
            } catch {
              sendJson(res, 400, { error: "before must be a cursor returned by this endpoint" });
              return;
            }
          }
          const page = await deps.items(groupId, { limit, before });
          if (!page) {
            sendJson(res, 404, { error: `unknown group: ${groupId}` });
            return;
          }
          sendJson(res, 200, { items: page.items, next: page.next ?? null });
          return;
        }
        // /api/groups/:id/work/:workId/cancel
        if (req.method === "POST" && parts.length === 6 && parts[3] === "work" && parts[5] === "cancel") {
          const workId = decodeURIComponent(parts[4]);
          try {
            const result = await deps.cancel(groupId, workId);
            sendJson(res, 200, result);
          } catch (error) {
            if (String(error?.message ?? error).startsWith("unknown group")) {
              sendJson(res, 404, { error: `unknown group: ${groupId}` });
              return;
            }
            throw error;
          }
          return;
        }
        // /api/groups/:id/members[/:botId]
        if (action === "members") {
          if (req.method === "POST" && parts.length === 4) {
            const body = await readJson(req);
            const botId = String(body.botId ?? body.id ?? "").trim();
            if (!botId) {
              sendJson(res, 400, { error: "botId is required" });
              return;
            }
            try {
              sendJson(res, 200, await deps.addMember(groupId, botId));
            } catch (error) {
              const message = String(error?.message ?? error);
              sendJson(res, message.startsWith("unknown group") ? 404 : 409, { error: message });
            }
            return;
          }
          if (req.method === "DELETE" && parts.length === 5) {
            const botId = decodeURIComponent(parts[4]);
            try {
              sendJson(res, 200, await deps.removeMember(groupId, botId));
            } catch (error) {
              const message = String(error?.message ?? error);
              sendJson(res, message.startsWith("unknown group") ? 404 : 409, { error: message });
            }
            return;
          }
        }
        // /api/groups/:id/im — bridge config | /im/rotate
        if (action === "im" && parts.length === 4 && req.method === "GET") {
          await guard(res, () => deps.imConfig(groupId));
          return;
        }
        if (action === "im" && parts.length === 5 && parts[4] === "rotate" && req.method === "POST") {
          await guard(res, () => deps.imRotate(groupId));
          return;
        }
        if (action === "im" && parts.length === 4 && req.method === "PUT") {
          const body = await readJson(req);
          await guard(res, () => deps.imUpdate(groupId, body));
          return;
        }

        // /api/groups/:id/bots/:botId — one bot's panel; PUT edits its prompt/model
        if (action === "bots" && parts[4] && parts.length === 5) {
          const botId = decodeURIComponent(parts[4]);
          if (req.method === "GET") {
            res.setHeader("cache-control", "no-store");
            await guard(res, () => deps.botProfile(groupId, botId));
            return;
          }
          if (req.method === "PUT") {
            const body = await readJson(req);
            await guard(res, () => deps.updateBotProfile(groupId, botId, body));
            return;
          }
        }

        // /api/groups/:id/bots/:botId/memory[/:memId] — one bot's long-term memory
        if (action === "bots" && parts[4] && parts[5] === "memory") {
          const botId = decodeURIComponent(parts[4]);
          if (req.method === "GET" && parts.length === 6) {
            res.setHeader("cache-control", "no-store");
            await guard(res, () => deps.getMemory(groupId, botId));
            return;
          }
          if (req.method === "POST" && parts.length === 6) {
            const body = await readJson(req);
            await guard(res, () => deps.addMemory(groupId, botId, { text: body.text, kind: body.kind }));
            return;
          }
          if (req.method === "PUT" && parts.length === 6) {
            const body = await readJson(req);
            await guard(res, () => deps.setMemoryEnabled(groupId, botId, body.enabled !== false));
            return;
          }
          if (req.method === "DELETE" && parts.length === 7) {
            await guard(res, () => deps.removeMemory(groupId, botId, decodeURIComponent(parts[6])));
            return;
          }
        }

        // /api/groups/:id/bots/:botId/skills — toggle one installed skill for one bot
        if (action === "bots" && parts[4] && parts[5] === "skills" && req.method === "PUT" && parts.length === 6) {
          const botId = decodeURIComponent(parts[4]);
          const body = await readJson(req);
          await guard(res, () => deps.setBotSkill(groupId, botId, body));
          return;
        }

        // /api/groups/:id/announcement — the shared notice every bot reads
        if (action === "announcement" && req.method === "PUT" && parts.length === 4) {
          const body = await readJson(req);
          await guard(res, () => deps.setAnnouncement(groupId, body.text ?? body.announcement ?? ""));
          return;
        }
        // /api/groups/:id/pins[/:pinId] — shared pins every bot reads
        if (action === "pins") {
          if (req.method === "POST" && parts.length === 4) {
            const body = await readJson(req);
            await guard(res, () => deps.addPin(groupId, { text: body.text, by: body.by }));
            return;
          }
          if (req.method === "DELETE" && parts.length === 5) {
            await guard(res, () => deps.removePin(groupId, decodeURIComponent(parts[4])));
            return;
          }
        }
        // /api/groups/:id/uploads — a file from the composer (base64 JSON, capped in the store)
        if (action === "uploads" && parts.length === 4) {
          if (req.method === "POST") {
            const body = await readJson(req);
            await guard(res, () => deps.sendFile(groupId, body));
            return;
          }
        }
        if (action === "uploads" && req.method === "GET" && parts.length === 5) {
          const id = decodeURIComponent(parts[4]);
          try {
            const file = await deps.uploadFile(groupId, id);
            sendFile(res, {
              filename: String(url.searchParams.get("name") ?? "file"),
              contentType: String(url.searchParams.get("mime") ?? "application/octet-stream"),
              buffer: file.buffer,
              inline: url.searchParams.get("inline") === "1",
            });
          } catch (error) {
            sendJson(res, 404, { error: String(error?.message ?? error) });
          }
          return;
        }

        // /api/groups/:id/files/:workId/<path...> — one archived deliverable
        if (req.method === "GET" && action === "files" && parts.length >= 6) {
          const workId = decodeURIComponent(parts[4]);
          const relative = parts
            .slice(5)
            .map((part) => decodeURIComponent(part))
            .join("/");
          try {
            const file = await deps.fileFor(groupId, workId, relative);
            const textish = /\.(md|txt|json|csv|tsv|ya?ml|diff|patch|ts|js|mjs|py|html|css|sql|sh)$/i.test(file.path);
            sendFile(res, {
              filename: file.path.split("/").pop() ?? file.path,
              contentType: textish ? "text/plain; charset=utf-8" : "application/octet-stream",
              buffer: file.buffer,
              inline: textish && url.searchParams.get("inline") === "1",
            });
          } catch (error) {
            const message = String(error?.message ?? error);
            sendJson(res, /^invalid /.test(message) ? 400 : 404, { error: message });
          }
          return;
        }

        // /api/groups/:id/export?format=md|json — the whole group history as one file
        if (req.method === "GET" && action === "export") {
          const format = url.searchParams.get("format") === "json" ? "json" : "md";
          try {
            const doc = await deps.exportGroup(groupId, format);
            sendFile(res, doc);
          } catch (error) {
            sendJson(res, 404, { error: String(error?.message ?? error) });
          }
          return;
        }

        if (req.method === "POST" && (action === "send" || action === "requirements")) {
          const body = await readJson(req);
          const type = action === "send" ? "send" : "requirement";
          try {
            await deps.submit(groupId, {
              type,
              text: String(body.text ?? body.message ?? ""),
              // Optional author: seeding scripts and future IM adapters speak as other people.
              ...(body.author && typeof body.author === "object" ? { author: body.author } : {}),
              ...(typeof body.at === "number" ? { at: body.at } : {}),
            });
          } catch (error) {
            if (String(error?.message ?? error).startsWith("unknown group")) {
              sendJson(res, 404, { error: `unknown group: ${groupId}` });
              return;
            }
            throw error;
          }
          sendJson(res, 200, {});
          return;
        }
      }

      if (req.method === "GET" && url.pathname === "/favicon.ico") {
        const icon = (await readStaticFrom(options.staticDir, "favicon.ico")) ?? (await readStaticFrom(options.fallbackStaticDir, "favicon.ico"));
        if (icon) {
          res.writeHead(200, { "content-type": icon.type, "cache-control": "public, max-age=86400" });
          res.end(icon.buffer);
          return;
        }
        // No icon shipped; answer so the browser does not log a 404 on every load.
        res.writeHead(204);
        res.end();
        return;
      }

      // Static hosting: webui/dist first, then the legacy bot/web fallback. Unknown GET
      // routes that are not API/stream fall back to index.html so the SPA can route.
      const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
      if (req.method === "GET" && !isApi && url.pathname !== "/stream") {
        let rel;
        try {
          rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
        } catch {
          res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          res.end("bad path");
          return;
        }
        const file = rel
          ? (await readStaticFrom(options.staticDir, rel)) ?? (await readStaticFrom(options.fallbackStaticDir, rel))
          : undefined;
        if (file) {
          const immutable = rel.startsWith("assets/");
          res.writeHead(200, { "content-type": file.type, "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" });
          res.end(file.buffer);
          return;
        }
        // A missing hashed asset is a real 404; a missing route is the SPA entry.
        if (!rel.startsWith("assets/")) {
          const index = (await readStaticFrom(options.staticDir, "index.html")) ?? (await readStaticFrom(options.fallbackStaticDir, "index.html"));
          if (index) {
            res.writeHead(200, { "content-type": index.type, "cache-control": "no-cache" });
            res.end(index.buffer);
            return;
          }
        }
      }

      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(String(error?.stack ?? error));
    }
  });

  const wss = new WebSocketServer({ server, path: "/stream" });
  wss.on("connection", async (ws, req) => {
    const clientId = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    clients.set(clientId, {
      id: clientId,
      ip: String(req.socket.remoteAddress ?? "").replace(/^::ffff:/, ""),
      ua: String(req.headers["user-agent"] ?? "").slice(0, 160),
      connectedAt: Date.now(),
      lastAt: Date.now(),
    });
    ws.on("message", () => {
      const entry = clients.get(clientId);
      if (entry) entry.lastAt = Date.now();
    });
    ws.on("close", () => clients.delete(clientId));
    const send = (frame) => {
      try {
        ws.send(JSON.stringify(frame));
      } catch {
        /* the socket is closing; its close handler detaches the watches */
      }
    };
    const url = new URL(req.url ?? "/", "http://localhost");
    const groupId = url.searchParams.get("g") ?? url.searchParams.get("group") ?? undefined;

    let offGroup;
    try {
      // `groups` first: the page needs the roster before it can name the active group.
      const offGroups = await deps.watchGroups(send);
      if (groupId) offGroup = await deps.watchGroup(groupId, send);

      ws.on("message", async (raw) => {
        if (readOnly) {
          send({ type: "error", error: "read-only viewer" });
          return;
        }
        try {
          const frame = JSON.parse(raw.toString());
          if (frame.type !== "send" && frame.type !== "requirement") return;
          if (!groupId) {
            send({ type: "error", error: "connect with ?g=<groupId>" });
            return;
          }
          await deps.submit(groupId, {
            type: frame.type,
            text: String(frame.text ?? ""),
            ...(frame.author && typeof frame.author === "object" ? { author: frame.author } : {}),
            ...(typeof frame.at === "number" ? { at: frame.at } : {}),
          });
        } catch (error) {
          send({ type: "error", error: String(error?.message ?? error) });
        }
      });

      ws.on("close", () => {
        clients.delete(clientId);
        void offGroup?.();
        offGroups?.();
      });
    } catch (error) {
      send({ type: "error", error: String(error?.message ?? error) });
      ws.close();
    }
  });

  await new Promise((resolve) => server.listen(options.port, host, resolve));
  return {
    port: options.port,
    close: async () => {
      for (const client of wss.clients) client.close();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

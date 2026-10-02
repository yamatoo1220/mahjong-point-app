import { DurableObject } from "cloudflare:workers";
import { sanitizeInitialState, sanitizePatch, sanitizeGame } from "./validate.js";

const ROOM_ID_PATTERN = /^\d{4}$/;
const ROOM_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 最終更新から7日で削除
const MAX_HISTORY = 200;
const MAX_MESSAGE_BYTES = 64 * 1024;
const CREATE_RETRY = 30;

// ==========================================
// Worker（ルーム作成 & WebSocket 振り分け）
// ==========================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const cors = corsHeaders(origin, url, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });
    }
    if (origin && !cors) {
      return json({ error: "origin_not_allowed" }, 403);
    }

    if (url.pathname === "/api/rooms" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "bad_json" }, 400, cors);
      }
      const initial = sanitizeInitialState(body?.state);
      if (!initial) return json({ error: "bad_state" }, 400, cors);

      // 空いている番号が見つかるまで再抽選
      for (let i = 0; i < CREATE_RETRY; i++) {
        const roomId = String(1000 + Math.floor(Math.random() * 9000));
        const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
        const result = await stub.create(initial);
        if (result.ok) return json({ roomId, hostToken: result.hostToken }, 201, cors);
      }
      return json({ error: "no_room_available" }, 503, cors);
    }

    const wsMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/ws$/);
    if (wsMatch) {
      if (!ROOM_ID_PATTERN.test(wsMatch[1])) return json({ error: "bad_room_id" }, 400, cors);
      if (request.headers.get("Upgrade") !== "websocket") return json({ error: "expected_websocket" }, 426, cors);
      const stub = env.ROOMS.get(env.ROOMS.idFromName(wsMatch[1]));
      return stub.fetch(request);
    }

    return json({ error: "not_found" }, 404, cors);
  }
};

function corsHeaders(origin, url, env) {
  if (!origin) return {};
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (origin !== url.origin && !allowed.includes(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers }
  });
}

function randomToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, c => ({ "+": "-", "/": "_", "=": "" }[c]));
}

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

// ==========================================
// Durable Object（1ルーム = 1インスタンス）
// ==========================================
export class Room extends DurableObject {
  // ルーム作成。既に使用中なら ok:false
  async create(initial) {
    const existing = await this.ctx.storage.get("state");
    if (existing) return { ok: false };

    const hostToken = randomToken();
    await this.ctx.storage.put({
      state: { ...initial, history: [], updatedAt: Date.now() },
      hostTokenHash: await sha256(hostToken)
    });
    await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
    return { ok: true, hostToken };
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ isHost: false, ack: 0, ready: false });

    if (!(await this.ctx.storage.get("state"))) {
      server.send(JSON.stringify({ t: "error", code: "not_found" }));
      server.close(4404, "room not found");
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > MAX_MESSAGE_BYTES) {
      return this.sendError(ws, "too_large");
    }
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.sendError(ws, "bad_json");
    }

    const state = await this.ctx.storage.get("state");
    if (!state) {
      this.sendError(ws, "not_found");
      return ws.close(4404, "room not found");
    }

    const meta = ws.deserializeAttachment();

    if (msg.t === "hello") {
      const hash = await this.ctx.storage.get("hostTokenHash");
      meta.isHost = typeof msg.hostToken === "string" && (await sha256(msg.hostToken)) === hash;
      meta.ready = true;
      ws.serializeAttachment(meta);
      return this.sendState(ws, state);
    }

    if (!meta.ready) return this.sendError(ws, "hello_required");
    if (typeof msg.seq === "number") meta.ack = msg.seq;
    ws.serializeAttachment(meta);

    const denied = this.checkPermission(state, meta, msg);
    if (denied) {
      this.sendError(ws, denied);
      return this.sendState(ws, state); // 拒否された変更を巻き戻させる
    }

    const next = this.applyOp(state, msg);
    if (!next) {
      this.sendError(ws, "bad_op");
      return this.sendState(ws, state);
    }

    next.updatedAt = Date.now();
    await this.ctx.storage.put("state", next);
    for (const peer of this.ctx.getWebSockets()) {
      if (peer.deserializeAttachment().ready) this.sendState(peer, next);
    }
  }

  checkPermission(state, meta, msg) {
    if (state.sessionConfig.status === "closed") return "room_closed";
    if (state.sessionConfig.controlMode === "hostOnly" && !meta.isHost) return "host_only";
    if (msg.t === "patch" && msg.fields?.sessionConfig && !meta.isHost) {
      const { controlMode } = msg.fields.sessionConfig;
      if (controlMode !== undefined && controlMode !== state.sessionConfig.controlMode) return "host_only";
    }
    return null;
  }

  applyOp(state, msg) {
    switch (msg.t) {
      case "patch": {
        const fields = sanitizePatch(msg.fields, state);
        if (!fields) return null;
        return { ...state, ...fields };
      }
      case "addGame": {
        const game = sanitizeGame(msg.game);
        if (!game || state.history.length >= MAX_HISTORY) return null;
        const usedIds = new Set(state.history.map(g => g.id));
        while (usedIds.has(game.id)) game.id++;
        return { ...state, history: renumber([...state.history, game]) };
      }
      case "setExcluded": {
        if (typeof msg.excluded !== "boolean") return null;
        const history = state.history.map(g => (g.id === msg.id ? { ...g, excluded: msg.excluded } : g));
        return { ...state, history: renumber(history) };
      }
      case "resetHistory":
        return { ...state, history: [] };
      default:
        return null;
    }
  }

  sendState(ws, state) {
    const meta = ws.deserializeAttachment();
    try {
      ws.send(JSON.stringify({ t: "state", state, isHost: meta.isHost, ack: meta.ack }));
    } catch {
      // 切断済みソケットは無視
    }
  }

  sendError(ws, code) {
    try {
      ws.send(JSON.stringify({ t: "error", code }));
    } catch {
      // 切断済みソケットは無視
    }
  }

  async webSocketClose(ws, code) {
    try {
      ws.close(code === 1005 ? 1000 : code);
    } catch {
      // 既に閉じている
    }
  }

  // 一定期間更新のないルームを丸ごと削除
  async alarm() {
    const state = await this.ctx.storage.get("state");
    if (!state) return;
    const expiresAt = state.updatedAt + ROOM_TTL_MS;
    if (Date.now() < expiresAt) {
      await this.ctx.storage.setAlarm(expiresAt);
      return;
    }
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(4410, "room expired");
      } catch {
        // 既に閉じている
      }
    }
    await this.ctx.storage.deleteAll();
  }
}

function renumber(history) {
  let count = 1;
  return history.map(g => (g.excluded ? g : { ...g, title: `第 ${count++} 回戦` }));
}

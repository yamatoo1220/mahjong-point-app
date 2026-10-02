// ルームサーバー（Cloudflare Durable Object）との通信
// - 変更は「操作」として送り、サーバーが検査・適用した結果を全員に配信する
// - 自分の送った操作がすべて反映されるまでは、古い状態で画面を上書きしない
// - 切断時は自動で再接続し、その間の操作は接続後にまとめて送る
(function (global) {
  const API_BASE = '';
  const RECONNECT_MAX_MS = 15000;
  const FATAL_CLOSE_CODES = [4404, 4410]; // ルームなし / 期限切れ

  async function createRoom(state) {
    const res = await fetch(`${API_BASE}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state })
    });
    if (!res.ok) throw new Error(`room create failed: ${res.status}`);
    return res.json(); // { roomId, hostToken }
  }

  class RoomClient {
    constructor({ roomId, hostToken, onState, onError, onStatus }) {
      this.roomId = roomId;
      this.hostToken = hostToken || null;
      this.onState = onState;
      this.onError = onError || (() => {});
      this.onStatus = onStatus || (() => {});
      this.ws = null;
      this.queue = [];
      this.seq = 0;
      this.lastSentSeq = 0;
      this.retryMs = 1000;
      this.closedByUser = false;
      this.retryTimer = null;
    }

    connect() {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const host = API_BASE ? new URL(API_BASE).host : window.location.host;
      const ws = new WebSocket(`${proto}://${host}/api/rooms/${this.roomId}/ws`);
      this.ws = ws;
      this.onStatus('connecting');

      ws.onopen = () => {
        // 接続ごとに番号を振り直す（サーバーの ack も接続ごと）
        this.seq = 0;
        this.lastSentSeq = 0;
        this.retryMs = 1000;
        ws.send(JSON.stringify({ t: 'hello', hostToken: this.hostToken }));
        const pending = this.queue;
        this.queue = [];
        pending.forEach(op => this.transmit(op));
        this.onStatus('open');
      };

      ws.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (msg.t === 'state') {
          if (msg.ack >= this.lastSentSeq) this.onState(msg.state, msg.isHost);
        } else if (msg.t === 'error') {
          this.onError(msg.code);
        }
      };

      ws.onclose = (event) => {
        if (this.ws !== ws) return;
        this.ws = null;
        if (this.closedByUser || FATAL_CLOSE_CODES.includes(event.code)) {
          this.onStatus('closed');
          return;
        }
        this.onStatus('reconnecting');
        this.retryTimer = setTimeout(() => this.connect(), this.retryMs);
        this.retryMs = Math.min(this.retryMs * 2, RECONNECT_MAX_MS);
      };
    }

    send(op) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.transmit(op);
      } else {
        this.queue.push(op);
      }
    }

    transmit(op) {
      this.seq += 1;
      this.lastSentSeq = this.seq;
      this.ws.send(JSON.stringify({ ...op, seq: this.seq }));
    }

    close() {
      this.closedByUser = true;
      clearTimeout(this.retryTimer);
      if (this.ws) this.ws.close(1000, 'leave');
      this.ws = null;
    }
  }

  global.RoomSync = { createRoom, RoomClient };
})(window);

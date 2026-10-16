'use strict';
/**
 * 联机客户端垫片 —— 用原生 WebSocket 复刻出项目里用到的那部分 Socket.IO API。
 *
 * 支持两种运行环境：
 *   浏览器 —— 直接用原生 WebSocket
 *   Node   —— Node 22+ 自带全局 WebSocket；也可用 setWebSocketImpl() 注入别的实现
 *
 * 暴露的接口（与 netClient.js 中使用到的 Socket.IO 能力一一对应）：
 *   工厂：RockFightRt.createSocket(serverUrl, opts)  →  socket
 *   socket.on(event, cb) / once(event, cb) / removeAllListeners()
 *   socket.emit(event, payload, ackCb)
 *   socket.disconnect() / socket.connected
 *   事件：'connect' | 'disconnect' | 'connect_error' | 服务端自定义事件
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RockFightRt = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const HEARTBEAT_MS = 25000;

  let WebSocketImpl = typeof WebSocket !== 'undefined' ? WebSocket : null;

  function setWebSocketImpl(impl) { WebSocketImpl = impl; }

  /** https://x → wss://x/rt ；也接受已经写好 ws:// 的地址 */
  function toSocketUrl(serverUrl) {
    let u = String(serverUrl || '').trim().replace(/\/+$/, '');
    if (!u) throw new Error('缺少服务器地址');
    if (u.startsWith('https://')) u = `wss://${u.slice(8)}`;
    else if (u.startsWith('http://')) u = `ws://${u.slice(7)}`;
    else if (!u.startsWith('ws://') && !u.startsWith('wss://')) u = `wss://${u}`;
    return `${u}/rt`;
  }

  class RtSocket {
    constructor(serverUrl, opts) {
      this.opts = opts || {};
      this.url = toSocketUrl(this.opts.urlOverride || serverUrl);
      this.ws = null;
      this.connected = false;
      this.everConnected = false;
      this.closedByUser = false;
      this.listeners = new Map();
      this.pending = new Map();
      this.outbox = [];
      this.ackSeq = 0;
      this.attempt = 0;
      this.heartbeat = null;
      this.reopenTimer = null;
      this.open();
    }

    /* ---------- 事件系统 ---------- */

    on(event, cb) {
      if (!this.listeners.has(event)) this.listeners.set(event, []);
      this.listeners.get(event).push(cb);
      return this;
    }

    once(event, cb) {
      const wrap = (payload) => { this.off(event, wrap); cb(payload); };
      return this.on(event, wrap);
    }

    off(event, cb) {
      const list = this.listeners.get(event);
      if (!list) return this;
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
      return this;
    }

    removeAllListeners() { this.listeners.clear(); return this; }

    fire(event, payload) {
      const list = this.listeners.get(event);
      if (!list) return;
      for (const cb of list.slice()) {
        try { cb(payload); } catch (e) { console.error('[rt] 事件回调出错', event, e); }
      }
    }

    /* ---------- 连接管理 ---------- */

    open() {
      if (!WebSocketImpl) { this.fire('connect_error', new Error('当前环境没有 WebSocket 实现')); return; }
      let ws;
      try { ws = new WebSocketImpl(this.url); }
      catch (e) { this.fire('connect_error', e); this.scheduleReopen(); return; }
      this.ws = ws;

      ws.onopen = () => {
        this.connected = true;
        this.everConnected = true;
        this.attempt = 0;
        this.flush();
        this.startHeartbeat();
        this.fire('connect');
      };

      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch (_) { return; }
        if (!msg || typeof msg.e !== 'string') return;
        if (msg.e === '__ack') {
          const cb = this.pending.get(msg.a);
          if (cb) { this.pending.delete(msg.a); try { cb(msg.p); } catch (e) { console.error(e); } }
          return;
        }
        if (msg.e === '__pong') return;
        this.fire(msg.e, msg.p);
      };

      ws.onerror = () => {
        if (!this.everConnected) this.fire('connect_error', new Error(`无法连接 ${this.url}`));
      };

      ws.onclose = (ev) => {
        const wasConnected = this.connected;
        this.connected = false;
        this.stopHeartbeat();
        if (wasConnected || this.everConnected) this.fire('disconnect', (ev && ev.reason) || 'transport close');
        if (!this.closedByUser) this.scheduleReopen();
      };
    }

    scheduleReopen() {
      if (this.closedByUser || this.reopenTimer) return;
      const base = this.opts.reconnectionDelay || 500;
      const max = this.opts.reconnectionDelayMax || 4000;
      const delay = Math.min(max, base * Math.pow(1.6, this.attempt));
      this.attempt += 1;
      this.reopenTimer = setTimeout(() => {
        this.reopenTimer = null;
        if (!this.closedByUser) this.open();
      }, delay);
    }

    startHeartbeat() {
      this.stopHeartbeat();
      this.heartbeat = setInterval(() => {
        if (this.connected) this.send({ e: '__ping', p: null, a: null });
      }, HEARTBEAT_MS);
    }

    stopHeartbeat() {
      if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    }

    /* ---------- 收发 ---------- */

    send(frame) {
      const text = JSON.stringify(frame);
      if (!this.connected || !this.ws) { this.outbox.push(text); return; }
      try { this.ws.send(text); } catch (_) { this.outbox.push(text); }
    }

    flush() {
      if (!this.outbox.length) return;
      const queue = this.outbox;
      this.outbox = [];
      for (const text of queue) {
        try { this.ws.send(text); } catch (_) { this.outbox.push(text); }
      }
    }

    /** 与 Socket.IO 的 socket.emit 同形：末位可选 ack 回调 */
    emit(event, payload, ack) {
      if (typeof ack === 'function') {
        this.ackSeq += 1;
        const id = this.ackSeq;
        this.pending.set(id, ack);
        this.send({ e: event, p: payload === undefined ? null : payload, a: id });
        return;
      }
      this.send({ e: event, p: payload === undefined ? null : payload, a: null });
    }

    disconnect() {
      this.closedByUser = true;
      this.stopHeartbeat();
      if (this.reopenTimer) { clearTimeout(this.reopenTimer); this.reopenTimer = null; }
      this.pending.clear();
      if (this.ws) { try { this.ws.close(); } catch (_) { /* 忽略 */ } }
      this.ws = null;
      this.connected = false;
    }
  }

  function createSocket(serverUrl, opts) { return new RtSocket(serverUrl, opts); }

  return { createSocket, toSocketUrl, setWebSocketImpl, RtSocket };
});

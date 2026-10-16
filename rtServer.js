'use strict';
/**
 * 传输层适配层 —— 把「Socket.IO 形状」的 API 架在任意原生 WebSocket 之上。
 *
 * 为什么需要它：
 *   Cloudflare Workers 跑不了 Socket.IO（那需要常驻进程 + 自有握手协议）。
 *   但 rooms.js / battle.js 实际只用到以下几样东西：
 *       socket.id            —— 连接唯一标识
 *       socket.join(code)    —— 加入房间频道
 *       socket.emit(ev, p)   —— 发消息
 *       socket.on(ev, cb)    —— 收消息（cb 末位可有 ack 函数）
 *       io.to(idOrRoom).emit(ev, p)  —— 定向 / 广播
 *   所以这里只实现这几样，业务逻辑（rooms.js / battle.js / config.js）**一行都不用改**，
 *   同一份代码即可同时运行在 Node(ws) 与 Cloudflare Worker(Durable Object) 上。
 *
 * 线上帧格式（JSON，一行一帧）：
 *   客户端 → 服务端： { e: '事件名', p: 负载, a: 请求号或 null }
 *   服务端 → 客户端： { e: '事件名', p: 负载, a: null }
 *   服务端 → 客户端（应答）： { e: '__ack', p: 结果, a: 请求号 }
 */

let peerSeq = 0;
function nextPeerId() {
  peerSeq += 1;
  return `s_${Date.now().toString(36)}_${peerSeq.toString(36)}`;
}

class Peer {
  /**
   * @param {Hub} hub
   * @param {string} id
   * @param {{send:(text:string)=>void, close:()=>void}} transport 运行时提供的发送/关闭原语
   */
  constructor(hub, id, transport) {
    this.hub = hub;
    this.id = id;
    this.transport = transport;
    this.channels = new Set();
    this.listeners = new Map();
    this.closed = false;
  }

  on(event, cb) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(cb);
    return this;
  }

  fire(event, payload, ack) {
    const list = this.listeners.get(event);
    if (!list) return;
    for (const cb of list) {
      try { cb(payload, ack); } catch (e) { console.error('[rt] 处理事件出错', event, e); }
    }
  }

  join(channel) {
    if (this.channels.has(channel)) return;
    this.channels.add(channel);
    this.hub.addToChannel(channel, this);
  }

  leaveAll() {
    for (const c of this.channels) this.hub.removeFromChannel(c, this);
    this.channels.clear();
  }

  /** ack 为数字时表示「这是对第 ack 号请求的应答」 */
  send(event, payload, ack) {
    if (this.closed) return;
    try {
      this.transport.send(JSON.stringify({ e: event, p: payload, a: ack == null ? null : ack }));
    } catch (_) {
      // 连接已断，忽略
    }
  }

  emit(event, payload) { this.send(event, payload, null); }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.transport.close(); } catch (_) { /* 忽略 */ }
  }
}

class Hub {
  constructor() {
    this.peers = new Map();     // peerId -> Peer
    this.channels = new Map();  // 频道名 -> Set<Peer>
    this.listeners = new Map(); // 事件名 -> [cb]
    this.openedAt = Date.now();
    this.totalConnections = 0;
  }

  on(event, cb) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(cb);
    return this;
  }

  fire(event, payload) {
    const list = this.listeners.get(event);
    if (!list) return;
    for (const cb of list) {
      try { cb(payload); } catch (e) { console.error('[rt] 处理事件出错', event, e); }
    }
  }

  addToChannel(channel, peer) {
    if (!this.channels.has(channel)) this.channels.set(channel, new Set());
    this.channels.get(channel).add(peer);
  }

  removeFromChannel(channel, peer) {
    const set = this.channels.get(channel);
    if (!set) return;
    set.delete(peer);
    if (set.size === 0) this.channels.delete(channel);
  }

  /**
   * 等价于 Socket.IO 的 io.to(target)。
   * target 优先按 socketId 精确匹配，其次按房间名广播（与 Socket.IO 的解析顺序一致）。
   */
  to(target) {
    return { emit: (event, payload) => this.emitTo(target, event, payload) };
  }

  emitTo(target, event, payload) {
    const peer = this.peers.get(target);
    if (peer) {
      if (!peer.closed) peer.emit(event, payload);
      return;
    }
    const set = this.channels.get(target);
    if (!set) return;
    for (const p of Array.from(set)) p.emit(event, payload);
  }

  /** 运行时在 WebSocket 建立后调用，返回 Peer；会触发 'connection' 事件 */
  accept(transport) {
    const peer = new Peer(this, nextPeerId(), transport);
    this.peers.set(peer.id, peer);
    this.totalConnections += 1;
    this.fire('connection', peer);
    return peer;
  }

  /** 运行时收到一帧调用 */
  handleFrame(peer, raw) {
    let msg;
    try { msg = JSON.parse(typeof raw === 'string' ? raw : String(raw)); } catch (_) { return; }
    if (!msg || typeof msg.e !== 'string') return;

    const ackId = msg.a == null ? null : msg.a;
    const ack = ackId == null ? undefined : (res) => peer.send('__ack', res, ackId);

    if (msg.e === '__ping') {
      if (ackId == null) peer.send('__pong', { t: Date.now() }, null);
      else ack({ t: Date.now() });
      return;
    }
    peer.fire(msg.e, msg.p, ack);
  }

  /** 运行时在连接关闭后调用；会触发 'disconnect' 事件（负载为 Peer 本身） */
  handleClose(peer) {
    if (!peer || !this.peers.has(peer.id)) return;  // 已被处理过，避免重复触发
    peer.leaveAll();
    this.peers.delete(peer.id);
    // 与 Socket.IO 行为保持一致：连接自身也会收到 'disconnect'
    // （业务代码里写的是 socket.on('disconnect', ...)，缺了这一步就会静默失效）
    peer.fire('disconnect', 'transport close');
    peer.closed = true;
    this.fire('disconnect', peer);
  }

  stats() {
    return {
      peers: this.peers.size,
      channels: this.channels.size,
      totalConnections: this.totalConnections,
      uptimeSec: Math.round((Date.now() - this.openedAt) / 1000)
    };
  }
}

module.exports = { Hub, Peer };

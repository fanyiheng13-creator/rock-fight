'use strict';
/**
 * 房间协议实现（运行时无关）。
 *
 * Node(ws) 与 Cloudflare Worker(Durable Object) 都调用 attachHandlers(hub)，
 * 因此**两端跑的是同一份协议与同一套业务逻辑**，不会出现行为漂移。
 *
 * 返回：
 *   manager        —— RoomManager 实例（可用于 /healthz 统计）
 *   tick()         —— 推进一次模拟，按 net.tickHz 调用
 *   pushSnapshots()—— 广播一次快照，按 net.snapshotHz 调用
 */

const CONFIG = require('./config');
const { RoomManager } = require('./rooms');

function attachHandlers(hub, options) {
  const opts = options || {};
  const dbg = opts.debug ? (...args) => console.log('[rf:debug]', ...args) : () => {};

  const manager = new RoomManager(hub);

  hub.on('connection', (socket) => {
    dbg('连接建立', socket.id);

    // 让客户端知道连接是通的
    socket.emit('server:hello', { tickHz: CONFIG.net.tickHz, maxPlayers: CONFIG.room.maxPlayers });

    socket.on('room:create', ({ name } = {}, ack) => {
      const { room, player } = manager.create(socket, name);
      const state = room.stateFor(player.id);
      if (typeof ack === 'function') ack({ ok: true, room: state, playerId: player.id, token: player.token });
      manager.broadcastState(room);
    });

    socket.on('room:join', ({ code, name } = {}, ack) => {
      const result = manager.join(socket, code, name);
      if (result.error) { if (typeof ack === 'function') ack({ ok: false, error: result.error }); return; }
      const { room, player } = result;
      if (typeof ack === 'function') ack({ ok: true, room: room.stateFor(player.id), playerId: player.id, token: player.token });
      manager.broadcastState(room);
    });

    socket.on('room:rejoin', ({ code, playerId, token } = {}, ack) => {
      const result = manager.rejoin(socket, code, playerId, token);
      if (result.error) { if (typeof ack === 'function') ack({ ok: false, error: result.error }); return; }
      const { room, player } = result;
      if (typeof ack === 'function') ack({ ok: true, room: room.stateFor(player.id), playerId: player.id, token: player.token });
      manager.broadcastState(room);
      // 若战斗仍在进行，立刻补一份快照
      if (room.phase === 'fighting' && room.battle) socket.emit('battle:snapshot', room.battle.snapshot());
    });

    socket.on('room:ready', ({ ready } = {}) => {
      for (const room of manager.rooms.values()) {
        const player = room.playerBySocket(socket.id);
        if (!player) continue;
        manager.setReady(room.code, player.id, ready);
        manager.broadcastState(room);
        return;
      }
    });

    socket.on('room:leave', (_payload, ack) => {
      manager.leave(socket.id);
      if (typeof ack === 'function') ack({ ok: true });
    });

    socket.on('room:again', () => {
      for (const room of manager.rooms.values()) {
        if (!room.playerBySocket(socket.id)) continue;
        manager.resetToLobby(room.code);
        return;
      }
    });

    // 客户端只上报输入意图；是否命中由服务器裁决
    socket.on('input', (msg) => { manager.applyInput(socket.id, msg || {}); });

    socket.on('disconnect', () => {
      const result = manager.markDisconnected(socket.id);
      dbg('连接断开', socket.id, '｜匹配到的玩家 =', result ? result.player.name : 'null');
      if (!result) return;

      manager.broadcast(result.room, 'opponent:disconnected', {
        playerId: result.player.id, name: result.player.name
      });

      // 若长时间不回来，彻底移除
      setTimeout(() => {
        const room = manager.rooms.get(result.room.code);
        if (!room) return;
        const p = room.players.get(result.player.id);
        if (p && !p.connected && Date.now() - p.disconnectedAt > 30000) {
          room.players.delete(p.id);
          if (room.size === 0) room.lastEmptyAt = Date.now();
          manager.broadcastState(room);
        }
      }, 31000);
    });
  });

  let last = Date.now();
  function tick() {
    const now = Date.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    manager.tick(dt);
  }

  function pushSnapshots() { manager.pushSnapshots(); }

  return { manager, tick, pushSnapshots };
}

module.exports = { attachHandlers };

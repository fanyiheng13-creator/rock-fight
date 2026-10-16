'use strict';
const CONFIG = require('./config');
const { BattleSim } = require('./battle');

function generateCode(existing) {
  let code = '';
  do {
    code = '';
    for (let i = 0; i < CONFIG.room.codeLength; i += 1) code += Math.floor(Math.random() * 10);
  } while (existing.has(code));
  return code;
}

function randomToken() {
  return `${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 12)}`;
}

class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map();   // playerId -> record
    this.phase = 'lobby';       // lobby | countdown | fighting | ended
    this.countdownEndsAt = 0;
    this.battle = null;
    this.lastEmptyAt = 0;
    this.finishedAt = 0;
  }

  get size() { return this.players.size; }

  addPlayer(player) { this.players.set(player.id, player); return player; }

  playerBySocket(socketId) {
    for (const p of this.players.values()) if (p.socketId === socketId) return p;
    return null;
  }

  playerByToken(token) {
    for (const p of this.players.values()) if (p.token === token) return p;
    return null;
  }

  freeSlot() {
    const used = new Set([...this.players.values()].map((p) => p.slot));
    return used.has(0) ? 1 : 0;
  }

  allReadyAndConnected() {
    if (this.size < CONFIG.room.maxPlayers) return false;
    return [...this.players.values()].every((p) => p.ready && p.connected);
  }

  /** 给某个玩家看的房间状态（含加入/准备/连接状态） */
  stateFor(viewerId) {
    return {
      code: this.code,
      phase: this.phase,
      maxPlayers: CONFIG.room.maxPlayers,
      you: viewerId,
      countdownMs: this.phase === 'countdown' ? Math.max(0, this.countdownEndsAt - Date.now()) : 0,
      players: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, slot: p.slot, ready: p.ready, connected: p.connected
      }))
    };
  }
}

class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map();
  }

  makePlayer(socket, name, slot) {
    return {
      id: `p_${Math.random().toString(36).slice(2, 10)}`,
      token: randomToken(),
      socketId: socket.id,
      name: String(name || '玩家').slice(0, 12),
      ready: false,
      connected: true,
      slot,
      disconnectedAt: 0
    };
  }

  create(socket, name) {
    const code = generateCode(this.rooms);
    const room = new Room(code);
    this.rooms.set(code, room);
    const player = this.makePlayer(socket, name, 0);
    room.addPlayer(player);
    socket.join(code);
    return { room, player };
  }

  join(socket, codeRaw, name) {
    const code = String(codeRaw || '').trim();
    const room = this.rooms.get(code);
    if (!room) return { error: '房间不存在，请检查房间号' };
    if (room.phase === 'fighting') return { error: '该房间战斗已开始' };
    if (room.size >= CONFIG.room.maxPlayers) return { error: '房间已满（最多 2 人）' };
    const player = this.makePlayer(socket, name, room.freeSlot());
    room.addPlayer(player);
    socket.join(code);
    return { room, player };
  }

  /** 断线重连：用 playerId + token 回到原房间 */
  rejoin(socket, codeRaw, playerId, token) {
    const room = this.rooms.get(String(codeRaw || '').trim());
    if (!room) return { error: '房间已关闭' };
    const player = room.players.get(playerId) || room.playerByToken(token);
    if (!player || player.token !== token) return { error: '身份校验失败' };
    player.socketId = socket.id;
    player.connected = true;
    player.disconnectedAt = 0;
    socket.join(room.code);
    return { room, player };
  }

  setReady(code, playerId, ready) {
    const room = this.rooms.get(code);
    if (!room) return null;
    const player = room.players.get(playerId);
    if (!player) return null;
    player.ready = !!ready;
    return room;
  }

  markDisconnected(socketId) {
    for (const room of this.rooms.values()) {
      const player = room.playerBySocket(socketId);
      if (player) {
        player.connected = false;
        player.ready = false;
        player.disconnectedAt = Date.now();
        this.broadcastState(room);
        return { room, player };
      }
    }
    return null;
  }

  leave(socketId) {
    for (const room of this.rooms.values()) {
      const player = room.playerBySocket(socketId);
      if (!player) continue;
      room.players.delete(player.id);
      if (room.size === 0) { room.lastEmptyAt = Date.now(); room.phase = 'lobby'; room.battle = null; }
      else if (room.phase === 'countdown') { room.phase = 'lobby'; room.countdownEndsAt = 0; }
      this.broadcastState(room);
      return room;
    }
    return null;
  }

  broadcastState(room) {
    for (const p of room.players.values()) {
      if (p.connected) this.io.to(p.socketId).emit('room:state', room.stateFor(p.id));
    }
  }

  broadcast(room, event, payload) {
    this.io.to(room.code).emit(event, payload);
  }

  /** 每个 tick 由服务器调用；负责倒计时与战斗推进 */
  tick(dt) {
    for (const [code, room] of this.rooms) {
      // 回收空房间
      if (room.size === 0) {
        if (room.lastEmptyAt && Date.now() - room.lastEmptyAt > CONFIG.room.emptyRoomTtlMs) this.rooms.delete(code);
        continue;
      }
      if (room.phase === 'lobby') {
        if (room.allReadyAndConnected()) {
          room.phase = 'countdown';
          room.countdownEndsAt = Date.now() + CONFIG.room.countdownMs;
          this.broadcast(room, 'match:countdown', { ms: CONFIG.room.countdownMs });
          this.broadcastState(room);
        }
        continue;
      }
      if (room.phase === 'countdown') {
        if (!room.allReadyAndConnected()) {
          room.phase = 'lobby'; room.countdownEndsAt = 0;
          this.broadcast(room, 'match:cancelled', { reason: '有玩家取消准备或掉线' });
          this.broadcastState(room);
        } else if (Date.now() >= room.countdownEndsAt) {
          room.phase = 'fighting';
          room.battle = new BattleSim([...room.players.keys()]);
          this.broadcast(room, 'match:start', { fighters: [...room.players.keys()], config: CONFIG });
          this.broadcastState(room);
        }
        continue;
      }
      if (room.phase === 'fighting' && room.battle) {
        room.battle.step(dt);
        const events = room.battle.drainEvents();
        if (events.length) this.broadcast(room, 'battle:events', events);
        if (room.battle.finished) {
          room.phase = 'ended';
          room.finishedAt = Date.now();
          this.broadcast(room, 'battle:snapshot', room.battle.snapshot());
          this.broadcastState(room);
        }
      }
    }
  }

  /** 按快照频率调用 */
  pushSnapshots() {
    for (const room of this.rooms.values()) {
      if (room.phase === 'fighting' && room.battle) this.broadcast(room, 'battle:snapshot', room.battle.snapshot());
    }
  }

  applyInput(socketId, msg) {
    for (const room of this.rooms.values()) {
      if (room.phase !== 'fighting' || !room.battle) continue;
      const player = room.playerBySocket(socketId);
      if (!player) continue;
      room.battle.applyInput(player.id, msg);
      return true;
    }
    return false;
  }

  /** 结束一局后回到房间大厅，双方需重新准备 */
  resetToLobby(code) {
    const room = this.rooms.get(code);
    if (!room) return null;
    room.phase = 'lobby';
    room.battle = null;
    room.countdownEndsAt = 0;
    for (const p of room.players.values()) p.ready = false;
    this.broadcastState(room);
    return room;
  }
}

module.exports = { RoomManager, Room, CONFIG };

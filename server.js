'use strict';
/**
 * 权威联机服务器入口
 *  - HTTP：托管静态前端（便于本地联调，也方便部署时同域运行）
 *  - Socket.IO：房间管理 + 战斗输入 + 快照广播
 *
 * 启动：npm install && npm start（默认 http://localhost:3000/index-game.html）
 * 环境变量：PORT（默认 3000）
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const CONFIG = require('./config');
const { RoomManager } = require('./rooms');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    // 允许来自任意来源的前端连接（本地联调 + 已部署的 GitHub Pages）
    origin: process.env.ALLOWED_ORIGIN || '*',
    methods: ['GET', 'POST']
  }
});

// 静态托管：自适应目录结构（优先当前目录，兼容两种布局）
//   - 扁平布局（推荐，Render 单服务）：server.js 与 index-game.html 同在仓库根目录 → 托管根目录
//   - 旧父子布局：server.js 在 server/ 子目录时 → 托管上一级
const PARENT = path.join(__dirname, '..');
const PAGE_FILES = ['index-game.html', 'index.html'];
const hasPage = (dir) => PAGE_FILES.some((f) => fs.existsSync(path.join(dir, f)));
const STATIC_ROOT = hasPage(__dirname) ? __dirname : (hasPage(PARENT) ? PARENT : __dirname);
app.use(express.static(STATIC_ROOT));
app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: manager.rooms.size, uptime: process.uptime() }));

const manager = new RoomManager(io);

io.on('connection', (socket) => {
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
    if (result) {
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
    }
  });
});

// 固定步长模拟，保证两台电脑看到同一套规则与节奏
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  manager.tick(dt);
}, Math.round(1000 / CONFIG.net.tickHz));

setInterval(() => manager.pushSnapshots(), Math.round(1000 / CONFIG.net.snapshotHz));

server.listen(PORT, () => {
  console.log(`[rock-fight] 权威服务器已启动：http://localhost:${PORT}`);
  console.log(`[rock-fight] 本地联调页面：http://localhost:${PORT}/index-game.html`);
});

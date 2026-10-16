'use strict';
/**
 * 权威联机服务器入口（Node / 自建环境）
 *
 *  - HTTP：托管静态前端（同域部署时前端零配置）
 *  - 原生 WebSocket：/rt 端点，跑的是与 Cloudflare Worker 版本**完全相同**的房间协议
 *
 * 启动：npm install && npm start
 * 环境变量：PORT（默认 3000）、RF_DEBUG=1 打开调试日志
 *
 * 注意：房间协议与战斗逻辑在 handlers.js / rooms.js / battle.js / config.js 里，
 *      这些文件同时被 Cloudflare Worker 复用，改一处两端生效。
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const CONFIG = require('./config');
const { Hub } = require('./rtServer');
const { attachHandlers } = require('./handlers');

const PORT = process.env.PORT || 3000;
const DEBUG = !!process.env.RF_DEBUG;
const dbg = (...args) => { if (DEBUG) console.log('[rf:debug]', ...args); };

const app = express();
const server = http.createServer(app);

// ---------- 静态托管（自适应目录结构） ----------
// 优先使用本文件所在目录；兼容「server.js 在子目录、前端在上一级」的旧布局
const PARENT = path.join(__dirname, '..');
const PAGE_FILES = ['index-game.html', 'index.html'];
const hasPage = (dir) => PAGE_FILES.some((f) => fs.existsSync(path.join(dir, f)));
const STATIC_ROOT = hasPage(__dirname) ? __dirname : (hasPage(PARENT) ? PARENT : __dirname);
// index 顺序：优先新游戏，其次旧的 index.html，保证访问根路径就是当前版本
app.use(express.static(STATIC_ROOT, { index: ['index-game.html', 'index.html'] }));

// ---------- 房间协议（与 Worker 共用同一份实现） ----------
const hub = new Hub();
const { manager, tick, pushSnapshots } = attachHandlers(hub, { debug: DEBUG });

app.get('/healthz', (_req, res) => res.json({
  ok: true, rooms: manager.rooms.size, ...hub.stats(), uptime: process.uptime()
}));

// ---------- 原生 WebSocket 端点：/rt ----------
const wss = new WebSocketServer({ server, path: '/rt' });
wss.on('connection', (ws) => {
  const peer = hub.accept({
    send: (text) => { try { ws.send(text); } catch (_) { /* 连接已断 */ } },
    close: () => { try { ws.close(); } catch (_) { /* 忽略 */ } }
  });
  dbg('ws 建立', peer.id);
  ws.on('message', (data) => hub.handleFrame(peer, data.toString()));
  ws.on('close', () => { dbg('ws close', peer.id); hub.handleClose(peer); });
  ws.on('error', (e) => { dbg('ws error', peer.id, e && e.message); hub.handleClose(peer); });
});

// ---------- 固定步长模拟，保证两台电脑看到同一套规则与节奏 ----------
setInterval(tick, Math.round(1000 / CONFIG.net.tickHz));
setInterval(pushSnapshots, Math.round(1000 / CONFIG.net.snapshotHz));

server.listen(PORT, () => {
  console.log(`[rock-fight] 权威服务器已启动：http://localhost:${PORT}`);
  console.log(`[rock-fight] 游戏页面：http://localhost:${PORT}/index-game.html`);
  console.log(`[rock-fight] WebSocket 端点：ws://localhost:${PORT}/rt`);
});

/**
 * Cloudflare Worker 版本：把**同一套**房间协议与战斗逻辑跑在 Durable Object 上。
 *
 * 复用的模块（与 Node 版本完全相同，没有任何分支拷贝）：
 *   ./handlers.js  房间协议（建房/加入/准备/倒计时/输入上报/掉线）
 *   ./rooms.js     房间状态机
 *   ./battle.js    权威战斗模拟（伤害/饮酒值/道具/胜负）
 *   ./config.js    全部平衡性数值（唯一真相）
 *   ./rtServer.js  Hub/Peer 传输适配层
 *
 * 为什么不用 Socket.IO：Workers 是无常驻进程的运行时，Socket.IO 的自有握手协议
 * 需要长驻连接状态；这里改用原生 WebSocket，由 Durable Object 承担房间的常驻状态。
 *
 * 静态前端通过 Workers Assets 托管（见 wrangler.toml 的 [assets]），
 * 因此页面与 WebSocket 同域，前端不需要配置任何服务器地址。
 */

import RtServer from './rtServer.js';
import Handlers from './handlers.js';
import Config from './config.js';

const { Hub } = RtServer;
const { attachHandlers } = Handlers;

/**
 * 一个 Durable Object 承载全部房间。
 * 对「好友之间开一局」这种规模完全够用，且免去了房间与 DO 之间的一对一映射复杂度。
 * 房间号全局唯一（由 rooms.js 的 generateCode 保证）。
 */
export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    this.hub = new Hub();
    const { manager, tick, pushSnapshots } = attachHandlers(this.hub);
    this.manager = manager;
    this.tickSim = tick;
    this.pushSnapshots = pushSnapshots;

    // 30Hz 固定步长模拟 + 20Hz 快照广播
    // 有活跃 WebSocket 连接时 DO 常驻，定时器会持续运行
    this.tickTimer = setInterval(() => {
      try { this.tickSim(); } catch (e) { console.error('[do] tick 出错', e); }
    }, Math.round(1000 / Config.net.tickHz));

    this.snapTimer = setInterval(() => {
      try { this.pushSnapshots(); } catch (e) { console.error('[do] snapshot 出错', e); }
    }, Math.round(1000 / Config.net.snapshotHz));
  }

  async fetch(request) {
    const upgrade = (request.headers.get('Upgrade') || '').toLowerCase();

    // 非 WebSocket 请求：当作健康检查
    if (upgrade !== 'websocket') {
      return Response.json({
        ok: true,
        rooms: this.manager.rooms.size,
        ...this.hub.stats()
      });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const peer = this.hub.accept({
      send: (text) => { try { server.send(text); } catch (_) { /* 连接已断 */ } },
      close: () => { try { server.close(); } catch (_) { /* 忽略 */ } }
    });

    server.addEventListener('message', (event) => this.hub.handleFrame(peer, event.data));
    server.addEventListener('close', () => this.hub.handleClose(peer));
    server.addEventListener('error', () => this.hub.handleClose(peer));

    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 联机端点与健康检查交给 Durable Object
    if (url.pathname === '/rt' || url.pathname === '/healthz') {
      const id = env.GAME.idFromName('global');
      return env.GAME.get(id).fetch(request);
    }

    // 其余请求走静态资源：index.html / render3d.js / three.min.js / netClient.js / rtClient.js
    return env.ASSETS.fetch(request);
  }
};

'use strict';
/**
 * 前端联机模块（无构建，直接 <script src="net/netClient.js"></script> 引入）
 * 暴露 window.RockFightNet
 *
 * 服务器地址解析优先级：
 *   1) URL 参数 ?server=https://xxx
 *   2) localStorage 中上次保存的地址
 *   3) 若页面由 http(s) 打开，则默认同域（即服务器托管前端时的地址）
 * 绝不硬编码 localhost，方便部署到 Render / Railway / Fly.io 后直接使用。
 */
(function () {
  const SERVER_KEY = 'rockfight_server_url';
  const SESSION_KEY = 'rockfight_session';

  function sanitize(url) {
    return String(url || '').trim().replace(/\/+$/, '');
  }

  function resolveServerUrl() {
    const params = new URLSearchParams(location.search);
    const fromQuery = sanitize(params.get('server'));
    if (fromQuery) { saveServerUrl(fromQuery); return fromQuery; }
    const saved = sanitize(localStorage.getItem(SERVER_KEY));
    if (saved) return saved;
    if (/^https?:$/.test(location.protocol)) return sanitize(location.origin);
    return '';
  }

  function saveServerUrl(url) {
    const clean = sanitize(url);
    if (clean) localStorage.setItem(SERVER_KEY, clean);
    return clean;
  }

  function loadSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (_) { return null; }
  }
  function saveSession(session) {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  }

  function loadSocketIo(serverUrl) {
    return new Promise((resolve, reject) => {
      if (window.io) return resolve(window.io);
      const script = document.createElement('script');
      script.src = `${serverUrl}/socket.io/socket.io.js`;
      script.onload = () => (window.io ? resolve(window.io) : reject(new Error('socket.io 加载后未挂载')));
      script.onerror = () => reject(new Error(`无法从 ${serverUrl} 加载 socket.io，请检查服务器地址`));
      document.head.appendChild(script);
    });
  }

  class Net {
    constructor() {
      this.socket = null;
      this.serverUrl = resolveServerUrl();
      this.player = null;      // { id, token }
      this.room = null;
      this.connected = false;
      this.handlers = new Map();
      this.inputSeq = 0;
      this.inputState = { left: false, right: false, up: false, down: false, jump: false };
      this.sendTimer = null;
      this.autoReconnect = true;
    }

    on(event, cb) {
      if (!this.handlers.has(event)) this.handlers.set(event, []);
      this.handlers.get(event).push(cb);
      return this;
    }

    emitLocal(event, payload) {
      (this.handlers.get(event) || []).forEach((cb) => { try { cb(payload); } catch (e) { console.error(e); } });
    }

    getServerUrl() { return this.serverUrl; }

    setServerUrl(url) {
      this.serverUrl = saveServerUrl(url);
      return this.serverUrl;
    }

    async connect(serverUrl) {
      if (serverUrl) this.setServerUrl(serverUrl);
      if (!this.serverUrl) throw new Error('请先填写服务器地址');
      const io = await loadSocketIo(this.serverUrl);
      if (this.socket) { this.socket.removeAllListeners(); this.socket.disconnect(); }
      this.socket = io(this.serverUrl, {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: 500,
        reconnectionDelayMax: 4000
      });
      this.bindSocket();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('连接服务器超时')), 10000);
        this.socket.once('connect', () => { clearTimeout(timer); this.connected = true; this.emitLocal('connection', { state: 'connected' }); resolve(true); });
        this.socket.once('connect_error', (err) => { clearTimeout(timer); reject(new Error(`连接失败：${err && err.message ? err.message : '未知错误'}`)); });
      });
    }

    bindSocket() {
      const s = this.socket;
      s.on('disconnect', (reason) => {
        this.connected = false;
        this.emitLocal('connection', { state: 'disconnected', reason });
      });
      s.on('connect', () => {
        this.connected = true;
        this.emitLocal('connection', { state: 'connected' });
        this.tryAutoRejoin();
      });
      s.on('room:state', (state) => { this.room = state; this.emitLocal('room', state); });
      s.on('match:countdown', (payload) => this.emitLocal('countdown', payload));
      s.on('match:cancelled', (payload) => this.emitLocal('cancelled', payload));
      s.on('match:start', (payload) => this.emitLocal('start', payload));
      s.on('battle:snapshot', (snap) => this.emitLocal('snapshot', snap));
      s.on('battle:events', (events) => this.emitLocal('events', events));
      s.on('opponent:disconnected', (payload) => this.emitLocal('opponentGone', payload));
      s.on('server:hello', (payload) => this.emitLocal('hello', payload));
    }

    request(event, payload) {
      return new Promise((resolve, reject) => {
        if (!this.socket) return reject(new Error('尚未连接服务器'));
        this.socket.emit(event, payload, (res) => {
          if (!res || res.ok) resolve(res);
          else reject(new Error(res.error || '服务器拒绝了请求'));
        });
      });
    }

    async createRoom(name) {
      const res = await this.request('room:create', { name });
      this.player = { id: res.playerId, token: res.token };
      this.room = res.room;
      saveSession({ code: res.room.code, playerId: res.playerId, token: res.token });
      this.emitLocal('room', res.room);
      return res.room;
    }

    async joinRoom(code, name) {
      const res = await this.request('room:join', { code, name });
      this.player = { id: res.playerId, token: res.token };
      this.room = res.room;
      saveSession({ code: res.room.code, playerId: res.playerId, token: res.token });
      this.emitLocal('room', res.room);
      return res.room;
    }

    async tryAutoRejoin() {
      const session = loadSession();
      if (!session || !session.code || !this.player) return false;
      try {
        const res = await this.request('room:rejoin', session);
        this.room = res.room;
        this.emitLocal('rejoined', res.room);
        return true;
      } catch (_) { saveSession(null); return false; }
    }

    setReady(ready) { if (this.socket) this.socket.emit('room:ready', { ready: !!ready }); }
    playAgain() { if (this.socket) this.socket.emit('room:again'); }
    leave() { if (this.socket) this.socket.emit('room:leave'); this.room = null; saveSession(null); }

    /** 本地输入 → 上报意图（服务器裁决） */
    setInput(key, value) {
      if (key in this.inputState) this.inputState[key] = !!value;
    }

    pressAttack(type) {
      if (!this.socket) return;
      this.inputSeq += 1;
      this.socket.emit('input', {
        seq: this.inputSeq,
        left: this.inputState.left,
        right: this.inputState.right,
        up: this.inputState.up,
        down: this.inputState.down,
        jump: false,
        attack: { type, id: `${this.player ? this.player.id : 'p'}_${this.inputSeq}` }
      });
    }

    startInputLoop(hz) {
      this.stopInputLoop();
      const interval = Math.round(1000 / (hz || 30));
      this.sendTimer = setInterval(() => {
        if (!this.socket || !this.connected) return;
        this.inputSeq += 1;
        this.socket.emit('input', {
          seq: this.inputSeq,
          left: this.inputState.left,
          right: this.inputState.right,
          up: this.inputState.up,
          down: this.inputState.down,
          jump: false
        });
      }, interval);
    }

    stopInputLoop() {
      if (this.sendTimer) { clearInterval(this.sendTimer); this.sendTimer = null; }
    }

    jump() {
      if (!this.socket) return;
      this.inputSeq += 1;
      this.socket.emit('input', {
        seq: this.inputSeq,
        left: this.inputState.left,
        right: this.inputState.right,
        up: this.inputState.up,
        down: this.inputState.down,
        jump: true
      });
    }
  }

  window.RockFightNet = new Net();
})();

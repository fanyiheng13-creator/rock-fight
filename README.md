# 地下摇滚王座之争 · 在线对战

## 架构

```
玩家A 浏览器 ─┐
              ├─ Socket.IO ─→ Node 权威服务器（伤害/饮酒值/道具/胜负唯一真相）
玩家B 浏览器 ─┘
```

- 前端：`index-game.html`（单文件：HTML + CSS + 游戏逻辑；无构建）
- 3D 渲染：`render3d.js`（Three.js 舞台与角色，仅负责画面，不做战斗计算）
- 3D 引擎：`three.min.js`（本地文件，不依赖 CDN）
- 联机模块：`netClient.js`（Socket.IO 客户端，只上报输入；服务器为唯一真相）
- 服务器：`server.js` + `config.js` + `battle.js` + `rooms.js`（Express + Socket.IO）

### 目录结构（全部扁平，上传/部署都方便）

```
index-game.html     游戏主文件（仓库里叫 index.html，占 Pages 根路径）
render3d.js         3D 渲染
three.min.js        Three.js r140
netClient.js        联机客户端
server.js           权威服务器入口（HTTP + Socket.IO）
config.js           平衡性参数（唯一数值真相）
battle.js           战斗模拟（伤害/饮酒/道具/胜负）
rooms.js            房间状态机
package.json        依赖与启动脚本
test/               协议与机制自动化测试
Dockerfile          容器部署
render.yaml         Render Blueprint
```

> 服务器静态目录是自适应的：优先使用 `server.js` 所在目录，其次上一级。
> 因此**一个服务可以同时托管游戏页面和联机后端**（同域，前端零配置）。

## 本地运行与测试

```bash
npm install
npm start          # 打开 http://localhost:3000/index-game.html
```

自动化协议测试（不需要开浏览器）：

```bash
node test/integration.js   # 房间/准备/倒计时/快照/命中/去重/断线/重连
node test/events-probe2.js # 事件投递 + 命中判定（结果写 test/probe-result.json）
```

双人联调：
1. 浏览器打开 `http://localhost:3000/index-game.html`，主菜单点「在线对战」→ 创建房间，记下房间号。
2. 另开一个浏览器窗口（无痕模式即可），加入同一房间号，双方点「准备」。
3. 3、2、1 倒计时后自动开打。

## 部署

### 方案一：Render（推荐，免费）
1. 推送仓库到 GitHub。
2. Render → New → Blueprint → 选择该仓库（根目录已含 `render.yaml`）。
3. 部署完成后得到形如 `https://rock-fight-server.onrender.com` 的地址。

> 这个服务**同时提供游戏页面和联机后端**：直接打开服务地址就是游戏，
> 因为同域，Socket.IO 会自动连上，前端不需要填任何服务器地址。
> GitHub Pages 那套静态站点依旧可玩单机（无联机）。

### 方案二：Docker（任意平台）
```bash
docker build -t rock-fight .
docker run -p 3000:3000 rock-fight
```

### 前端指向服务器
前端**不硬编码**服务器地址，按以下优先级解析：
1. URL 参数：`https://你的前端/?server=https://rock-fight-server.onrender.com`
2. 上次在「在线对战」面板里填写的地址（存 localStorage）
3. 若页面由 http(s) 打开，默认同域

所以：
- 直接打开 Render 服务地址 → 同域，零配置联机。
- 在 GitHub Pages 上联机 → 首次在「在线对战」面板填一次服务器地址即可。

## 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `PORT` | 监听端口 | `3000` |
| `ALLOWED_ORIGIN` | CORS 允许来源，逗号分隔或 `*` | `*` |

## 反作弊与公平性

- 客户端只上报**输入意图**（左右/跳跃/攻击类型），不参与伤害计算。
- 每次攻击带唯一 `attackId`，服务器记录已结算 ID，**重放同一攻击不再扣血**。
- 输入带自增 `seq`，过期或重放的消息直接丢弃。
- 双方数值来自 `server/config.js` 同一份配置。
- 服务器固定 30Hz 模拟、20Hz 广播快照，双方节奏一致。

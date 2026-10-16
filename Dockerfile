# 权威联机服务器镜像（Node.js）——单服务同时提供游戏页面 + 联机后端
FROM node:20-alpine

WORKDIR /app

# 先装依赖，利用 Docker 层缓存
COPY package*.json ./
RUN npm install --omit=dev --no-fund --no-audit

# 后端
COPY server.js config.js battle.js rooms.js ./

# 前端（静态托管时要用到）
COPY index-game.html three.min.js render3d.js netClient.js ./

# 让根路径 / 直接打开游戏
RUN cp index-game.html index.html

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]

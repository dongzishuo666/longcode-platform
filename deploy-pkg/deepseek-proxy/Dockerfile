# 后端：Fastify 多模型代理（智能代码生成平台）
# 仅包含后端代码；前端由另一镜像（nginx）托管并反向代理 /api 到这里。
FROM node:20-alpine

WORKDIR /app

# 先复制依赖清单并安装，利用层缓存（源码改动不会让依赖重装）
COPY package.json ./
RUN npm install --omit=dev --no-fund --no-audit

# 复制源码
COPY . .

# 运行态记忆库在容器内生成（data/memories.json），用 volume 挂载持久化（见 docker-compose.yml）
EXPOSE 8787

# 注意：容器间通信必须监听 0.0.0.0（不是代码默认的 127.0.0.1）。
# HOST / PORT 由 docker-compose 的 environment 注入，这里不写死。
# 不启用 --env-file（容器环境变量已通过 compose 注入）。
CMD ["node", "server.js"]

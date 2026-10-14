# 多阶段构建：构建 + 运行
FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# 运行阶段
FROM node:20-alpine

WORKDIR /app

# 创建非 root 用户
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup

# 复制依赖和源码
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public

# 创建数据目录
RUN mkdir -p /app/data && chown -R appuser:appgroup /app

USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "src/server.js"]

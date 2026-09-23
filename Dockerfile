FROM node:22-alpine
WORKDIR /app
COPY server.cjs ./
COPY lib ./lib
COPY public ./public
COPY shared ./shared
ENV NODE_ENV=production PORT=4317 HOST=0.0.0.0 CLAUDE_DIR=/claude
EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:4317/api/state > /dev/null || exit 1
USER node
CMD ["node", "server.cjs"]

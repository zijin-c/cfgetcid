FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=9567 DATA_DIR=/app/data
WORKDIR /app
COPY nodejs_ocr/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY nodejs_ocr/server.js ./server.js
RUN mkdir /app/data && chown node:node /app/data
USER node
EXPOSE 9567
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:9567/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]

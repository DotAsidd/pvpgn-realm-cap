# ============================================================
# NODE.JS REGISTRATION WEBSITE
# ============================================================

FROM node:22-alpine AS web

WORKDIR /app


COPY web/package.json .

RUN npm install --omit=dev

COPY web/ .

EXPOSE 3000

CMD ["node", "server.js"]
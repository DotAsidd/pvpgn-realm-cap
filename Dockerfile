# ============================================================
# NODE.JS REGISTRATION WEBSITE
# bnpass binary copied from the wwmoraes prebuilt PvPGN image
# ============================================================

FROM node:22-alpine AS web

WORKDIR /app

COPY --from=wwmoraes/pvpgn-server:latest-mysql /bin/bnpass /usr/local/bin/bnpass

COPY web/package.json .

RUN npm install --omit=dev

COPY web/ .

EXPOSE 3000

CMD ["node", "server.js"]
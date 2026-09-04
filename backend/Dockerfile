FROM docker.io/node:20-alpine

WORKDIR /app

COPY backend/package.json ./
RUN npm install --omit=dev

COPY backend/ ./
COPY src/ /app/src/
COPY backup-jsons/ /app/backup-jsons/

EXPOSE 8080

USER node

CMD ["node", "server.js"]

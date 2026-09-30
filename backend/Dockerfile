FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared-protocol ./shared-protocol
COPY simulator ./simulator
COPY backend ./backend
RUN npm ci
WORKDIR /app/backend
EXPOSE 8787
CMD ["npx", "tsx", "src/index.ts"]

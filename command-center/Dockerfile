FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared-protocol ./shared-protocol
COPY command-center ./command-center
RUN npm ci && npm run build -w @disastermesh/command-center
FROM nginx:1.27-alpine
COPY command-center/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/command-center/dist /usr/share/nginx/html
EXPOSE 80

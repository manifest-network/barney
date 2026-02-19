# Stage 1 — Build
FROM node:22-alpine3.21 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY patches/ patches/
RUN npm ci --legacy-peer-deps
COPY . .
RUN npm run build

# Stage 2 — Runtime
FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/dist/ /usr/share/nginx/html/
COPY docker/config.js.template /docker/config.js.template
COPY docker/env.sh /docker/env.sh
RUN chmod +x /docker/env.sh
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
ENTRYPOINT ["/docker/env.sh"]
CMD ["nginx", "-g", "daemon off;"]

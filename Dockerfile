# Stage 1 — Build
FROM node:22.19.0-alpine3.21 AS build
ARG GIT_COMMIT=""
ARG RELEASE_VERSION=""
WORKDIR /app
COPY package.json package-lock.json ./
COPY patches/ patches/
RUN npm ci --legacy-peer-deps
COPY . .
RUN RELEASE_VERSION=${RELEASE_VERSION} GIT_COMMIT=${GIT_COMMIT} npm run build-release

# Stage 2 — Compile Brotli dynamic modules against the exact nginx version.
# Alpine's prebuilt nginx-mod-http-brotli targets Alpine's own nginx, which is
# ABI-incompatible with the official Docker image's nginx (1.30.x), so we compile
# from source and copy only the .so files into the runtime image.
#
# Tracks the nginx 1.30 stable line via the floating `1.30-alpine` minor tag,
# which resolves to the latest 1.30.x — currently 1.30.4, the CVE-2026-42533 fix
# (a map-regex capture-clobber heap overflow, fixed in 1.30.4 stable / 1.31.3
# mainline; see ENG-596). Floating (not a fixed `1.30.4-alpine`) is intentional
# so rebuilds pick up future 1.30.x security patches; patches only increase, so
# the resolved version is always ≥1.30.4. This FROM and the runtime FROM below
# MUST use the identical tag: the module is built against $(nginx -v) here and
# loaded there, and the runtime `nginx -t` (below) fails the build on any ABI
# mismatch.
FROM nginx:1.30-alpine AS brotli-build
RUN apk add --no-cache git gcc g++ make pcre2-dev zlib-dev brotli-dev linux-headers wget \
    && git init /tmp/ngx_brotli \
    && cd /tmp/ngx_brotli \
    && git remote add origin https://github.com/google/ngx_brotli.git \
    && git fetch --depth=1 origin a71f9312c2deb28875acc7bacfdd5695a111aa53 \
    && git checkout FETCH_HEAD \
    && git submodule update --init --depth=1 && cd /tmp \
    && NGINX_VERSION=$(nginx -v 2>&1 | sed 's/^.*\///') \
    && wget -O /tmp/nginx-src.tar.gz "https://nginx.org/download/nginx-${NGINX_VERSION}.tar.gz" \
    && tar xzf /tmp/nginx-src.tar.gz -C /tmp \
    && cd /tmp/nginx-${NGINX_VERSION} \
    && ./configure --with-compat --add-dynamic-module=/tmp/ngx_brotli \
    && make modules \
    && mkdir -p /out \
    && cp objs/ngx_http_brotli_filter_module.so objs/ngx_http_brotli_static_module.so /out/

# Stage 3 — Runtime
# Tag MUST match the brotli-build stage above (see note there).
FROM nginx:1.30-alpine AS runtime
RUN apk add --no-cache brotli-libs jq
COPY --from=brotli-build /out/ngx_http_brotli_filter_module.so /usr/lib/nginx/modules/
COPY --from=brotli-build /out/ngx_http_brotli_static_module.so /usr/lib/nginx/modules/
RUN sed -i '1i load_module /usr/lib/nginx/modules/ngx_http_brotli_filter_module.so;' /etc/nginx/nginx.conf \
    && sed -i '2i load_module /usr/lib/nginx/modules/ngx_http_brotli_static_module.so;' /etc/nginx/nginx.conf \
    && nginx -t
COPY --from=build /app/dist/ /usr/share/nginx/html/
COPY docker/config.js.template /docker/config.js.template
COPY docker/env.sh /docker/env.sh
RUN chmod +x /docker/env.sh
COPY docker/nginx.conf.template /docker/nginx.conf.template
EXPOSE 80
ENTRYPOINT ["/docker/env.sh"]
CMD ["nginx", "-g", "daemon off;"]

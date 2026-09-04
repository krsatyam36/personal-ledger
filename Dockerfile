FROM docker.io/nginxinc/nginx-unprivileged:alpine-slim

# Copy web frontend
COPY --chown=101:101 src/ /usr/share/nginx/html/

# Replace default config with a hardened, minimal webserver config
RUN echo 'server { \
    listen 8080; \
    server_tokens off; \
    location / { \
        root /usr/share/nginx/html; \
        index index.html; \
        try_files $uri $uri/ =404; \
    } \
}' > /etc/nginx/conf.d/default.conf

EXPOSE 8080

USER 101

# The gateway, as an image the release chain actually delivers.
#
# It used to be stock `nginx:alpine` with ./nginx/nginx.conf bind-mounted from a checkout
# on the host. One of the closing re-review's fixes lives in that file —
# `X-Forwarded-Host: $http_host` — and nothing in the chain moved it: the deploy job
# re-PUTs the existing Portainer stack with pullImage: true, and the only artifacts that
# travel are images. A club that merged the fix would have got a new backend behind the OLD
# gateway config, with every LAN member back in one rate-limit bucket, while the dashboard
# said deployed (round-3 finding 18).
#
# Baking the config makes the config a build artifact with the same delivery guarantee as
# the code it belongs to, and makes the trap non-recurring: every future nginx.conf edit
# ships by the same path as every backend edit.
FROM nginx:alpine

# The upstream image runs /docker-entrypoint.d/20-envsubst-on-templates.sh at start, which
# expands ${NGINX_BACKEND_PORT} and friends from the environment into /etc/nginx/conf.d.
# Keeping the template mechanism rather than freezing the ports at build time is what lets
# one image serve a club that publishes the gateway somewhere other than :8088.
COPY nginx.conf /etc/nginx/templates/default.conf.template

# Defaults matching docker-compose.yml, so `docker run` on this image alone is a working
# gateway rather than one that renders ${NGINX_BACKEND_PORT} literally into a proxy_pass.
ENV NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx/conf.d \
    NGINX_BACKEND_PORT=5000 \
    NGINX_FRONTEND_PORT=80 \
    NGINX_CLIENT_MAX_BODY_SIZE=10m

EXPOSE 80

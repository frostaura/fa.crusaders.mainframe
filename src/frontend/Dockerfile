FROM node:22-alpine AS build
WORKDIR /workspace/src/frontend
RUN apk add --no-cache bash
# No VITE_SHOW_DEV_LOGIN build arg, and there must not be one again.
#
# It defaulted to false, which reads as safe and is not: it made "put the seeded admin's
# e-mail and password on the sign-in screen of a production image" a one-word change in a
# .env file nobody reviews, on the one surface that is public by definition. The block is
# dev-only through `import.meta.env.DEV`, which vite resolves at build time and the minifier
# then deletes — that is the whole mechanism, and an override is the only thing that could
# defeat it. `src/production-posture.test.ts` builds the bundle and greps it, and fails if
# this ARG, or a compose build arg, comes back.
COPY src/frontend/package*.json ./
RUN npm ci
COPY src/frontend/ /workspace/src/frontend/
RUN npm run build

# Pinned, like every base image here: a rebuild then changes only what this repository changed.
FROM nginx:1.31.8-alpine AS runtime
COPY --from=build /workspace/src/frontend/dist /usr/share/nginx/html
COPY src/frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
# The commit this image was built from (CI passes it; a local build says "unknown").
ARG BUILD_SHA=unknown
LABEL org.opencontainers.image.revision=$BUILD_SHA
ENV BUILD_SHA=$BUILD_SHA
CMD ["nginx", "-g", "daemon off;"]

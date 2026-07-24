FROM node:22-alpine AS build
WORKDIR /workspace/src/frontend
RUN apk add --no-cache bash
ARG VITE_SHOW_DEV_LOGIN=false
ENV VITE_SHOW_DEV_LOGIN=${VITE_SHOW_DEV_LOGIN}
COPY src/frontend/package*.json ./
RUN npm ci
COPY src/frontend/ /workspace/src/frontend/
RUN npm run build

FROM nginx:alpine AS runtime
COPY --from=build /workspace/src/frontend/dist /usr/share/nginx/html
COPY src/frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]

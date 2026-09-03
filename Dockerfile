FROM node:22-bookworm-slim@sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96 AS build

WORKDIR /src
# The lockfile alone first, so a source edit does not reinstall the toolchain.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM busybox:1.36.1-glibc@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662

ARG GIT_SHA
# Only what a build off a checkout carries: CI passes the version it resolved,
# and the labels docker/metadata-action attaches overwrite both of these
# anyway. A local build is a dev build and says so.
ARG VERSION=dev
LABEL org.opencontainers.image.title="headlamp-victoria-logs"
LABEL org.opencontainers.image.description="Persistent workload logs in Headlamp, served from VictoriaLogs"
LABEL org.opencontainers.image.source="https://github.com/lexbrugman/headlamp-victoria-logs"
LABEL org.opencontainers.image.revision="${GIT_SHA}"
LABEL org.opencontainers.image.version="${VERSION}"

# Headlamp loads a plugin as a directory holding its bundle and its manifest,
# so the image carries that directory rather than a bare file.
COPY --from=build /src/dist/main.js /plugin/headlamp-victoria-logs/main.js
COPY --from=build /src/package.json /plugin/headlamp-victoria-logs/package.json

USER 10001:10001

# This image runs as an init container and exits: it hands the plugin to the
# volume Headlamp reads, and nothing serves anything afterwards.
CMD ["cp", "-r", "/plugin/headlamp-victoria-logs", "/headlamp/plugins/"]

FROM node:22-bookworm-slim@sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96

# A toolchain, not a runtime: a checkout is bind-mounted over this directory,
# so nothing is copied in and the image pins only the Node version.
WORKDIR /src

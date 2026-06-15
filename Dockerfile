# BrainBudget — single-image dev/demo setup.
#
# Runs both workspaces together (matching `pnpm dev`):
#   - web    : Next.js UI on :3000  (proxies /api/agent/* -> the server)
#   - server : Express tools/agent server on :4021
#
# The server reads .env from the repo root, so mount or copy your .env in.
#
# Build : docker build -t brainbudget .
# Run   : docker run --rm -p 3000:3000 -p 4021:4021 --env-file .env brainbudget
#
# We use the full Debian-based node image (not -slim/-alpine) because several
# deps build native addons (keccak, bufferutil, sharp, utf-8-validate) that
# need python3 + a C/C++ toolchain, which the full image already ships.
# Node 24: pnpm 11.6.0 relies on builtin modules not present in Node 20.x.
FROM node:24-bookworm

# Corepack ships with Node and lets us pin the exact pnpm from package.json.
RUN corepack enable

WORKDIR /app

# 1) Install dependencies first, using only the manifests so this layer is
#    cached as long as dependencies don't change. Mirror the workspace layout
#    so pnpm can resolve the `workspace:*` links.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/
COPY server/package.json ./server/
COPY packages/shared/package.json ./packages/shared/

# --frozen-lockfile keeps installs reproducible against the committed lockfile.
RUN pnpm install --frozen-lockfile

# 2) Copy the rest of the source. node_modules is excluded via .dockerignore so
#    the installed deps from the layer above are preserved.
COPY . .

# web :3000, server :4021
EXPOSE 3000 4021

# Run both workspaces in parallel, exactly like local development.
CMD ["pnpm", "dev"]

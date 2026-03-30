# ── Stage 1: Build client ────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Install root + client dependencies
COPY package.json package-lock.json* ./
COPY client/package.json client/package-lock.json* client/
RUN npm ci --ignore-scripts && cd client && npm ci

# Copy source and build
COPY client/ client/
RUN cd client && npx vite build

# ── Stage 2: Runtime ─────────────────────────────────────────────────────
# Uses pre-built base image with Node + TeX Live (~1.5GB, built separately)
# Rebuild base only when upgrading Node/TeX:  docker build -f Dockerfile.base -t flowtex-base .
FROM flowtex-base

WORKDIR /app

# Install server dependencies
COPY server/package.json server/package-lock.json* server/
RUN cd server && npm ci --omit=dev

# Install root dependencies (compression, otpauth, qrcode)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts

# Copy server source
COPY server/ server/

# Copy built client into server/public
COPY --from=builder /app/client/dist/ server/public/

# Create directories for compilation working files
RUN mkdir -p /app/projects /app/git-repos

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3001/api/ready').then(r=>{if(!r.ok)throw 1}).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]

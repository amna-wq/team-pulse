FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY . .
# Cloud Run provides PORT. Mount a volume (or use Cloud Run volume mounts /
# GCS FUSE) at /app/data if you want the SQLite file to survive restarts —
# see README "Deployment".
EXPOSE 8080
# In demo mode on a fresh (ephemeral) filesystem, seed fake data first so the
# test deployment has a populated dashboard out of the box.
CMD ["sh", "-c", "if [ \"$DEMO_MODE\" = \"true\" ] && [ ! -f data/pulse.db ]; then node seed.js; fi; exec node server.js"]

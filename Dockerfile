FROM node:22-bookworm-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice \
    libreoffice-writer \
    fontconfig \
    fonts-dejavu \
    fonts-liberation \
    curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM base AS dev

COPY package*.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

EXPOSE 3333

CMD ["npm", "run", "dev"]

FROM base AS production

COPY package*.json ./
RUN npm ci --include=dev && npm cache clean --force

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

RUN mkdir -p storage/contracts \
  && chown -R node:node /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3333
ENV LIBREOFFICE_PATH=/usr/bin/soffice

USER node

EXPOSE 3333

CMD ["node", "dist/server.js"]
FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public ./public

ENV PORT=3737 \
    HOST=0.0.0.0
EXPOSE 3737

CMD ["node", "server.js"]

FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /opt/synterra

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
RUN mkdir -p /var/lib/synterra/.synterra && chown -R node:node /var/lib/synterra

COPY schema.sql ./schema.sql
COPY migrations ./migrations
COPY src ./src
COPY site ./site

USER node
EXPOSE 8787
CMD ["node", "src/server.js"]

FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json* tsconfig.json eslint.config.js ./
RUN npm ci

COPY src ./src
COPY public ./public

RUN npm run build
RUN npm prune --omit=dev


FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY package.json ./

EXPOSE 3000
CMD ["node", "dist/src/server.js"]

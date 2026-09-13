# Build the Vite frontend, then run the zero-dependency Node backend which also serves dist/.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY backend ./backend
COPY --from=build /app/dist ./dist
EXPOSE 8080
CMD ["node", "backend/server.mjs"]

FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY web/package*.json web/
RUN npm --prefix web ci
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
USER node
EXPOSE 3000
HEALTHCHECK CMD node -e "fetch('http://localhost:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]

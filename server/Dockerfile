FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
EXPOSE 8080
# Run as the non-root 'node' user
USER node
CMD ["node", "src/server.js"]

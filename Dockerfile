FROM node:20-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
ENV NODE_ENV=production \
    PORT=8080
EXPOSE 8080
CMD ["node","server.js"]

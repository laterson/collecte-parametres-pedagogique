# ---- runtime image (glibc) ----
FROM node:20-bookworm-slim

# Create app dir
WORKDIR /app

# Install only prod deps first (better cache)
COPY package*.json ./
RUN npm ci --only=production

# Copy source
COPY . .

# Prod env
ENV NODE_ENV=production \
    PORT=8080

# Health check path is already implemented in server.js
EXPOSE 8080

CMD ["node","server.js"]
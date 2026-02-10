FROM node:20-alpine

WORKDIR /app

# Install dependencies for better-sqlite3 + curl for healthcheck
RUN apk add --no-cache python3 make g++ sqlite curl

# Configure npm for better network resilience
RUN npm config set fetch-retries 5 \
    && npm config set fetch-retry-mintimeout 20000 \
    && npm config set fetch-retry-maxtimeout 120000 \
    && npm config set fetch-timeout 300000

# Copy package files
COPY package*.json ./

# Install all dependencies with retry logic
# Using npm ci for reproducible builds when package-lock.json exists
RUN npm ci --loglevel verbose || \
    (echo "Retry 1/3..." && sleep 10 && npm ci --loglevel verbose) || \
    (echo "Retry 2/3..." && sleep 20 && npm ci --loglevel verbose) || \
    (echo "Retry 3/3..." && sleep 30 && npm install --loglevel verbose)

# Copy source
COPY . .

# Build TypeScript
RUN npm run build

# Create directories for data and logs
RUN mkdir -p /app/data /app/data/stats /app/logs

# Expose port
EXPOSE 3004

# Health check with curl (more reliable than wget)
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -sf http://localhost:3004/health || exit 1

# Start
CMD ["node", "dist/index.js"]

FROM node:20-alpine

WORKDIR /app

# curl is required by the HEALTHCHECK below
RUN apk add --no-cache curl

COPY package.json ./
RUN npm install --omit=dev

COPY index.js ./

EXPOSE 3001

# Without a HEALTHCHECK, State.Health.Status simply does not exist in
# `docker inspect`, and our monitoring has nothing to read.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:3001/health || exit 1

CMD ["node", "index.js"]

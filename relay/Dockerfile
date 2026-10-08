# ComCom Relay image (built by install-relay.sh).
FROM node:22-alpine
# Inside the container staff connect on 8443; Docker publishes it as 443.
ENV NODE_ENV=production RELAY_DATA_DIR=/data RELAY_CLIENT_PORT=8443 RELAY_PUBLIC_CLIENT_PORT=443
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force
COPY relay.js index.js ./
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8443 7443
USER node
CMD ["node", "index.js"]

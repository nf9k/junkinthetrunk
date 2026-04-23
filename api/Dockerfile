FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src/ ./src/

# App-level RadioReference key — set at build time, not by end users
ARG RR_APP_KEY=
ENV RR_APP_KEY=$RR_APP_KEY

EXPOSE 3000

CMD ["node", "src/index.js"]

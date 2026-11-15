FROM node:20-alpine
ARG VERSION=v1
ENV APP_VERSION=$VERSION
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "index.js"]

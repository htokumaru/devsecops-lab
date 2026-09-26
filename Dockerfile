FROM node:24-slim

WORKDIR /app

# 依存関係インストール
COPY app/package*.json ./
RUN npm ci --omit=dev

# アプリケーションコードをコピー
COPY app/ .

# データディレクトリ作成
RUN mkdir -p data

EXPOSE 3000

CMD ["node", "app.js"]

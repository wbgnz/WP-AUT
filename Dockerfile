# ✅ Usar imagem oficial do Node.js baseada no Debian Bullseye
FROM node:18-bullseye

# 🧱 Instalar dependências do Chromium necessárias para Playwright
RUN apt-get update && apt-get install -y \
    libnss3 \
    libatk-bridge2.0-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libxfixes3 \
    libgbm1 \
    libxkbcommon0 \
    libgtk-3-0 \
    libatspi2.0-0 \
    libdrm2 \
    libxext6 \
    libxss1 \
    libxtst6 \
    fonts-liberation \
    libappindicator3-1 \
    libcurl4 \
    libdbus-glib-1-2 \
    && rm -rf /var/lib/apt/lists/*

# 📁 Criar diretório da aplicação
WORKDIR /app

# 📦 Copiar package.json e instalar dependências
COPY package*.json ./
RUN npm install

# 🧭 Instalar navegadores do Playwright com dependências
RUN npx playwright install --with-deps

# 📄 Copiar o restante do código
COPY . .

# 🌍 Variáveis de ambiente para Playwright
ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=false
ENV PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright

# 🚪 Expor a porta usada pela API
EXPOSE 10000

# 🚀 Comando de inicialização
CMD ["npm", "start"]

# Usar Node.js oficial (LTS)
FROM node:18-bullseye

# Instalar dependências do Chromium para Playwright
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
    && rm -rf /var/lib/apt/lists/*

# Criar diretório da aplicação
WORKDIR /app

# Copiar package.json e instalar dependências
COPY package*.json ./
RUN npm install

# Baixar o Chromium do Playwright
RUN npx playwright install chromium

# Copiar todo o código
COPY . .

# Variável de ambiente para produção
ENV NODE_ENV=production

# Porta que a aplicação vai usar
EXPOSE 10000

# Comando de inicialização
CMD ["npm", "start"]

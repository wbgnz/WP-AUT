#!/usr/bin/env bash
# Sair em caso de erro
set -o errexit

# 1. Instala as dependências do package.json
npm install

# 2. Define o caminho para o cache do Playwright dentro do nosso disco persistente
export PLAYWRIGHT_BROWSERS_PATH=/data/playwright-cache

# 3. Instala os navegadores no caminho especificado
npx playwright install

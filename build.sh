#!/usr/bin/env bash
# Sair imediatamente se um comando falhar
set -e

# Instala as dependências do package.json
npm install

# Instala os navegadores do Playwright da forma correta para o Render
npx playwright install --with-deps chromium

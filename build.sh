#!/usr/bin/env bash
# Sair em caso de erro
set -o errexit

# 1. Instala as dependências do package.json
npm install

# 2. Instala os navegadores do Playwright sem gerir as dependências do sistema
npx playwright install

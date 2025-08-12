#!/usr/bin/env bash

# Define o caminho para o cache do Playwright, usando a variável de ambiente que configurámos
export PLAYWRIGHT_BROWSERS_PATH=/data/playwright-cache

# Verifica se a pasta dos navegadores já existe no disco persistente
if [ ! -d "$PLAYWRIGHT_BROWSERS_PATH" ]; then
  echo "Cache de navegadores do Playwright não encontrado. A instalar..."
  # Se não existir, executa o comando de instalação
  npx playwright install
else
  echo "Cache de navegadores do Playwright encontrado. A saltar a instalação."
fi

# Finalmente, inicia o nosso motor
echo "A iniciar o motor..."
node worker.js

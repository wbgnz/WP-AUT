#!/usr/bin/env bash
# Sair imediatamente se um comando falhar
set -e

echo "--- Script de Arranque V3 ---"

# Define o caminho para o cache do Playwright, lendo da variável de ambiente
export PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH:-/data/playwright-cache}
echo "Caminho para navegadores definido como: $PLAYWRIGHT_BROWSERS_PATH"

echo "A garantir que o diretório de cache existe..."
# Cria o diretório se não existir (medida de segurança)
mkdir -p $PLAYWRIGHT_BROWSERS_PATH

echo "A tentar instalar/verificar o chromium..."
# A instalação do Playwright é inteligente e não descarrega se o navegador já existir
npx playwright install --with-deps chromium

echo "Verificação/Instalação do Playwright concluída."
echo "Listando conteúdo do diretório de cache para depuração:"
# Este comando irá mostrar-nos nos logs exatamente o que foi instalado
ls -la $PLAYWRIGHT_BROWSERS_PATH

# Finalmente, inicia o nosso motor
echo "A iniciar o motor (worker.js)..."
node worker.js

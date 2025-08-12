#!/usr/bin/env bash
# Sair imediatamente se um comando falhar
set -e

# Define o caminho para o cache do Playwright, lendo da variável de ambiente
export PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH:-/data/playwright-cache}

echo "--- Script de Arranque Inteligente V4 ---"
echo "A usar o caminho para navegadores: $PLAYWRIGHT_BROWSERS_PATH"

# Verifica se a pasta de cache existe e tem conteúdo
# O comando `find ... -type f | wc -l` conta o número de ficheiros dentro da pasta
if [ -d "$PLAYWRIGHT_BROWSERS_PATH" ] && [ $(find "$PLAYWRIGHT_BROWSERS_PATH" -type f | wc -l) -gt 5 ]; then
  echo "Cache de navegadores encontrado com conteúdo. A saltar a instalação."
else
  echo "Cache de navegadores não encontrado ou vazio. A instalar chromium..."
  # Cria o diretório se não existir (medida de segurança)
  mkdir -p $PLAYWRIGHT_BROWSERS_PATH
  # Executa o comando de instalação, apenas para o chromium
  npx playwright install --with-deps chromium
  echo "Instalação do chromium concluída."
fi

# Lista o conteúdo do diretório para depuração
echo "Listando conteúdo do diretório de cache:"
ls -la $PLAYWRIGHT_BROWSERS_PATH

# Finalmente, inicia o nosso motor
echo "A iniciar o motor (worker.js)..."
node worker.js

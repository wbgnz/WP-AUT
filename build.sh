#!/usr/bin/env bash
# Sair imediatamente se um comando falhar
set -e

echo "--- Script de Construção V5 (Definitivo) ---"

echo "A instalar dependências do npm..."
npm install

echo "A instalar o navegador Chromium (sem --with-deps)..."
# A CORREÇÃO ESTÁ AQUI: Removemos --with-deps para evitar a necessidade de permissões de administrador
npx playwright install chromium

echo "Construção concluída com sucesso."

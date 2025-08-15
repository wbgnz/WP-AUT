const { chromium } = require('playwright');
const admin = require('firebase-admin');
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage'); // Adicionado para o Storage

// --- CONFIGURAÇÕES ---
const IS_HEADLESS = process.env.NODE_ENV === 'production'; 
const SESSIONS_BASE_PATH = process.env.NODE_ENV === 'production' ? '/data/sessions' : './whatsapp_session_data';

// --- INICIALIZAÇÃO ---
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  serviceAccount = require('./firebase-service-account.json');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: `${process.env.FIREBASE_PROJECT_ID}.appspot.com` // Adicione esta linha
});
const db = getFirestore();
const bucket = getStorage().bucket(); // Inicializa o Storage

// --- FUNÇÕES DO ROBÔ (Humanização) ---
// ... (As funções delay, typeLikeHuman, handlePopups continuam as mesmas) ...

// --- FUNÇÃO PRINCIPAL DE EXECUÇÃO DA CAMPANHA ---
// ... (A função executarCampanha continua a mesma) ...

// --- FUNÇÃO INTELIGENTE PARA LOGIN COM QR CODE (COM UPLOAD DE SCREENSHOT) ---
async function handleConnectionLogin(connectionId) {
    let context;
    const connectionRef = db.collection('conexoes').doc(connectionId);
    const sessionPath = path.join(SESSIONS_BASE_PATH, connectionId);

    try {
        console.log(`[QR] Iniciando instância para conexão ${connectionId}`);
        context = await chromium.launchPersistentContext(sessionPath, { 
            headless: IS_HEADLESS,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
            viewport: { width: 1440, height: 900 }
        });
        const page = context.pages()[0] || await context.newPage();
        
        await page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded', timeout: 90000 });
        
        console.log(`[QR] A aguardar pelo QR Code...`);
        const qrLocator = page.locator('div[data-ref]');
        await qrLocator.waitFor({ state: 'visible', timeout: 60000 });
        const qrCodeData = await qrLocator.getAttribute('data-ref');
        await connectionRef.update({ status: 'awaiting_scan', qrCode: qrCodeData });

        console.log('[QR] QR Code visível. A aguardar leitura (timeout de 2 minutos)...');
        await qrLocator.waitFor({ state: 'hidden', timeout: 120000 });
        console.log('[QR] Leitura detetada! A validar a conexão...');

        const loggedInLocator = page.getByLabel('Caixa de texto de pesquisa');
        await loggedInLocator.waitFor({ state: 'visible', timeout: 60000 });

        console.log(`[VALIDAÇÃO] Sucesso! Conexão para ${connectionId} está ativa.`);
        await connectionRef.update({ status: 'conectado', qrCode: FieldValue.delete() });
        
    } catch (error) {
        console.error(`[QR] Erro ou timeout no processo de conexão para ${connectionId}:`, error);
        
        // --- SUA SUGESTÃO IMPLEMENTADA AQUI ---
        if (context) {
            const screenshotPath = `/tmp/erro_login_${connectionId}.png`; // Usa uma pasta temporária do sistema
            try {
                await context.pages()[0].screenshot({ path: screenshotPath });
                console.log(`[DEBUG] Screenshot temporário salvo em: ${screenshotPath}`);
                
                const destination = `debug_screenshots/erro_login_${connectionId}.png`;
                await bucket.upload(screenshotPath, {
                    destination: destination,
                    public: true // Torna o ficheiro publicamente acessível
                });

                const publicUrl = `https://storage.googleapis.com/${bucket.name}/${destination}`;
                console.log(`[DEBUG] Screenshot enviado para o Firebase Storage.`);
                console.log(`[DEBUG] URL PÚBLICA: ${publicUrl}`);

            } catch (uploadError) {
                console.error('[DEBUG] Falha ao fazer o upload do screenshot:', uploadError);
            }
        }
        // --- FIM DA IMPLEMENTAÇÃO ---

        try {
            await connectionRef.update({ 
                status: 'desconectado', 
                error: 'Falha na validação pós-scan. Screenshot gerado.',
                qrCode: FieldValue.delete()
            });
        } catch (updateError) {
            console.warn(`[QR] Não foi possível atualizar o status da conexão ${connectionId}:`, updateError.message);
        }

    } finally {
        if (context) {
            await context.close();
            console.log(`[QR] Instância para ${connectionId} fechada.`);
        }
    }
}

// --- CONFIGURAÇÃO DO SERVIDOR DE API ---
// ... (O resto do código do servidor continua o mesmo) ...

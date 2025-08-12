const { chromium } = require('playwright');
const admin = require('firebase-admin');
const express = require('express');
const cors = require('cors');
const path = require('path');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// --- CONFIGURAÇÕES ---
const IS_HEADLESS = process.env.NODE_ENV === 'production'; 
const SESSIONS_BASE_PATH = process.env.NODE_ENV === 'production' ? '/data/sessions' : './whatsapp_session_data';
const SCREENSHOTS_PATH = process.env.NODE_ENV === 'production' ? '/data/screenshots' : './screenshots';

// --- INICIALIZAÇÃO ---
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  serviceAccount = require('./firebase-service-account.json');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = getFirestore();

// --- FUNÇÕES DO ROBÔ (Humanização) ---
function delay(minSeconds, maxSeconds) { 
    const ms = (Math.random() * (maxSeconds - minSeconds) + minSeconds) * 1000; 
    console.log(`[HUMANIZADOR] Pausa de ${Math.round(ms/1000)} segundos...`); 
    return new Promise(resolve => setTimeout(resolve, ms)); 
}

async function typeLikeHuman(locator, text) { 
    console.log('[HUMANIZADOR] Clicando no campo para focar...'); 
    await locator.click(); 
    console.log('[HUMANIZADOR] Simulando digitação...'); 
    await locator.type(text, { delay: Math.random() * 120 + 40 }); 
}

async function handlePopups(page) { 
    console.log('[FASE 2] Verificando a presença de pop-ups...'); 
    const possibleSelectors = [ 
        page.getByRole('button', { name: 'Continuar' }), 
        page.getByRole('button', { name: /OK|Entendi|Concluir/i }), 
        page.getByLabel('Fechar', { exact: true }) 
    ]; 
    for (const selector of possibleSelectors) { 
        try { 
            await selector.waitFor({ timeout: 3000 }); 
            await selector.click({ force: true }); 
            console.log('[FASE 2] Pop-up fechado.'); 
            return; 
        } catch (error) {} 
    } 
    console.log('[FASE 2] Nenhum pop-up conhecido foi encontrado.'); 
}

// --- FUNÇÃO PRINCIPAL DE EXECUÇÃO DA CAMPANHA ---
async function executarCampanha(campanha) {
  // ... (Esta função continua a mesma) ...
}

// --- FUNÇÃO INTELIGENTE PARA LOGIN COM QR CODE (ATUALIZADA) ---
async function handleConnectionLogin(connectionId) {
    let context;
    const connectionRef = db.collection('conexoes').doc(connectionId);
    const sessionPath = path.join(SESSIONS_BASE_PATH, connectionId);
    const TIMEOUT_MS = 120000; // 2 minutos
    const startTime = Date.now();

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
        
        console.log(`[QR] A procurar por QR Code ou sessão ativa...`);
        
        let lastQrCode = null;

        while (Date.now() - startTime < TIMEOUT_MS) {
            try {
                await page.waitForSelector('div#pane-side', { state: 'visible', timeout: 1000 });
                console.log(`[QR] Login bem-sucedido para ${connectionId}!`);
                await connectionRef.update({
                    status: 'conectado',
                    qrCode: FieldValue.delete(),
                });
                if (context) await context.close();
                return;
            } catch (e) { /* Login ainda não aconteceu, o que é normal. Continue... */ }

            try {
                const qrLocator = page.locator('div[data-ref]');
                await qrLocator.waitFor({ state: 'visible', timeout: 5000 });
                const qrCodeData = await qrLocator.getAttribute('data-ref');

                if (qrCodeData && qrCodeData !== lastQrCode) {
                    console.log(`[QR] QR Code detectado/atualizado. Atualizando Firestore.`);
                    await connectionRef.update({
                        status: 'awaiting_scan',
                        qrCode: qrCodeData,
                    });
                    lastQrCode = qrCodeData;
                }
            } catch (e) {
                console.log(`[QR] QR code não visível, aguardando...`);
            }
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
        throw new Error('Timeout de 2 minutos atingido.');
        
    } catch (error) {
        console.error(`[QR] Erro ou timeout no processo de conexão para ${connectionId}:`, error);
        
        if (context) {
            try {
                const screenshotDir = path.join(SESSIONS_BASE_PATH, 'screenshots');
                if (!require('fs').existsSync(screenshotDir)) {
                    require('fs').mkdirSync(screenshotDir, { recursive: true });
                }
                const screenshotPath = path.join(screenshotDir, `erro_qr_${connectionId}.png`);
                await context.pages()[0].screenshot({ path: screenshotPath });
                console.log(`[DEBUG] Screenshot de erro salvo em: ${screenshotPath}`);
            } catch (screenshotError) {
                console.error('[DEBUG] Falha ao tirar screenshot:', screenshotError);
            }
        }
        
        // CORREÇÃO: Tratamento de erro resiliente
        try {
            await connectionRef.update({ 
                status: 'desconectado', 
                error: 'Timeout: QR Code não foi escaneado em 2 minutos.',
                qrCode: FieldValue.delete()
            });
        } catch (updateError) {
            console.warn(`[QR] Não foi possível atualizar o status da conexão ${connectionId} (provavelmente foi apagada):`, updateError.message);
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
const app = express();
app.use(cors()); 
app.use(express.json());
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => {
  res.send('Motor de automação do WhatsApp está online e pronto.');
});
app.post('/start-campaign', async (req, res) => {
  const { campaignId } = req.body;
  if (!campaignId) return res.status(400).send({ error: 'campaignId é obrigatório.' });
  console.log(`[API] Pedido recebido para iniciar a campanha: ${campaignId}`);
  res.status(202).send({ message: 'Campanha aceite.' });
  try {
    const campaignDoc = await db.collection('campanhas').doc(campaignId).get();
    if (!campaignDoc.exists) throw new Error('Campanha não encontrada.');
    const campanha = { id: campaignDoc.id, ...campaignDoc.data() };
    executarCampanha(campanha);
  } catch (error) {
    console.error(`[API] Erro ao iniciar a campanha ${campaignId}:`, error);
  }
});
app.post('/connections', async (req, res) => {
  const { name } = req.body;
  if (!name) {
    return res.status(400).send({ error: 'O nome da conexão é obrigatório.' });
  }
  try {
    const connectionRef = await db.collection('conexoes').add({
      name: name,
      status: 'generating_qrcode',
      criadoEm: FieldValue.serverTimestamp(),
    });
    res.status(201).send({ id: connectionRef.id, message: 'Conexão criada.' });
    handleConnectionLogin(connectionRef.id);
  } catch (error) {
    console.error('[API] Erro ao criar conexão:', error);
    res.status(500).send({ error: 'Falha ao criar conexão.' });
  }
});
app.get('/connections/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const connectionDoc = await db.collection('conexoes').doc(id).get();
        if (!connectionDoc.exists) return res.status(404).send({ error: 'Conexão não encontrada.' });
        res.status(200).send({ id: connectionDoc.id, ...connectionDoc.data() });
    } catch (error) {
        console.error(`[API] Erro ao buscar status da conexão ${id}:`, error);
        res.status(500).send({ error: 'Falha ao buscar status da conexão.' });
    }
});
app.listen(PORT, () => {
  console.log(`[WORKER] Motor iniciado como servidor de API na porta ${PORT}.`);
});

const { chromium } = require('playwright');
const admin = require('firebase-admin');
const express = require('express');
const cors = require('cors');
const path = require('path');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// --- CONFIGURAÇÕES E INICIALIZAÇÃO ---
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  serviceAccount = require('./firebase-service-account.json');
}

const SESSIONS_BASE_PATH = '/data/sessions'; 
const SCREENSHOTS_PATH = '/data/screenshots';

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

// --- NOVA FUNÇÃO INTELIGENTE PARA LOGIN COM CÓDIGO ---
async function handleConnectionLogin(connectionId) {
    let context;
    const connectionRef = db.collection('conexoes').doc(connectionId);
    const sessionPath = path.join(SESSIONS_BASE_PATH, connectionId);
    const TIMEOUT_MS = 120000; // 2 minutos
    const startTime = Date.now();

    try {
        console.log(`[LOGIN] Iniciando instância para conexão ${connectionId}`);
        context = await chromium.launchPersistentContext(sessionPath, { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = context.pages()[0] || await context.newPage();
        
        await page.goto('https://web.whatsapp.com');
        console.log(`[LOGIN] Aguardando página de login para ${connectionId}...`);

        while (Date.now() - startTime < TIMEOUT_MS) {
            // 1. Verifica se já fez login (sucesso)
            try {
                await page.waitForSelector('div#pane-side', { state: 'visible', timeout: 1000 });
                console.log(`[LOGIN] Login bem-sucedido para ${connectionId}!`);
                await connectionRef.update({
                    status: 'conectado',
                    loginCode: FieldValue.delete(),
                });
                if (context) await context.close();
                return;
            } catch (e) { /* Login ainda não aconteceu, continue... */ }

            // 2. Procura pelo link "Conectar com número de telefone"
            try {
                const linkButton = page.getByText('Conectar com número de telefone');
                if (await linkButton.isVisible()) {
                    await linkButton.click();
                    console.log('[LOGIN] Clicou em "Conectar com número de telefone".');
                    await connectionRef.update({ status: 'generating_code' });
                }
            } catch(e) { /* Link não encontrado ou já clicado, continue... */ }

            // 3. Procura pelo código de 8 caracteres
            try {
                const codeLocator = page.locator('div[data-testid="link-device-phone-number-code-screen-code"] span');
                await codeLocator.first().waitFor({ state: 'visible', timeout: 5000 });
                
                const codeParts = await codeLocator.allTextContents();
                const loginCode = codeParts.join('').replace(/-/g, '');

                if (loginCode && loginCode.length === 8) {
                    console.log(`[LOGIN] Código detectado: ${loginCode}. Atualizando Firestore.`);
                    await connectionRef.update({
                        status: 'awaiting_code_entry',
                        loginCode: loginCode,
                    });
                }
            } catch (e) {
                console.log(`[LOGIN] Código de login não visível, aguardando...`);
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        throw new Error('Timeout de 2 minutos atingido.');
    } catch (error) {
        console.error(`[LOGIN] Erro ou timeout no processo de conexão para ${connectionId}:`, error);
        await connectionRef.update({
            status: 'desconectado',
            error: 'Timeout: O código não foi inserido em 2 minutos.',
            loginCode: FieldValue.delete(),
        });
    } finally {
        if (context) {
            await context.close();
            console.log(`[LOGIN] Instância para ${connectionId} fechada.`);
        }
    }
}


// --- CONFIGURAÇÃO DO SERVIDOR DE API ---
const app = express();
app.use(cors()); 
app.use(express.json());
const PORT = process.env.PORT || 10000;

// ... (endpoints / e /start-campaign continuam os mesmos) ...

app.post('/connections', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).send({ error: 'O nome da conexão é obrigatório.' });
  try {
    const connectionRef = await db.collection('conexoes').add({
      name: name,
      status: 'generating_code', // Status inicial
      criadoEm: FieldValue.serverTimestamp(),
    });
    res.status(201).send({ id: connectionRef.id, message: 'Conexão criada.' });
    // Dispara a nova função de login
    handleConnectionLogin(connectionRef.id);
  } catch (error) {
    console.error('[API] Erro ao criar conexão:', error);
    res.status(500).send({ error: 'Falha ao criar conexão.' });
  }
});

app.get('/connections/:id', async (req, res) => {
    // ... (este endpoint continua o mesmo) ...
});

app.listen(PORT, () => {
  console.log(`[WORKER] Motor iniciado como servidor de API na porta ${PORT}.`);
});

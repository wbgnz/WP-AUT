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

const SESSIONS_BASE_PATH = './whatsapp_session_data'; 

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = getFirestore();

// --- FUNÇÃO INTELIGENTE PARA LOGIN COM CÓDIGO (ATUALIZADA) ---
async function handleConnectionLogin(connectionId, phoneNumber) {
    let context;
    const connectionRef = db.collection('conexoes').doc(connectionId);
    const sessionPath = path.join(SESSIONS_BASE_PATH, connectionId);
    const TIMEOUT_MS = 120000; // 2 minutos
    const startTime = Date.now();

    try {
        console.log(`[LOGIN] Iniciando instância para conexão ${connectionId}`);
        context = await chromium.launchPersistentContext(sessionPath, { 
            headless: false, // Deixamos visível para depuração local
            args: ['--no-sandbox', '--disable-setuid-sandbox'] 
        });
        const page = context.pages()[0] || await context.newPage();
        
        await page.goto('https://web.whatsapp.com');
        console.log(`[LOGIN] Aguardando página de login para ${connectionId}...`);

        // 1. Clica no link "Conectar com número de telefone"
        const linkButton = page.getByText('Conectar com o número de telefone');
        await linkButton.waitFor({ state: 'visible', timeout: 60000 });
        await linkButton.click();
        console.log('[LOGIN] Clicou em "Conectar com número de telefone".');

        // 2. Insere o número de telefone
        const numberWithoutCountryCode = phoneNumber.substring(2);
        const phoneInput = page.getByLabel('Número de telefone');
        await phoneInput.waitFor({ state: 'visible', timeout: 10000 });
        await phoneInput.fill(numberWithoutCountryCode);
        console.log(`[LOGIN] Inseriu o número: ${numberWithoutCountryCode}`);

        // 3. Clica em "Avançar"
        const nextButton = page.getByRole('button', { name: 'Avançar' });
        await nextButton.click();
        console.log('[LOGIN] Clicou em "Avançar".');
        
        // 4. Loop para ler o código e verificar o login
        while (Date.now() - startTime < TIMEOUT_MS) {
            // Verifica se já fez login (sucesso)
            try {
                await page.waitForSelector('div#pane-side', { state: 'visible', timeout: 1000 });
                console.log(`[LOGIN] Login bem-sucedido para ${connectionId}!`);
                await connectionRef.update({ status: 'conectado', loginCode: FieldValue.delete() });
                if (context) await context.close();
                return;
            } catch (e) { /* Continue... */ }

            // Procura pelo código de 8 caracteres
            try {
                const codeLocator = page.locator('div[data-testid="link-device-phone-number-code-screen-code"] span');
                await codeLocator.first().waitFor({ state: 'visible', timeout: 5000 });
                const codeParts = await codeLocator.allTextContents();
                const loginCode = codeParts.join('').replace(/-/g, '');

                if (loginCode && loginCode.length === 8) {
                    console.log(`[LOGIN] Código detectado: ${loginCode}. Atualizando Firestore.`);
                    await connectionRef.update({ status: 'awaiting_code_entry', loginCode: loginCode });
                }
            } catch (e) {
                console.log(`[LOGIN] Código de login não visível, aguardando...`);
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        throw new Error('Timeout de 2 minutos atingido.');
        
    } catch (error) {
        console.error(`[LOGIN] Erro ou timeout no processo de conexão para ${connectionId}:`, error);
        await connectionRef.update({ status: 'desconectado', error: 'Falha no processo de login.' });
    } finally {
        if (context) {
            await context.close();
            console.log(`[LOGIN] Instância para ${connectionId} fechada.`);
        }
    }
}

// --- CONFIGURAÇÃO DO SERVIDOR DE API (ATUALIZADA) ---
const app = express();
app.use(cors()); 
app.use(express.json());
const PORT = process.env.PORT || 10000;

app.post('/connections', async (req, res) => {
  const { name, phoneNumber } = req.body; // Agora recebe o número
  if (!name || !phoneNumber) {
    return res.status(400).send({ error: 'O nome e o número de telefone são obrigatórios.' });
  }
  try {
    const connectionRef = await db.collection('conexoes').add({
      name: name,
      phoneNumber: phoneNumber,
      status: 'generating_code',
      criadoEm: FieldValue.serverTimestamp(),
    });
    res.status(201).send({ id: connectionRef.id, message: 'Conexão criada.' });
    handleConnectionLogin(connectionRef.id, phoneNumber); // Passa o número para a função
  } catch (error) {
    console.error('[API] Erro ao criar conexão:', error);
    res.status(500).send({ error: 'Falha ao criar conexão.' });
  }
});

app.listen(PORT, () => {
  console.log(`[WORKER] Motor iniciado como servidor de API na porta ${PORT}.`);
});

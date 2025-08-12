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
  console.log(`[WORKER] Iniciando execução da campanha ID: ${campanha.id}`);
  const campanhaRef = db.collection('campanhas').doc(campanha.id);
  let context;

  const connectionId = campanha.connectionId;
  if (!connectionId) {
    throw new Error('ID da conexão não foi fornecido na campanha.');
  }
  const sessionPath = path.join(SESSIONS_BASE_PATH, connectionId);
  console.log(`[WORKER] A usar a sessão em: ${sessionPath}`);

  try {
    await campanhaRef.update({ status: 'rodando' });
    let contatosParaEnviar = [];
    if (campanha.tipo === 'quantity') {
      const q = db.collection('contatos').where('status', '==', 'disponivel').orderBy('criadoEm', 'asc').limit(campanha.totalContatos);
      const snapshot = await q.get();
      contatosParaEnviar = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    } else {
      const contactIds = campanha.contactIds;
      const promises = contactIds.map(id => db.collection('contatos').doc(id).get());
      const results = await Promise.all(promises);
      contatosParaEnviar = results.filter(d => d.exists && d.data().status === 'disponivel').map(d => ({ id: d.id, ...d.data() }));
    }
    if (contatosParaEnviar.length === 0) throw new Error('Nenhum contato válido encontrado para esta campanha.');
    
    context = await chromium.launchPersistentContext(sessionPath, { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = context.pages()[0];
    page.setDefaultTimeout(90000);
    await page.goto('https://web.whatsapp.com');
    await page.waitForSelector('div#pane-side', { state: 'visible' });
    await handlePopups(page);
    const mensagemTemplate = campanha.mensagemTemplate;

    for (const contato of contatosParaEnviar) {
      console.log(`[DISPARO] Preparando para ${contato.nome || contato.numero}`);
      let mensagemFinal = mensagemTemplate.replace(new RegExp(`{{nome}}`, 'g'), contato.nome);
      await page.goto(`https://web.whatsapp.com/send?phone=${contato.numero}`);
      const messageBox = page.getByRole('textbox', { name: 'Digite uma mensagem' }).getByRole('paragraph');
      await messageBox.waitFor();
      await typeLikeHuman(messageBox, mensagemFinal);
      const sendButton = page.getByLabel('Enviar');
      await sendButton.click();
      const contatoRef = db.collection('contatos').doc(contato.id);
      await contatoRef.update({ status: 'usado' });
      console.log(`[WORKER] Contato ${contato.nome} atualizado para 'usado'.`);
      await delay(campanha.minDelay, campanha.maxDelay);
    }
    await campanhaRef.update({ status: 'concluida' });
    console.log(`[WORKER] Campanha ID: ${campanha.id} concluída com sucesso!`);
  } catch (error) {
    console.error(`[WORKER] Erro ao executar campanha ID: ${campanha.id}.`, error);
    await campanhaRef.update({ status: 'erro', erroMsg: error.message });
  } finally {
    if (context) {
      await context.close();
    }
  }
}

// --- FUNÇÃO INTELIGENTE PARA LOGIN COM CÓDIGO ---
async function handleConnectionLogin(connectionId, phoneNumber) {
    let context;
    const connectionRef = db.collection('conexoes').doc(connectionId);
    const sessionPath = path.join(SESSIONS_BASE_PATH, connectionId);
    const TIMEOUT_MS = 120000; // 2 minutos
    const startTime = Date.now();

    try {
        console.log(`[LOGIN] Iniciando instância para conexão ${connectionId}`);
        context = await chromium.launchPersistentContext(sessionPath, { 
            headless: true, 
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

// --- CONFIGURAÇÃO DO SERVIDOR DE API ---
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
  const { name, phoneNumber } = req.body;
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
    handleConnectionLogin(connectionRef.id, phoneNumber);
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

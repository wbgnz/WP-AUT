const { chromium } = require('playwright');
const admin = require('firebase-admin');
const express = require('express');
const cors = require('cors');
const path = require('path');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// --- CONFIGURAÇÕES ---
const IS_HEADLESS = process.env.NODE_ENV === 'production'; 
const SESSIONS_BASE_PATH = process.env.NODE_ENV === 'production' ? '/data/sessions' : './whatsapp_session_data';

// --- INICIALIZAÇÃO ---
let serviceAccount;
try {
  serviceAccount = require('./firebase-service-account.json');
} catch (error) {
  console.error("Erro: O arquivo 'firebase-service-account.json' não foi encontrado.");
  process.exit(1);
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

// --- FUNÇÃO DE POP-UPS ATUALIZADA ---
async function handlePopups(page) { 
    console.log('[POPUP CHECK] Verificando a presença de pop-ups...'); 
    const possiblePopups = [ 
        { locator: page.getByRole('button', { name: 'Continue', exact: true }), name: 'Novo Visual (Continue)' },
        { locator: page.getByRole('button', { name: 'Continuar' }), name: 'Continuar Geral' }, 
        { locator: page.getByRole('button', { name: /OK|Entendi|Concluir/i }), name: 'Popup de Informação' }, 
        { locator: page.getByLabel('Fechar', { exact: true }), name: 'Botão Fechar (X)' } 
    ]; 
    
    for (const popup of possiblePopups) { 
        try { 
            await popup.locator.waitFor({ timeout: 3000 });
            console.log(`[POPUP CHECK] Popup "${popup.name}" encontrado! A fechar...`);
            await popup.locator.click({ force: true }); 
            console.log(`[POPUP CHECK] Popup "${popup.name}" fechado com sucesso.`);
            return;
        } catch (error) {
            // Continua para o próximo
        } 
    } 
    console.log('[POPUP CHECK] Nenhum pop-up conhecido foi encontrado.'); 
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
    
    context = await chromium.launchPersistentContext(sessionPath, { 
        headless: IS_HEADLESS, 
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
        viewport: { width: 1440, height: 900 }
    });
    const page = context.pages()[0];
    page.setDefaultTimeout(90000);
    await page.goto('https://web.whatsapp.com');
    
    console.log('[WORKER] A aguardar o carregamento completo da interface...');
    // A SUA SUGESTÃO IMPLEMENTADA: Espera o "Loading chats" desaparecer
    await page.locator('progress').waitFor({ state: 'hidden', timeout: 120000 });
    await page.getByLabel('Caixa de texto de pesquisa').waitFor({ state: 'visible' });
    console.log('[WORKER] Interface principal detetada e estável.');
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

// --- FUNÇÃO DE LOGIN COM QR CODE (PRODUÇÃO) ---
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

        console.log('[QR] QR Code visível. Por favor, escaneie. A aguardar leitura...');
        await qrLocator.waitFor({ state: 'hidden', timeout: 120000 });
        console.log('[QR] Leitura detetada! A validar a conexão...');

        // A SUA SUGESTÃO IMPLEMENTADA: Espera o "Loading chats" desaparecer
        await page.locator('progress').waitFor({ state: 'hidden', timeout: 120000 });
        const loggedInLocator = page.getByLabel('Caixa de texto de pesquisa');
        await loggedInLocator.waitFor({ state: 'visible', timeout: 60000 });
        
        console.log('[QR] Login confirmado e estável.');
        await handlePopups(page);

        console.log(`[VALIDAÇÃO] Sucesso! Conexão para ${connectionId} está ativa.`);
        await connectionRef.update({ status: 'conectado', qrCode: FieldValue.delete() });
        
    } catch (error) {
        console.error(`[QR] Erro no processo de conexão para ${connectionId}:`, error);
        await connectionRef.update({ status: 'desconectado', error: error.message });
    } finally {
        if (context) {
            await context.close();
            console.log(`[QR] Instância para ${connectionId} fechada.`);
        }
    }
}

// --- CONFIGURAÇÃO DO SERVIDOR DE API ---
const app = express();
app.use(cors()); 
app.use(express.json());
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.send('Motor de automação do WhatsApp está online.');
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
  console.log(`[WORKER] Motor iniciado na porta ${PORT}.`);
});

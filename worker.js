// worker.js
const { chromium } = require('playwright');
const admin = require('firebase-admin');
const express = require('express');
const cors = require('cors');
const path = require('path');
const { getFirestore } = require('firebase-admin/firestore');

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
  credential: admin.credential.cert(serviceAccount)
});
const db = getFirestore();
const FieldValue = admin.firestore.FieldValue;

// --- FUNÇÕES DO ROBÔ (Humanização) ---
function delay(minSeconds = 2, maxSeconds = 5) {
  const ms = (Math.random() * (maxSeconds - minSeconds) + minSeconds) * 1000;
  console.log(`[HUMANIZADOR] Pausa de ${Math.round(ms / 1000)} segundos...`);
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
    page.getByLabel('Fechar', { exact: true }),
  ];
  for (const selector of possibleSelectors) {
    try {
      await selector.waitFor({ timeout: 3000 });
      await selector.click({ force: true });
      console.log('[FASE 2] Pop-up fechado.');
      return;
    } catch (error) { /* não encontrado, seguir */ }
  }
  console.log('[FASE 2] Nenhum pop-up conhecido foi encontrado.');
}

// --- HELPERS PARA LOGIN/DETECÇÃO ---
function getLoggedInLocator(page) {
  // Seletores abrangentes para diferentes idiomas e estruturas
  return page.locator(
    'div[title="Caixa de texto de pesquisa"], ' +
    'div[title="Pesquisar ou começar uma nova conversa"], ' +
    'div[title="Search or start new chat"], ' +
    '#pane-side, ' +
    'div[role="grid"]'
  );
}

async function waitForLoggedIn(page, timeoutMs = 90000) {
  const locator = getLoggedInLocator(page);
  try {
    await locator.waitFor({ state: 'visible', timeout: timeoutMs });
    return true;
  } catch (e) {
    return false;
  }
}

// --- FUNÇÃO PRINCIPAL DE EXECUÇÃO DA CAMPANHA ---
async function executarCampanha(campanha) {
  console.log(`[WORKER] Iniciando execução da campanha ID: ${campanha.id}`);
  const campanhaRef = db.collection('campanhas').doc(campanha.id);
  let context;

  const connectionId = campanha.connectionId;
  if (!connectionId) {
    console.error('[WORKER] Campanha sem connectionId.');
    await campanhaRef.update({ status: 'erro', erroMsg: 'connectionId ausente' });
    return;
  }

  const sessionPath = path.join(SESSIONS_BASE_PATH, connectionId);
  console.log(`[WORKER] A usar a sessão em: ${sessionPath}`);

  try {
    await campanhaRef.update({ status: 'rodando' });

    // Buscar contatos
    let contatosParaEnviar = [];
    if (campanha.tipo === 'quantity') {
      const q = db.collection('contatos').where('status', '==', 'disponivel').orderBy('criadoEm', 'asc').limit(campanha.totalContatos);
      const snapshot = await q.get();
      contatosParaEnviar = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    } else {
      const contactIds = campanha.contactIds || [];
      const promises = contactIds.map(id => db.collection('contatos').doc(id).get());
      const results = await Promise.all(promises);
      contatosParaEnviar = results.filter(d => d.exists && d.data().status === 'disponivel').map(d => ({ id: d.id, ...d.data() }));
    }

    if (contatosParaEnviar.length === 0) throw new Error('Nenhum contato válido encontrado para esta campanha.');

    // Lançar contexto com sessão persistente
    context = await chromium.launchPersistentContext(sessionPath, {
      headless: IS_HEADLESS,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 900 }
    });

    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(90000);

    await page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded', timeout: 90000 });

    // Aguardar login (evita tentar enviar sem estar logado)
    const logged = await waitForLoggedIn(page, 90000);
    if (!logged) throw new Error('Sessão não autenticada: não foi detectado login no WhatsApp Web.');

    await handlePopups(page);

    const mensagemTemplate = campanha.mensagemTemplate || '';

    for (const contato of contatosParaEnviar) {
      try {
        console.log(`[DISPARO] Preparando para ${contato.nome || contato.numero}`);
        let mensagemFinal = mensagemTemplate.replace(new RegExp(`{{nome}}`, 'g'), contato.nome || '');

        // Abrir conversa do contato
        await page.goto(`https://web.whatsapp.com/send?phone=${contato.numero}`, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Selecionar a caixa de mensagem de forma genérica (contenteditable)
        const messageBox = page.locator('div[contenteditable="true"][data-tab]').last();
        await messageBox.waitFor({ state: 'visible', timeout: 30000 });

        await typeLikeHuman(messageBox, mensagemFinal);

        // Enviar pressionando Enter (mais robusto que buscar botão com label)
        await messageBox.press('Enter');

        // Atualizar contato
        const contatoRef = db.collection('contatos').doc(contato.id);
        await contatoRef.update({ status: 'usado', atualizadoEm: FieldValue.serverTimestamp() });
        console.log(`[WORKER] Contato ${contato.nome || contato.numero} atualizado para 'usado'.`);

        await delay(campanha.minDelay || 2, campanha.maxDelay || 5);
      } catch (innerErr) {
        console.warn(`[WORKER] Erro ao enviar para ${contato.nome || contato.numero}:`, innerErr.message);
        // Opcional: marcar contato como 'erro' ou deixar como 'disponivel' para reuso
      }
    }

    await campanhaRef.update({ status: 'concluida', concluidaEm: FieldValue.serverTimestamp() });
    console.log(`[WORKER] Campanha ID: ${campanha.id} concluída com sucesso!`);
  } catch (error) {
    console.error(`[WORKER] Erro ao executar campanha ID: ${campanha.id}.`, error);
    try {
      await campanhaRef.update({ status: 'erro', erroMsg: error.message, atualizadoEm: FieldValue.serverTimestamp() });
    } catch (e) {
      console.warn('[WORKER] Não foi possível atualizar o documento da campanha com o erro:', e.message);
    }
  } finally {
    if (context) {
      try {
        await context.close();
      } catch (e) { /* ignore */ }
    }
  }
}

// --- FUNÇÃO INTELIGENTE PARA LOGIN COM QR CODE (AJUSTADA PARA RENDER) ---
async function handleConnectionLogin(connectionId) {
  let context = null;
  const connectionRef = db.collection('conexoes').doc(connectionId);
  const sessionPath = path.join(SESSIONS_BASE_PATH, connectionId);
  const TIMEOUT_MS = 180000; // 3 minutos
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
    const qrLocator = page.locator('div[data-ref], canvas'); // canvas pode aparecer em algumas versões
    const loggedInLocator = getLoggedInLocator(page);

    while (Date.now() - startTime < TIMEOUT_MS) {
      try {
        // tentar detectar estado atual rapidamente
        const loggedVisible = await loggedInLocator.isVisible().catch(() => false);
        const qrVisible = await qrLocator.isVisible().catch(() => false);

        if (loggedVisible) {
          console.log(`[QR] Login bem-sucedido para ${connectionId}!`);
          await connectionRef.update({
            status: 'conectado',
            qrCode: FieldValue.delete(),
            conectadoEm: FieldValue.serverTimestamp()
          });
          // fechar contexto e sair da função
          await context.close();
          context = null;
          return;
        }

        if (qrVisible) {
          // tentar ler atributo data-ref (quando existe)
          const qrCodeData = await qrLocator.first().getAttribute('data-ref').catch(() => null);
          if (qrCodeData && qrCodeData !== lastQrCode) {
            console.log(`[QR] QR Code detectado/atualizado. Atualizando Firestore.`);
            await connectionRef.update({
              status: 'awaiting_scan',
              qrCode: qrCodeData,
              atualizadoEm: FieldValue.serverTimestamp()
            });
            lastQrCode = qrCodeData;
          }
        } else {
          // Se nem QR nem login estiver visível, apenas logar para debug
          console.log(`[QR] Nem QR nem indicador de login visíveis ainda (tempo decorrido ${Math.round((Date.now()-startTime)/1000)}s).`);
        }
      } catch (e) {
        console.log(`[QR] Erro interno ao verificar elementos: ${e.message}`);
      }

      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    throw new Error('Timeout de 3 minutos atingido.');
  } catch (error) {
    console.error(`[QR] Erro ou timeout no processo de conexão para ${connectionId}:`, error);

    try {
      await connectionRef.update({
        status: 'desconectado',
        error: 'Timeout: QR Code não foi escaneado em 3 minutos.',
        qrCode: FieldValue.delete(),
        atualizadoEm: FieldValue.serverTimestamp()
      });
    } catch (updateError) {
      console.warn(`[QR] Não foi possível atualizar o status da conexão ${connectionId}:`, updateError.message);
    }
  } finally {
    if (context) {
      try {
        await context.close();
      } catch (e) { /* ignore */ }
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
    // executar assincronamente (não await para não travar resposta HTTP)
    executarCampanha(campanha).catch(err => {
      console.error('[API] Erro em executarCampanha (async):', err.message);
    });
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
    // inicia processo de login (async)
    handleConnectionLogin(connectionRef.id).catch(err => {
      console.error(`[API] handleConnectionLogin erro async para ${connectionRef.id}:`, err.message);
    });
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

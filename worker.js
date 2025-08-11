// worker-full.js
const { chromium } = require('playwright');
const admin = require('firebase-admin');
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { getFirestore } = require('firebase-admin/firestore');

// --- CONFIGURAÇÕES E INICIALIZAÇÃO ---
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

// Diretório base para sessões (cada cliente terá sua subpasta)
const SESSIONS_BASE = path.join('/tmp', 'whatsapp_sessions');
if (!fs.existsSync(SESSIONS_BASE)) fs.mkdirSync(SESSIONS_BASE, { recursive: true });

// --- MONITORAMENTO DO SISTEMA ---
process.on('SIGTERM', () => {
  console.log('[SYSTEM] Recebido SIGTERM. Encerrando processo...');
  logMemoryUsage();
  process.exit(0);
});

function logMemoryUsage() {
  const used = process.memoryUsage();
  console.log('[MEMÓRIA] Uso atual:', {
    rss: `${Math.round(used.rss / 1024 / 1024)} MB`,
    heapTotal: `${Math.round(used.heapTotal / 1024 / 1024)} MB`,
    heapUsed: `${Math.round(used.heapUsed / 1024 / 1024)} MB`
  });
}

function delay(minSeconds = 1, maxSeconds = 3) {
  const ms = (Math.random() * (maxSeconds - minSeconds) + minSeconds) * 1000;
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Digitação "humana" - opcional para usar em campanhas
async function typeLikeHuman(locator, text) {
  await locator.click();
  await locator.type(text, { delay: Math.random() * 120 + 40 });
}

// --- FUNÇÃO PARA EXTRAIR O CÓDIGO NUMÉRICO (OU ALFANUMÉRICO) ---
async function extrairCodigoNumeric(page) {
  // Espera texto guia existir
  await page.waitForSelector('text=Insira o código no seu celular', { timeout: 60000 });

  // Executa no browser para tentar extrair o código de forma robusta
  const codigo = await page.evaluate(() => {
    // procura um elemento que contenha o texto guia
    const xpath = "//div[contains(., 'Insira o código no seu celular') or contains(., 'Insira o código')]";
    const node = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    if (!node) return null;

    // Coleta text nodes dentro do container
    function getTextNodes(root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
      const texts = [];
      let n;
      while ((n = walker.nextNode())) {
        const t = n.nodeValue.trim();
        if (t) texts.push(t);
      }
      return texts;
    }

    const texts = getTextNodes(node);
    const joined = texts.join(' ');
    // tenta extrair algo no padrão tipo "AB12-C34X" ou "1234-5678" ou "TSC8-E94X"
    const match = joined.match(/[A-Z0-9]{2,}(-[A-Z0-9]{2,})*/i);
    if (match) return match[0].toUpperCase();
    // fallback: retorna o conteúdo textual acumulado
    return joined.trim().substring(0, 50);
  });

  return codigo;
}

// --- FUNÇÃO DE LOGIN POR NÚMERO (captura código e monitora login) ---
async function iniciarLoginPorNumero(numero, clienteId) {
  const sessionDir = path.join(SESSIONS_BASE, `${clienteId}`);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const context = await chromium.launchPersistentContext(sessionDir, {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await context.newPage();
  await page.goto(`https://web.whatsapp.com/send?phone=${numero}`, { waitUntil: 'domcontentloaded' });

  // Aguarda a página colocar o widget de login (pode ser QR code OU código numérico)
  // Primeiro tentamos detectar a tela de código numérico
  let codigo = null;
  try {
    codigo = await extrairCodigoNumeric(page);
  } catch (err) {
    console.log('[LOGIN] Tela de código numérico não detectada ou extração falhou:', err.message || err);
  }

  // Se não extraiu código numérico, tentamos capturar QR code (canvas) como fallback
  let qrBase64 = null;
  try {
    if (!codigo) {
      // tenta selector de canvas do QR
      const qrLocator = page.locator('canvas');
      if (await qrLocator.count() > 0) {
        const buffer = await qrLocator.first().screenshot();
        qrBase64 = buffer.toString('base64');
      }
    }
  } catch (err) {
    console.log('[LOGIN] não foi possível capturar QR. Erro:', err.message || err);
  }

  // Salva no Firestore o doc de login com informações iniciais
  const docRef = db.collection('logins').doc(clienteId);
  const payloadInit = {
    numero,
    status: 'aguardando_confirmacao',
    criadoEm: admin.firestore.FieldValue.serverTimestamp()
  };
  if (codigo) payloadInit.codigo = codigo;
  if (qrBase64) payloadInit.qr = `data:image/png;base64,${qrBase64}`;

  await docRef.set(payloadInit);

  // Inicia monitoramento em background (não bloqueia quem chamou)
  (async () => {
    try {
      // Se já temos o codigo capturado, atualizamos o doc (garantia)
      if (codigo) {
        await docRef.update({ codigo, status: 'aguardando_confirmacao' });
      } else if (qrBase64) {
        await docRef.update({ qr: `data:image/png;base64,${qrBase64}`, status: 'aguardando_confirmacao' });
      } else {
        // nenhum dos dois detectados: deixamos como erro e fechamos o contexto
        await docRef.update({ status: 'erro', erroMsg: 'Não detectado QR nem código' });
        await context.close();
        return;
      }

      // Espera o login efetivo acontecer (pane-side existe): timeout configurável (ex: 5min)
      try {
        await page.waitForSelector('#pane-side', { timeout: 5 * 60 * 1000 });
        console.log(`[LOGIN] Cliente ${clienteId} logado com sucesso!`);

        await docRef.update({
          status: 'conectado',
          conectadoEm: admin.firestore.FieldValue.serverTimestamp()
        });

        // opcional: salvar metadados da sessão, phone, etc
      } catch (waitErr) {
        console.log(`[LOGIN] Timeout aguardando login para ${clienteId}.`);
        await docRef.update({
          status: 'timeout',
          erroMsg: 'Timeout aguardando o usuário concluir o login (5min).'
        });
      }
    } catch (bgErr) {
      console.error('[LOGIN background] Erro durante o monitoramento:', bgErr);
      try {
        await docRef.update({ status: 'erro', erroMsg: bgErr.message || String(bgErr) });
      } catch (_) {}
    } finally {
      // Sempre tentamos fechar o contexto (mas se você quer manter a sessão ativa, pode manter)
      try {
        await context.close();
      } catch (_) {}
    }
  })();

  // retorna imediatamente o que conseguimos (codigo e/ou qr)
  return { codigo, qr: qrBase64 ? `data:image/png;base64,${qrBase64}` : null };
}

// --- FUNÇÃO PRINCIPAL ORIGINAL (campanhas) ---
// Mantive sua função executarCampanha praticamente igual à sua versão,
// apenas referenciando o SESSIONS_BASE quando precisar de pasta persistente.
async function executarCampanha(campanha) {
  console.log(`[WORKER] Iniciando execução da campanha ID: ${campanha.id}`);
  const campanhaRef = db.collection('campanhas').doc(campanha.id);
  let context;

  try {
    await campanhaRef.update({ status: 'rodando' });
    let contatosParaEnviar = [];

    if (campanha.tipo === 'quantity') {
      const q = db.collection('contatos')
        .where('status', '==', 'disponivel')
        .orderBy('criadoEm', 'asc')
        .limit(campanha.totalContatos);
      const snapshot = await q.get();
      contatosParaEnviar = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    } else {
      const contactIds = campanha.contactIds || [];
      const results = await Promise.all(contactIds.map(id => db.collection('contatos').doc(id).get()));
      contatosParaEnviar = results
        .filter(d => d.exists && d.data().status === 'disponivel')
        .map(d => ({ id: d.id, ...d.data() }));
    }

    if (contatosParaEnviar.length === 0) throw new Error('Nenhum contato válido encontrado para esta campanha.');
    console.log(`[WORKER] ${contatosParaEnviar.length} contatos serão processados.`);

    // Use uma sessão global para campanhas (ou personalize por cliente se precisar)
    const USER_DATA_DIR = path.join(SESSIONS_BASE, 'campaign_default');
    if (!fs.existsSync(USER_DATA_DIR)) fs.mkdirSync(USER_DATA_DIR, { recursive: true });

    context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();
    page.setDefaultTimeout(90000);

    await page.goto('https://web.whatsapp.com', { waitUntil: 'networkidle' });
    await page.waitForTimeout(5000);
    await page.waitForSelector('div#pane-side', { state: 'visible' });

    // Tentativa de fechar popups (conforme seu código original)
    try {
      const possible = [
        page.getByRole('button', { name: 'Continuar' }),
        page.getByRole('button', { name: /OK|Entendi|Concluir/i })
      ];
      for (const p of possible) {
        try { await p.click({ timeout: 2000 }); } catch (_) {}
      }
    } catch (_) {}

    const mensagemTemplate = campanha.mensagemTemplate || '';
    for (const contato of contatosParaEnviar) {
      console.log(`--------------------------------------------------`);
      console.log(`[DISPARO] Preparando para ${contato.nome || contato.numero}`);

      let mensagemFinal = mensagemTemplate.replace(/{{nome}}/g, contato.nome || '');
      await page.goto(`https://web.whatsapp.com/send?phone=${contato.numero}`, { waitUntil: 'domcontentloaded' });

      // Localiza caixa de texto - robustez para diferentes localizações no DOM
      const messageBox = page.getByRole('textbox', { name: /Digite uma mensagem|Mensagem/i }).first();
      await messageBox.waitFor({ timeout: 15000 });
      await typeLikeHuman(messageBox, mensagemFinal);

      const sendButton = page.getByLabel('Enviar');
      await sendButton.waitFor({ timeout: 5000 });
      await sendButton.click();

      const contatoRef = db.collection('contatos').doc(contato.id);
      await contatoRef.update({ status: 'usado' });

      console.log(`[WORKER] Contato ${contato.nome} atualizado para 'usado'.`);
      await delay(campanha.minDelay || 2, campanha.maxDelay || 5);
      logMemoryUsage();
    }

    await campanhaRef.update({ status: 'concluida' });
    console.log(`[WORKER] Campanha ID: ${campanha.id} concluída com sucesso!`);
  } catch (error) {
    console.error(`[WORKER] Erro ao executar campanha ID: ${campanha.id}.`, error);
    try { await campanhaRef.update({ status: 'erro', erroMsg: error.message }); } catch (_) {}
  } finally {
    if (context) {
      try { await context.close(); } catch (_) {}
    }
  }
}

// --- API ---
const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.send('Motor de automação do WhatsApp está online e pronto.');
});

// Rota para iniciar login por número (captura código / qr e monitora)
app.post('/connect', async (req, res) => {
  const { numero, clienteId } = req.body;
  if (!numero || !clienteId) {
    return res.status(400).send({ error: 'numero e clienteId são obrigatórios.' });
  }

  console.log(`[API] Pedido /connect para cliente ${clienteId} (numero=${numero})`);

  try {
    const { codigo, qr } = await iniciarLoginPorNumero(numero, clienteId);

    // Retorna o que foi capturado (código e/ou QR). Se nenhum, responde 500.
    if (!codigo && !qr) {
      return res.status(500).send({ error: 'Não foi possível detectar código nem QR. Veja logs.' });
    }

    return res.send({ codigo, qr });
  } catch (err) {
    console.error('[API] Erro em /connect:', err);
    return res.status(500).send({ error: err.message || 'erro interno' });
  }
});

// Rota de exemplo para iniciar campanha (mantive a estrutura)
app.post('/start-campaign', async (req, res) => {
  const { campaignId } = req.body;
  if (!campaignId) {
    return res.status(400).send({ error: 'campaignId é obrigatório.' });
  }
  res.status(202).send({ message: 'Campanha aceita. A execução começará em segundo plano.' });

  try {
    const campaignDoc = await db.collection('campanhas').doc(campaignId).get();
    if (!campaignDoc.exists) {
      console.error(`[API] Campanha ${campaignId} não encontrada.`);
      return;
    }
    const campanha = { id: campaignDoc.id, ...campaignDoc.data() };
    setImmediate(() => executarCampanha(campanha));
  } catch (error) {
    console.error(`[API] Erro ao buscar ou iniciar a campanha ${campaignId}:`, error);
  }
});

app.listen(PORT, () => {
  console.log(`[WORKER] Motor iniciado como servidor de API na porta ${PORT}.`);
});

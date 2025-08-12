// worker.js
const { chromium } = require('playwright');
const admin = require('firebase-admin');
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// --- CONFIGURAÇÕES ---
const IS_HEADLESS = process.env.NODE_ENV === 'production';
const SESSIONS_BASE_PATH = process.env.NODE_ENV === 'production' ? '/data/sessions' : './whatsapp_session_data';

// --- INICIALIZAÇÃO FIREBASE ---
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch (e) {
    console.error('[INIT] FIREBASE_SERVICE_ACCOUNT JSON inválido:', e.message);
    throw e;
  }
} else {
  serviceAccount = require('./firebase-service-account.json');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = getFirestore();

// --- UTILS (Humanização) ---
function delay(minSeconds = 2, maxSeconds = 5) {
  const ms = (Math.random() * (maxSeconds - minSeconds) + minSeconds) * 1000;
  console.log(`[HUMANIZADOR] Pausa de ${Math.round(ms/1000)}s`);
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function typeLikeHuman(locator, text) {
  try {
    await locator.click({ timeout: 5000 });
  } catch(e) { /* ignore */ }
  await locator.type(text, { delay: Math.floor(Math.random() * 120) + 40 });
}

async function handlePopups(page) {
  console.log('[POPUPS] checando pop-ups comuns...');
  const possible = [
    page.getByRole('button', { name: 'Continuar' }),
    page.getByRole('button', { name: /OK|Entendi|Concluir/i }),
    page.getByLabel('Fechar', { exact: true })
  ];
  for (const sel of possible) {
    try {
      await sel.waitFor({ timeout: 3000 });
      await sel.click({ force: true });
      console.log('[POPUPS] pop-up fechado.');
      return;
    } catch (e) { /* não encontrado */ }
  }
  console.log('[POPUPS] nenhum pop-up conhecido.');
}

// --- SELECTORS HELPERS ---
function getLoggedInSelectorString() {
  // seletor abrangente: #pane-side aparece quando a lista de conversas foi carregada
  // títulos em pt/en para buscar campo de pesquisa
  return '#pane-side, div[title="Caixa de texto de pesquisa"], div[title="Pesquisar ou começar uma nova conversa"], div[title="Search or start new chat"]';
}

function getQrSelectorString() {
  // Mantemos div[data-ref] (seu código original) e canvas (caso o QR seja um canvas)
  return 'div[data-ref], canvas';
}

// --- FUNÇÃO: AGUARDAR SESSÃO LOGADA (usada pelo executarCampanha) ---
async function waitForSessionToBeLogged(page, timeoutMs = 90000) {
  const loggedSel = getLoggedInSelectorString();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const visible = await page.locator(loggedSel).first().isVisible().catch(() => false);
      if (visible) {
        // double-check para evitar falso positivo
        await page.waitForTimeout(2000);
        const still = await page.locator(loggedSel).first().isVisible().catch(() => false);
        if (still) return true;
      }
    } catch (e) {
      // ignora e tenta novamente
    }
    await page.waitForTimeout(1000);
  }
  return false;
}

// --- FUNÇÃO PRINCIPAL: EXECUTAR CAMPANHA ---
async function executarCampanha(campanha) {
  console.log(`[WORKER] Iniciando execução da campanha ID: ${campanha.id}`);
  const campanhaRef = db.collection('campanhas').doc(campanha.id);
  let context = null;

  if (!campanha.connectionId) {
    console.error('[WORKER] campanha sem connectionId');
    await campanhaRef.update({ status: 'erro', erroMsg: 'connectionId ausente' }).catch(()=>{});
    return;
  }

  const connectionId = campanha.connectionId;
  const sessionPath = path.join(SESSIONS_BASE_PATH, connectionId);
  try {
    // Buscar contatos
    let contatosParaEnviar = [];
    if (campanha.tipo === 'quantity') {
      const q = db.collection('contatos').where('status', '==', 'disponivel').orderBy('criadoEm', 'asc').limit(campanha.totalContatos || 0);
      const snapshot = await q.get();
      contatosParaEnviar = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    } else {
      const contactIds = campanha.contactIds || [];
      const promises = contactIds.map(id => db.collection('contatos').doc(id).get());
      const results = await Promise.all(promises);
      contatosParaEnviar = results.filter(d => d.exists && d.data().status === 'disponivel').map(d => ({ id: d.id, ...d.data() }));
    }

    if (!contatosParaEnviar.length) {
      throw new Error('Nenhum contato válido encontrado para esta campanha.');
    }

    // garante pasta de sessão
    try { await fs.promises.mkdir(sessionPath, { recursive: true }); } catch(e){}

    // lançar contexto persistente (reusa sessão)
    context = await chromium.launchPersistentContext(sessionPath, {
      headless: IS_HEADLESS,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 900 }
    });

    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(90000);

    await page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded', timeout: 90000 });

    // aguarda confirmação de que a sessão já está logada
    const logged = await waitForSessionToBeLogged(page, 90000);
    if (!logged) {
      throw new Error('Sessão não autenticada: login não detectado.');
    }

    await handlePopups(page);

    const mensagemTemplate = campanha.mensagemTemplate || '';

    for (const contato of contatosParaEnviar) {
      try {
        console.log(`[DISPARO] preparando para ${contato.nome || contato.numero}`);
        const mensagemFinal = mensagemTemplate.replace(new RegExp(`{{nome}}`, 'g'), contato.nome || '');

        await page.goto(`https://web.whatsapp.com/send?phone=${contato.numero}`, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // selecionar caixa de mensagem (genérica)
        const messageBox = page.locator('div[contenteditable="true"][data-tab]').last();
        await messageBox.waitFor({ state: 'visible', timeout: 30000 });

        await typeLikeHuman(messageBox, mensagemFinal);

        // enviar (pressionar Enter)
        await messageBox.press('Enter');

        // atualizar contato
        await db.collection('contatos').doc(contato.id).update({
          status: 'usado',
          atualizadoEm: FieldValue.serverTimestamp()
        }).catch(e => console.warn('[WORKER] falha ao atualizar contato:', e.message));

        console.log(`[WORKER] enviado para ${contato.nome || contato.numero}`);
        await delay(campanha.minDelay || 2, campanha.maxDelay || 5);
      } catch (innerErr) {
        console.warn(`[WORKER] Erro ao enviar para ${contato.nome || contato.numero}:`, innerErr.message);
        // não interrompe a campanha inteira por causa de um contato
      }
    }

    await campanhaRef.update({
      status: 'concluida',
      concluidaEm: FieldValue.serverTimestamp()
    });
    console.log(`[WORKER] Campanha ${campanha.id} concluída.`);
  } catch (error) {
    console.error(`[WORKER] Erro na campanha ${campanha.id}:`, error.message || error);
    try {
      await campanhaRef.update({ status: 'erro', erroMsg: error.message || String(error), atualizadoEm: FieldValue.serverTimestamp() });
    } catch (e) { /* ignore */ }
  } finally {
    if (context) {
      try { await context.close(); } catch(e){ }
    }
  }
}

// --- FUNÇÃO: LOGIN COM QR (mantém envio QR e detecta saída da tela QR) ---
async function handleConnectionLogin(connectionId) {
  let context = null;
  const connectionRef = db.collection('conexoes').doc(connectionId);
  const sessionPath = path.join(SESSIONS_BASE_PATH, connectionId);
  const TIMEOUT_MS = 180000; // 3 minutos
  const start = Date.now();

  try {
    console.log(`[QR] iniciando login para ${connectionId}`);

    // garante pasta de sessão
    try { await fs.promises.mkdir(sessionPath, { recursive: true }); } catch(e){}

    context = await chromium.launchPersistentContext(sessionPath, {
      headless: IS_HEADLESS,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 900 }
    });

    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(90000);

    await page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded', timeout: 90000 });

    console.log('[QR] procurando QR ou tela de conversas...');

    let lastQr = null;
    const qrSel = getQrSelectorString();
    const loggedSel = getLoggedInSelectorString();

    while (Date.now() - start < TIMEOUT_MS) {
      try {
        // 1) Verifica se já está logado
        const loggedVisible = await page.locator(loggedSel).first().isVisible().catch(() => false);
        if (loggedVisible) {
          // double-check 2s para evitar flash
          await page.waitForTimeout(2000);
          const stillLogged = await page.locator(loggedSel).first().isVisible().catch(() => false);
          if (stillLogged) {
            console.log(`[QR] login confirmado para ${connectionId}`);
            await connectionRef.update({
              status: 'conectado',
              qrCode: FieldValue.delete(),
              conectadoEm: FieldValue.serverTimestamp()
            }).catch(()=>{});
            // fecha contexto e retorna
            await context.close();
            context = null;
            return;
          }
        }

        // 2) tenta obter QR (div[data-ref] ou canvas)
        const qrLocator = page.locator(qrSel).first();
        const qrExists = await qrLocator.count().then(c => c > 0).catch(() => false);
        if (qrExists) {
          // pegar elemento e identificar se é canvas ou div[data-ref]
          const elHandle = await qrLocator.elementHandle().catch(() => null);
          if (elHandle) {
            const tag = await elHandle.evaluate(node => node.tagName && node.tagName.toLowerCase()).catch(() => null);
            let qrData = null;
            if (tag === 'canvas') {
              // extrair dataURL do canvas
              try {
                qrData = await elHandle.evaluate(c => c.toDataURL && c.toDataURL());
              } catch (e) {
                qrData = null;
              }
            } else {
              // tentar o atributo data-ref (o seu código original usava isso)
              qrData = await elHandle.evaluate(node => node.getAttribute && node.getAttribute('data-ref')).catch(() => null);
            }

            // se obtivemos algo novo, atualiza Firestore
            if (qrData && qrData !== lastQr) {
              lastQr = qrData;
              console.log('[QR] QR detectado/atualizado — atualizando Firestore.');
              await connectionRef.update({
                status: 'awaiting_scan',
                qrCode: qrData,
                atualizadoEm: FieldValue.serverTimestamp()
              }).catch(err => console.warn('[QR] falha ao atualizar Firestore:', err.message));
            }
          }
        } else {
          // nem qr nem login visíveis: log para debug
          console.log(`[QR] nem QR nem login visíveis (tempo decorrido ${Math.round((Date.now()-start)/1000)}s)`);
        }
      } catch (inner) {
        console.log('[QR] erro interno ao verificar estado:', inner.message || inner);
      }

      await page.waitForTimeout(3000);
    }

    throw new Error('Timeout de 3 minutos atingido.');
  } catch (error) {
    console.error(`[QR] erro/timeou no login para ${connectionId}:`, error.message || error);
    try {
      await db.collection('conexoes').doc(connectionId).update({
        status: 'desconectado',
        error: 'Timeout: QR Code não foi escaneado em 3 minutos.',
        qrCode: FieldValue.delete(),
        atualizadoEm: FieldValue.serverTimestamp()
      }).catch(()=>{});
    } catch (e) { /* ignore */ }
  } finally {
    if (context) {
      try { await context.close(); } catch(e){ }
      console.log(`[QR] cont

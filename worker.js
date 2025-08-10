const { chromium } = require('playwright');
const admin = require('firebase-admin');
const cron = require('node-cron');
const {
  getFirestore,
  query,
  collection,
  where,
  getDocs,
  limit,
  orderBy,
  updateDoc,
  doc,
  getDoc
} = require('firebase-admin/firestore');

// --- CONFIGURAÇÕES E INICIALIZAÇÃO ---
let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.log('[INFO] Lendo credenciais do Firebase da variável de ambiente.');
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  console.log('[INFO] Lendo credenciais do Firebase do arquivo local.');
  serviceAccount = require('./firebase-service-account.json');
}

const USER_DATA_DIR = '/var/data/whatsapp_session_data';

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = getFirestore();

// --- FUNÇÕES DE HUMANIZAÇÃO ---
function delay(minSeconds, maxSeconds) {
  const ms = (Math.random() * (maxSeconds - minSeconds) + minSeconds) * 1000;
  console.log(`[HUMANIZADOR] Pausa de ${Math.round(ms / 1000)} segundos...`);
  return new Promise(resolve => setTimeout(resolve, ms));
}
async function typeLikeHuman(locator, text) {
  console.log('[HUMANIZADOR] Clicando no campo...');
  await locator.click();
  console.log('[HUMANIZADOR] Digitando...');
  await locator.type(text, { delay: Math.random() * 120 + 40 });
}
async function handlePopups(page) {
  console.log('[FASE 2] Checando pop-ups...');
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
  console.log('[FASE 2] Nenhum pop-up encontrado.');
}

// --- EXECUÇÃO DE CAMPANHA ---
async function executarCampanha(campanha) {
  console.log(`[WORKER] Executando campanha ID: ${campanha.id}`);
  const campanhaRef = doc(db, 'campanhas', campanha.id);
  let context;

  try {
    await updateDoc(campanhaRef, { status: 'rodando' });

    let contatosParaEnviar = [];
    if (campanha.tipo === 'quantity') {
      const q = query(
        collection(db, 'contatos'),
        where('status', '==', 'disponivel'),
        orderBy('criadoEm', 'asc'),
        limit(campanha.totalContatos)
      );
      const snapshot = await getDocs(q);
      contatosParaEnviar = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    } else {
      const contactIds = campanha.contactIds || [];
      const promises = contactIds.map(id => getDoc(doc(db, 'contatos', id)));
      const results = await Promise.all(promises);
      contatosParaEnviar = results
        .filter(d => d.exists() && d.data().status === 'disponivel')
        .map(d => ({ id: d.id, ...d.data() }));
    }

    if (contatosParaEnviar.length === 0)
      throw new Error('Nenhum contato válido para esta campanha.');

    console.log(`[WORKER] ${contatosParaEnviar.length} contatos serão processados.`);

    context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = context.pages()[0];
    page.setDefaultTimeout(90000);

    await page.goto('https://web.whatsapp.com');
    await page.waitForSelector('div#pane-side', { state: 'visible' });
    await handlePopups(page);

    const mensagemTemplate = campanha.mensagemTemplate;

    for (const contato of contatosParaEnviar) {
      console.log(`--------------------------------------------------`);
      console.log(`[DISPARO] Enviando para ${contato.nome || contato.numero}`);

      let mensagemFinal = mensagemTemplate.replace(/{{nome}}/g, contato.nome || '');

      await page.goto(`https://web.whatsapp.com/send?phone=${contato.numero}`);

      const messageBox = page
        .getByRole('textbox', { name: 'Digite uma mensagem' })
        .getByRole('paragraph');
      await messageBox.waitFor();
      await typeLikeHuman(messageBox, mensagemFinal);

      const sendButton = page.getByLabel('Enviar');
      await sendButton.click();

      const contatoRef = doc(db, 'contatos', contato.id);
      await updateDoc(contatoRef, { status: 'usado' });
      console.log(`[WORKER] Contato ${contato.nome} marcado como 'usado'.`);

      await delay(campanha.minDelay, campanha.maxDelay);
    }

    await updateDoc(campanhaRef, { status: 'concluida' });
    console.log(`[WORKER] Campanha ID: ${campanha.id} concluída.`);
  } catch (error) {
    console.error(`[WORKER] Erro na campanha ID: ${campanha.id}.`, error);
    await updateDoc(campanhaRef, { status: 'erro', erroMsg: error.message });
  } finally {
    if (context) {
      await context.close();
    }
  }
}

// --- AGENDADOR ---
console.log('[WORKER] Worker iniciado. Checando campanhas a cada minuto...');
cron.schedule('* * * * *', async () => {
  console.log(`[CRON][${new Date().toLocaleTimeString('pt-BR')}] Checando campanhas...`);

  const agora = new Date();
  console.log(`[DEBUG] Agora (servidor): ${agora.toISOString()}`);

  try {
    const q = query(
      collection(db, 'campanhas'),
      where('status', '==', 'pendente'),
      where('agendamento', '<=', agora),
      orderBy('agendamento', 'asc'),
      limit(1)
    );

    const snapshot = await getDocs(q);

    if (snapshot.empty) {
      console.log('[CRON] Nenhuma campanha encontrada.');
      return;
    }

    snapshot.forEach(docSnap => {
      const data = docSnap.data();
      console.log(`[DEBUG] Campanha encontrada:`, {
        id: docSnap.id,
        status: data.status,
        agendamento: data.agendamento?.toDate
          ? data.agendamento.toDate().toISOString()
          : data.agendamento
      });
    });

    const campanhaParaExecutar = {
      id: snapshot.docs[0].id,
      ...snapshot.docs[0].data()
    };

    await executarCampanha(campanhaParaExecutar);
  } catch (err) {
    console.error('[CRON] Erro ao buscar campanhas:', err);
  }
});

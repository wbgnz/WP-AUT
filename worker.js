const { chromium } = require('playwright');
const admin = require('firebase-admin');
const express = require('express');
const cors = require('cors');
const { getFirestore, query, collection, where, getDocs, limit, orderBy, updateDoc, doc, getDoc } = require('firebase-admin/firestore');

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

// --- FUNÇÕES DO ROBÔ (Humanização) ---
function delay(minSeconds, maxSeconds) { /* ...código... */ }
async function typeLikeHuman(locator, text) { /* ...código... */ }
async function handlePopups(page) { /* ...código... */ }

// --- FUNÇÃO PRINCIPAL DE EXECUÇÃO DA CAMPANHA ---
async function executarCampanha(campanha) {
  // ... (A lógica interna desta função continua exatamente a mesma) ...
}

// --- CONFIGURAÇÃO DO SERVIDOR DE API ---
const app = express();
app.use(cors()); // Permite que o nosso painel na Vercel comunique com o motor
app.use(express.json());

const PORT = process.env.PORT || 3001;

// Endpoint de verificação (para sabermos que o motor está no ar)
app.get('/', (req, res) => {
  res.send('Motor de automação do WhatsApp está online e pronto.');
});

// Endpoint que o painel irá chamar para iniciar uma campanha
app.post('/start-campaign', async (req, res) => {
  const { campaignId } = req.body;

  if (!campaignId) {
    return res.status(400).send({ error: 'campaignId é obrigatório.' });
  }

  console.log(`[API] Pedido recebido para iniciar a campanha: ${campaignId}`);

  // Responde imediatamente ao painel para que ele não fique à espera
  res.status(202).send({ message: 'Campanha aceite. A execução começará em segundo plano.' });

  // Busca os dados da campanha e executa-a
  try {
    const campaignDoc = await getDoc(doc(db, 'campanhas', campaignId));
    if (!campaignDoc.exists()) {
      throw new Error('Campanha não encontrada no banco de dados.');
    }
    const campanha = { id: campaignDoc.id, ...campaignDoc.data() };
    
    // Executa a campanha em segundo plano
    executarCampanha(campanha);

  } catch (error) {
    console.error(`[API] Erro ao buscar ou iniciar a campanha ${campaignId}:`, error);
    // Aqui poderíamos atualizar a campanha para o status 'erro'
  }
});

app.listen(PORT, () => {
  console.log(`[WORKER] Motor iniciado como servidor de API na porta ${PORT}.`);
});


// --- Colando as funções auxiliares completas aqui ---
function delay(minSeconds, maxSeconds) { const ms = (Math.random() * (maxSeconds - minSeconds) + minSeconds) * 1000; console.log(`[HUMANIZADOR] Pausa de ${Math.round(ms/1000)} segundos...`); return new Promise(resolve => setTimeout(resolve, ms)); }
async function typeLikeHuman(locator, text) { console.log('[HUMANIZADOR] Clicando no campo para focar...'); await locator.click(); console.log('[HUMANIZADOR] Simulando digitação...'); await locator.type(text, { delay: Math.random() * 120 + 40 }); }
async function handlePopups(page) { console.log('[FASE 2] Verificando a presença de pop-ups...'); const possibleSelectors = [ page.getByRole('button', { name: 'Continuar' }), page.getByRole('button', { name: /OK|Entendi|Concluir/i }), page.getByLabel('Fechar', { exact: true }) ]; for (const selector of possibleSelectors) { try { await selector.waitFor({ timeout: 3000 }); await selector.click({ force: true }); console.log('[FASE 2] Pop-up fechado.'); return; } catch (error) {} } console.log('[FASE 2] Nenhum pop-up conhecido foi encontrado.'); }
async function executarCampanha(campanha) {
  console.log(`[WORKER] Iniciando execução da campanha ID: ${campanha.id}`);
  const campanhaRef = doc(db, 'campanhas', campanha.id);
  let context;
  try {
    await updateDoc(campanhaRef, { status: 'rodando' });
    let contatosParaEnviar = [];
    if (campanha.tipo === 'quantity') {
      const q = query(collection(db, 'contatos'), where('status', '==', 'disponivel'), orderBy('criadoEm', 'asc'), limit(campanha.totalContatos));
      const snapshot = await getDocs(q);
      contatosParaEnviar = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    } else {
      const contactIds = campanha.contactIds;
      const promises = contactIds.map(id => getDoc(doc(db, 'contatos', id)));
      const results = await Promise.all(promises);
      contatosParaEnviar = results.filter(d => d.exists() && d.data().status === 'disponivel').map(d => ({ id: d.id, ...d.data() }));
    }
    if (contatosParaEnviar.length === 0) throw new Error('Nenhum contato válido encontrado para esta campanha.');
    console.log(`[WORKER] ${contatosParaEnviar.length} contatos serão processados.`);
    context = await chromium.launchPersistentContext(USER_DATA_DIR, { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = context.pages()[0];
    page.setDefaultTimeout(90000);
    await page.goto('https://web.whatsapp.com');
    await page.waitForSelector('div#pane-side', { state: 'visible' });
    await handlePopups(page);
    const mensagemTemplate = campanha.mensagemTemplate;
    for (const contato of contatosParaEnviar) {
      console.log(`--------------------------------------------------`);
      console.log(`[DISPARO] Preparando para ${contato.nome || contato.numero}`);
      let mensagemFinal = mensagemTemplate.replace(new RegExp(`{{nome}}`, 'g'), contato.nome);
      await page.goto(`https://web.whatsapp.com/send?phone=${contato.numero}`);
      const messageBox = page.getByRole('textbox', { name: 'Digite uma mensagem' }).getByRole('paragraph');
      await messageBox.waitFor();
      await typeLikeHuman(messageBox, mensagemFinal);
      const sendButton = page.getByLabel('Enviar');
      await sendButton.click();
      const contatoRef = doc(db, 'contatos', contato.id);
      await updateDoc(contatoRef, { status: 'usado' });
      console.log(`[WORKER] Contato ${contato.nome} atualizado para 'usado'.`);
      await delay(campanha.minDelay, campanha.maxDelay);
    }
    await updateDoc(campanhaRef, { status: 'concluida' });
    console.log(`[WORKER] Campanha ID: ${campanha.id} concluída com sucesso!`);
  } catch (error) {
    console.error(`[WORKER] Erro ao executar campanha ID: ${campanha.id}.`, error);
    await updateDoc(campanhaRef, { status: 'erro', erroMsg: error.message });
  } finally {
    if (context) {
      await context.close();
    }
  }
}

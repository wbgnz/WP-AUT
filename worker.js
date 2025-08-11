const { chromium } = require('playwright');
const admin = require('firebase-admin');
const express = require('express');
const cors = require('cors');
const { getFirestore, query, collection, where, getDocs, limit, orderBy, updateDoc, doc, getDoc } = require('firebase-admin/firestore');

// --- CONFIGURAÇÕES E INICIALIZAÇÃO ---
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  serviceAccount = require('./firebase-service-account.json');
}

// Este caminho agora é uma subpasta dentro do nosso disco único em /data
const USER_DATA_DIR = '/data/whatsapp_session_data'; 

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = getFirestore();

// --- FUNÇÕES DO ROBÔ (COMPLETAS) ---
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

// --- FUNÇÃO PRINCIPAL DE EXECUÇÃO DA CAMPANHA (COMPLETA) ---
async function executarCampanha(campanha) {
  console.log(`[WORKER] Iniciando execução da campanha ID: ${campanha.id}`);
  const campanhaRef = db.collection('campanhas').doc(campanha.id);
  let context;
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

// --- CONFIGURAÇÃO DO SERVIDOR DE API (COMPLETA) ---
const app = express();
app.use(cors()); 
app.use(express.json());
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.send('Motor de automação do WhatsApp está online e pronto.');
});

app.post('/start-campaign', async (req, res) => {
  const { campaignId } = req.body;
  if (!campaignId) {
    return res.status(400).send({ error: 'campaignId é obrigatório.' });
  }
  console.log(`[API] Pedido recebido para iniciar a campanha: ${campaignId}`);
  res.status(202).send({ message: 'Campanha aceite. A execução começará em segundo plano.' });
  try {
    const campaignDoc = await db.collection('campanhas').doc(campaignId).get();
    if (!campaignDoc.exists) {
      throw new Error('Campanha não encontrada no banco de dados.');
    }
    const campanha = { id: campaignDoc.id, ...campaignDoc.data() };
    executarCampanha(campanha);
  } catch (error) {
    console.error(`[API] Erro ao buscar ou iniciar a campanha ${campaignId}:`, error);
  }
});

app.listen(PORT, () => {
  console.log(`[WORKER] Motor iniciado como servidor de API na porta ${PORT}.`);
});

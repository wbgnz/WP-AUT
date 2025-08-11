const { chromium } = require('playwright');
const admin = require('firebase-admin');
const cron = 'node-cron';
const { getFirestore, query, collection, where, getDocs, limit, orderBy, updateDoc, doc, getDoc } = require('firebase-admin/firestore');

// --- CONFIGURAÇÕES E INICIALIZAÇÃO INTELIGENTE ---
let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  // No Render, lê a variável de ambiente.
  console.log('[INFO] Lendo credenciais do Firebase da variável de ambiente.');
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  // No seu computador, lê o arquivo local para testes.
  console.log('[INFO] Lendo credenciais do Firebase do arquivo local.');
  serviceAccount = require('./firebase-service-account.json');
}

const USER_DATA_DIR = '/var/data/whatsapp_session_data'; // Caminho recomendado para discos persistentes no Render

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = getFirestore();

// --- FUNÇÕES DO ROBÔ (Humanização) ---
function delay(minSeconds, maxSeconds) { const ms = (Math.random() * (maxSeconds - minSeconds) + minSeconds) * 1000; console.log(`[HUMANIZADOR] Pausa de ${Math.round(ms/1000)} segundos...`); return new Promise(resolve => setTimeout(resolve, ms)); }
async function typeLikeHuman(locator, text) { console.log('[HUMANIZADOR] Clicando no campo para focar...'); await locator.click(); console.log('[HUMANIZADOR] Simulando digitação...'); await locator.type(text, { delay: Math.random() * 120 + 40 }); }
async function handlePopups(page) { console.log('[FASE 2] Verificando a presença de pop-ups...'); const possibleSelectors = [ page.getByRole('button', { name: 'Continuar' }), page.getByRole('button', { name: /OK|Entendi|Concluir/i }), page.getByLabel('Fechar', { exact: true }) ]; for (const selector of possibleSelectors) { try { await selector.waitFor({ timeout: 3000 }); await selector.click({ force: true }); console.log('[FASE 2] Pop-up fechado.'); return; } catch (error) {} } console.log('[FASE 2] Nenhum pop-up conhecido foi encontrado.'); }

// --- FUNÇÃO PRINCIPAL DE EXECUÇÃO DA CAMPANHA ---
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
    } else { // tipo 'selection'
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

// --- O AGENDADOR (CRON JOB) ---
console.log('[WORKER] Worker iniciado. Verificando campanhas a cada minuto...');
cron.schedule('* * * * *', async () => {
  console.log(`[CRON][${new Date().toLocaleTimeString('pt-BR')}] Verificando campanhas agendadas...`);
  
  const agora = new Date();
  // A CORREÇÃO ESTÁ AQUI: 'agendamento' em vez de 'agamento'
  const q = query(collection(db, 'campanhas'), where('status', '==', 'pendente'), where('agendamento', '<=', agora), orderBy('agendamento', 'asc'), limit(1));
  
  const snapshot = await getDocs(q);
  if (snapshot.empty) {
    console.log('[CRON] Nenhuma campanha pendente encontrada.');
    return;
  }

  console.log(`[CRON] 1 campanha encontrada para execução.`);
  const campanhaParaExecutar = { id: snapshot.docs[0].id, ...snapshot.docs[0].data() };
  
  await executarCampanha(campanhaParaExecutar);
});

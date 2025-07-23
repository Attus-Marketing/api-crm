// Importação dos módulos necessários
const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');

// --- CONFIGURAÇÃO INICIAL ---
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());

// --- FUNÇÕES AUXILIARES ---
async function calculateMetricsForLeads(leadsSnapshot, startDate, endDate) {
    const metrics = {
        ligacoes: 0, conexoes: 0, conexoes_decisor: 0,
        reunioes_marcadas: 0, reunioes_realizadas: 0, vendas: 0
    };
    const start = startDate ? new Date(startDate) : null;
    const end = endDate ? new Date(endDate) : null;
    if(end) end.setHours(23, 59, 59, 999);

    for (const leadDoc of leadsSnapshot.docs) {
        const leadData = leadDoc.data();
        
        if (leadData.stage === 'Vendido') metrics.vendas++;
        if (leadData.stage === 'R1 - Feita') metrics.reunioes_realizadas++;
        if (leadData.stage === 'R1 - Agendada') metrics.reunioes_marcadas++;

        const activitiesRef = leadDoc.ref.collection('activities');
        let activitiesQuery = activitiesRef;

        if (start) activitiesQuery = activitiesQuery.where('timestamp', '>=', start);
        if (end) activitiesQuery = activitiesQuery.where('timestamp', '<=', end);

        const activitiesSnapshot = await activitiesQuery.get();
        activitiesSnapshot.forEach(activityDoc => {
            const activityData = activityDoc.data();
            if (activityData.type === 'Ligação') {
                metrics.ligacoes++;
                if (activityData.outcome === 'Conexão Realizada') metrics.conexoes++;
                if (activityData.outcome === 'Conexão com Decisor') {
                    metrics.conexoes++;
                    metrics.conexoes_decisor++;
                }
            }
        });
    }
    return metrics;
}

// --- ROTAS DA API ---

app.get('/', (req, res) => {
    res.status(200).send('Servidor da API do ATTUS CRM está online e a funcionar!');
});

app.get('/api/sellers', async (req, res) => {
    try {
        const sellersDoc = await db.collection('crm_config').doc('sellers').get();
        if (!sellersDoc.exists) {
            return res.status(404).json({ error: 'Documento de vendedores não encontrado.' });
        }
        res.status(200).json(sellersDoc.data().list || []);
    } catch (error) {
        res.status(500).json({ error: 'Ocorreu um erro interno no servidor.' });
    }
});

app.get('/api/metrics/seller/:sellerName', async (req, res) => {
    try {
        const { sellerName } = req.params;
        const { startDate, endDate } = req.query;
        const leadsQuery = db.collection('crm_leads_shared').where('vendedor', '==', sellerName);
        const leadsSnapshot = await leadsQuery.get();
        const metrics = await calculateMetricsForLeads(leadsSnapshot, startDate, endDate);
        res.status(200).json({ sellerName, metrics });
    } catch (error) {
        res.status(500).json({ error: 'Ocorreu um erro interno no servidor.' });
    }
});

app.get('/api/metrics/team', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const leadsSnapshot = await db.collection('crm_leads_shared').get();
        const metrics = await calculateMetricsForLeads(leadsSnapshot, startDate, endDate);
        res.status(200).json({ sellerName: "Equipa Completa", metrics });
    } catch (error) {
        res.status(500).json({ error: 'Ocorreu um erro interno no servidor.' });
    }
});

// NOVO: Endpoints para Metas (Goals)
const GOALS_PATH = 'crm_goals';

app.post('/api/goals/:sellerName', async (req, res) => {
    try {
        const { sellerName } = req.params;
        const goalsData = req.body; // { daily: {...}, weekly: {...}, monthly: {...} }
        const docRef = db.collection(GOALS_PATH).doc(sellerName);
        await docRef.set(goalsData, { merge: true });
        res.status(200).json({ message: 'Metas salvas com sucesso!' });
    } catch (error) {
        console.error("Erro ao salvar metas:", error);
        res.status(500).json({ error: 'Ocorreu um erro ao salvar as metas.' });
    }
});

app.get('/api/goals/:sellerName', async (req, res) => {
    try {
        const { sellerName } = req.params;
        const docRef = db.collection(GOALS_PATH).doc(sellerName);
        const doc = await docRef.get();
        if (!doc.exists) {
            // Retorna metas padrão se não existirem
            return res.status(200).json({
                daily: { ligacoes: 20, reunioes_marcadas: 2, vendas: 0 },
                weekly: { ligacoes: 100, reunioes_marcadas: 10, vendas: 2 },
                monthly: { ligacoes: 400, reunioes_marcadas: 40, vendas: 8 }
            });
        }
        res.status(200).json(doc.data());
    } catch (error) {
        console.error("Erro ao buscar metas:", error);
        res.status(500).json({ error: 'Ocorreu um erro ao buscar as metas.' });
    }
});


// --- INICIALIZAÇÃO DO SERVIDOR ---
app.listen(PORT, () => {
    console.log(`Servidor da API do CRM v2.4 a rodar na porta ${PORT}`);
});

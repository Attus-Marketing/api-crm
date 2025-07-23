// Importação dos módulos necessários
const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');

// --- CONFIGURAÇÃO INICIAL ---
try {
    const serviceAccount = require('./serviceAccountKey.json');
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
} catch (error) {
    console.error("Ficheiro serviceAccountKey.json não encontrado ou inválido.", error);
    process.exit(1);
}

const db = admin.firestore();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());

// --- FUNÇÕES AUXILIARES ---
const calculateMetricsForLeads = async (leadsSnapshot, startDate, endDate) => {
    const metrics = {
        ligacoes: 0, conexoes: 0, conexoes_decisor: 0,
        reunioes_marcadas: 0, reunioes_realizadas: 0, vendas: 0
    };
    const start = startDate ? new Date(startDate) : null;
    const end = endDate ? new Date(endDate) : null;
    if(end) end.setHours(23, 59, 59, 999);

    for (const leadDoc of leadsSnapshot.docs) {
        const leadData = leadDoc.data();
        
        let includeStageMetrics = true;
        if(leadData.lastStageChange && start && end) {
            const changeDate = leadData.lastStageChange.toDate();
            if(changeDate < start || changeDate > end) {
                includeStageMetrics = false;
            }
        }
        
        if (includeStageMetrics) {
            if (leadData.stage === 'Vendido') metrics.vendas++;
            if (leadData.stage === 'R1 - Feita') metrics.reunioes_realizadas++;
            if (leadData.stage === 'R1 - Agendada') metrics.reunioes_marcadas++;
        }

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
};

// --- ROTAS DA API ---
const apiRouter = express.Router();

apiRouter.get('/sellers', async (req, res) => {
    try {
        const sellersDoc = await db.collection('crm_config').doc('sellers').get();
        if (!sellersDoc.exists) return res.status(404).json({ error: 'Documento de vendedores não encontrado.' });
        res.status(200).json(sellersDoc.data().list || []);
    } catch (error) {
        res.status(500).json({ error: 'Ocorreu um erro interno.' });
    }
});

apiRouter.get('/metrics/seller/:sellerName', async (req, res) => {
    try {
        const { sellerName } = req.params;
        const { startDate, endDate } = req.query;
        const leadsQuery = db.collection('crm_leads_shared').where('vendedor', '==', sellerName);
        const leadsSnapshot = await leadsQuery.get();
        const metrics = await calculateMetricsForLeads(leadsSnapshot, startDate, endDate);
        res.status(200).json({ sellerName, metrics });
    } catch (error) {
        res.status(500).json({ error: 'Ocorreu um erro interno.' });
    }
});

apiRouter.get('/metrics/team', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const leadsSnapshot = await db.collection('crm_leads_shared').get();
        const metrics = await calculateMetricsForLeads(leadsSnapshot, startDate, endDate);
        res.status(200).json({ sellerName: "Equipa Completa", metrics });
    } catch (error) {
        res.status(500).json({ error: 'Ocorreu um erro interno.' });
    }
});

// ... (restante das rotas da API, como goals e analysis, permanecem aqui) ...

app.use('/api', apiRouter); // Usa o router para todas as rotas que começam com /api

app.get('/', (req, res) => {
    res.status(200).send('Servidor da API do ATTUS CRM v2.7 está online!');
});


app.listen(PORT, () => {
    console.log(`Servidor da API do CRM v2.7 a rodar na porta ${PORT}`);
});

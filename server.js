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
app.get('/', (req, res) => {
    res.status(200).send('Servidor da API do ATTUS CRM v2.8 está online!');
});

app.get('/api/sellers', async (req, res) => {
    try {
        const sellersDoc = await db.collection('crm_config').doc('sellers').get();
        if (!sellersDoc.exists) return res.status(404).json({ error: 'Documento de vendedores não encontrado.' });
        res.status(200).json(sellersDoc.data().list || []);
    } catch (error) {
        res.status(500).json({ error: 'Ocorreu um erro interno.' });
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
        res.status(500).json({ error: 'Ocorreu um erro interno.' });
    }
});

app.get('/api/metrics/team', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const leadsSnapshot = await db.collection('crm_leads_shared').get();
        const metrics = await calculateMetricsForLeads(leadsSnapshot, startDate, endDate);
        res.status(200).json({ sellerName: "Equipa Completa", metrics });
    } catch (error) {
        res.status(500).json({ error: 'Ocorreu um erro interno.' });
    }
});

app.post('/api/goals/:sellerName', async (req, res) => {
    try {
        const { sellerName } = req.params;
        const goalsData = req.body;
        await db.collection('crm_goals').doc(sellerName).set(goalsData, { merge: true });
        res.status(200).json({ message: 'Metas salvas com sucesso!' });
    } catch (error) {
        res.status(500).json({ error: 'Ocorreu um erro ao salvar as metas.' });
    }
});

app.get('/api/goals/:sellerName', async (req, res) => {
    try {
        const { sellerName } = req.params;
        const doc = await db.collection('crm_goals').doc(sellerName).get();
        if (!doc.exists) {
            return res.status(200).json({
                daily: { ligacoes: 20, reunioes_marcadas: 2, vendas: 0 },
                weekly: { ligacoes: 100, reunioes_marcadas: 10, vendas: 2 },
                monthly: { ligacoes: 400, reunioes_marcadas: 40, vendas: 8 }
            });
        }
        res.status(200).json(doc.data());
    } catch (error) {
        res.status(500).json({ error: 'Ocorreu um erro ao buscar as metas.' });
    }
});

app.get('/api/analysis/historical', async (req, res) => {
    try {
        const { sellerName, metric, startDate, endDate } = req.query;
        if (!metric || !startDate || !endDate) return res.status(400).json({ error: 'Parâmetros obrigatórios em falta.' });

        const start = new Date(startDate);
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);

        let leadsQuery = db.collection('crm_leads_shared');
        if (sellerName && sellerName !== 'team') {
            leadsQuery = leadsQuery.where('vendedor', '==', sellerName);
        }
        const leadsSnapshot = await leadsQuery.get();
        if (leadsSnapshot.empty) return res.status(200).json([]);

        const resultsByDay = {};
        for (const leadDoc of leadsSnapshot.docs) {
            const activitiesRef = leadDoc.ref.collection('activities');
            const activitiesQuery = activitiesRef.where('timestamp', '>=', start).where('timestamp', '<=', end);
            const activitiesSnapshot = await activitiesQuery.get();

            activitiesSnapshot.forEach(actDoc => {
                const activity = actDoc.data();
                const day = activity.timestamp.toDate().toISOString().split('T')[0];
                if (!resultsByDay[day]) resultsByDay[day] = 0;

                if (metric === 'vendas' && activity.type === 'Etapa Alterada' && activity.outcome.includes('para Vendido')) resultsByDay[day]++;
                else if (metric === 'ligacoes' && activity.type === 'Ligação') resultsByDay[day]++;
                else if (metric === 'reunioes_realizadas' && activity.type === 'Etapa Alterada' && activity.outcome.includes('para R1 - Feita')) resultsByDay[day]++;
            });
        }
        
        const formattedResults = Object.keys(resultsByDay).map(day => ({ date: day, value: resultsByDay[day] })).sort((a,b) => new Date(a.date) - new Date(b.date));
        res.status(200).json(formattedResults);

    } catch (error) {
        res.status(500).json({ error: 'Ocorreu um erro interno.' });
    }
});

app.get('/api/analysis/ranking', async (req, res) => {
    try {
        const { metric, startDate, endDate } = req.query;
        if (!metric) return res.status(400).json({ error: 'Parâmetro metric é obrigatório.' });

        const sellersDoc = await db.collection('crm_config').doc('sellers').get();
        const sellerList = sellersDoc.exists() ? sellersDoc.data().list : [];
        if (!sellerList.length) return res.status(200).json([]);

        const rankingPromises = sellerList.map(async (sellerName) => {
            if (sellerName === 'Sem Vendedor') return null;
            const leadsQuery = db.collection('crm_leads_shared').where('vendedor', '==', sellerName);
            const leadsSnapshot = await leadsQuery.get();
            const metrics = await calculateMetricsForLeads(leadsSnapshot, startDate, endDate);
            return { seller: sellerName, value: metrics[metric] || 0 };
        });

        const rankingResults = (await Promise.all(rankingPromises)).filter(Boolean);
        rankingResults.sort((a, b) => b.value - a.value);
        
        res.status(200).json(rankingResults);

    } catch (error) {
        res.status(500).json({ error: 'Ocorreu um erro interno.' });
    }
});

app.get('/api/analysis/categories', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const leadsSnapshot = await db.collection('crm_leads_shared').get();
        
        const leadsByCategory = {};
        leadsSnapshot.forEach(doc => {
            const lead = doc.data();
            const category = lead.categoria || 'Sem Categoria';
            if (!leadsByCategory[category]) leadsByCategory[category] = { docs: [] };
            leadsByCategory[category].docs.push(doc);
        });

        const analysisPromises = Object.keys(leadsByCategory).map(async (category) => {
            const pseudoSnapshot = { docs: leadsByCategory[category].docs };
            const metrics = await calculateMetricsForLeads(pseudoSnapshot, startDate, endDate);
            const conversionRate = metrics.reunioes_realizadas > 0 ? (metrics.vendas / metrics.reunioes_realizadas) * 100 : 0;
            return { category, totalLeads: pseudoSnapshot.docs.length, metrics, conversionRate: conversionRate.toFixed(1) };
        });

        const results = await Promise.all(analysisPromises);
        results.sort((a,b) => b.conversionRate - a.conversionRate);
        res.status(200).json(results);

    } catch (error) {
        res.status(500).json({ error: 'Ocorreu um erro interno.' });
    }
});

app.listen(PORT, () => {
    console.log(`Servidor da API do CRM v2.8 a rodar na porta ${PORT}`);
});

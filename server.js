const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');

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

app.use(cors());
app.use(express.json());

const calculateMetricsForLeads = async (leadsSnapshot, startDate, endDate) => {
    const metrics = { ligacoes: 0, conexoes: 0, conexoes_decisor: 0, reunioes_marcadas: 0, reunioes_realizadas: 0, vendas: 0 };
    const start = startDate ? new Date(startDate) : null;
    const end = endDate ? new Date(endDate) : null;
    if(end) end.setHours(23, 59, 59, 999);

    for (const leadDoc of leadsSnapshot.docs) {
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
            if (activityData.type === 'Etapa Alterada') {
                if (activityData.outcome.includes('para Vendido')) metrics.vendas++;
                if (activityData.outcome.includes('para R1 - Feita')) metrics.reunioes_realizadas++;
                if (activityData.outcome.includes('para R1 - Agendada')) metrics.reunioes_marcadas++;
            }
        });
    }
    return metrics;
};

// --- ROTAS ---
app.get('/', (req, res) => res.status(200).send('Servidor da API do ATTUS CRM v3.0 está online!'));

app.get('/api/sellers', async (req, res) => {
    try {
        const sellersDoc = await db.collection('crm_config').doc('sellers').get();
        if (!sellersDoc.exists) return res.status(404).json({ error: 'Documento de vendedores não encontrado.' });
        res.status(200).json(sellersDoc.data().list || []);
    } catch (error) { res.status(500).json({ error: 'Erro ao buscar vendedores.' }); }
});

app.get('/api/metrics/team', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const leadsSnapshot = await db.collection('crm_leads_shared').get();
        const metrics = await calculateMetricsForLeads(leadsSnapshot, startDate, endDate);
        res.status(200).json({ sellerName: "Equipa Completa", metrics });
    } catch (error) { res.status(500).json({ error: 'Erro ao calcular métricas da equipa.' }); }
});

app.get('/api/metrics/seller/:name', async (req, res) => {
    try {
        const { name } = req.params;
        const { startDate, endDate } = req.query;
        const leadsQuery = db.collection('crm_leads_shared').where('vendedor', '==', name);
        const leadsSnapshot = await leadsQuery.get();
        const metrics = await calculateMetricsForLeads(leadsSnapshot, startDate, endDate);
        res.status(200).json({ sellerName: name, metrics });
    } catch (error) { res.status(500).json({ error: 'Erro ao calcular métricas do vendedor.' }); }
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
            });
        }
        const formattedResults = Object.keys(resultsByDay).map(day => ({ date: day, value: resultsByDay[day] })).sort((a,b) => new Date(a.date) - new Date(b.date));
        return res.status(200).json(formattedResults);
    } catch (error) { res.status(500).json({ error: `Erro na análise histórica: ${error.message}` }); }
});
        
app.get('/api/analysis/ranking', async (req, res) => {
    try {
        const { metric, startDate, endDate } = req.query;
        if (!metric) return res.status(400).json({ error: 'Parâmetro metric é obrigatório.' });

        const sellersDoc = await db.collection('crm_config').doc('sellers').get();
        const sellerList = sellersDoc.exists() ? sellersDoc.data().list : [];
        const rankingPromises = sellerList.map(async (seller) => {
            if (seller === 'Sem Vendedor') return null;
            const sellerLeadsQuery = db.collection('crm_leads_shared').where('vendedor', '==', seller);
            const sellerLeadsSnapshot = await sellerLeadsQuery.get();
            const metrics = await calculateMetricsForLeads(sellerLeadsSnapshot, startDate, endDate);
            return { seller, value: metrics[metric] || 0 };
        });
        const rankingResults = (await Promise.all(rankingPromises)).filter(Boolean).sort((a, b) => b.value - a.value);
        return res.status(200).json(rankingResults);
    } catch (error) { res.status(500).json({ error: `Erro no ranking: ${error.message}` }); }
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
            const metrics = await calculateMetricsForLeads({ docs: leadsByCategory[category].docs }, startDate, endDate);
            const conversionRate = metrics.reunioes_realizadas > 0 ? (metrics.vendas / metrics.reunioes_realizadas) * 100 : 0;
            return { category, metrics, conversionRate: conversionRate.toFixed(1) };
        });
        const results = (await Promise.all(analysisPromises)).sort((a,b) => b.conversionRate - a.conversionRate);
        return res.status(200).json(results);
    } catch (error) { res.status(500).json({ error: `Erro na análise de categorias: ${error.message}` }); }
});

app.listen(PORT, () => {
    console.log(`Servidor da API do CRM v3.0 a rodar na porta ${PORT}`);
});

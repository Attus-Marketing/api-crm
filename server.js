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
// ... (calculateMetricsForLeads, inalterada) ...

// --- ROTAS DA API ---
app.get('/', (req, res) => {
    res.status(200).send('Servidor da API do ATTUS CRM v2.5 está online!');
});

app.get('/api/sellers', async (req, res) => { /* ... (código inalterado) ... */ });
app.get('/api/metrics/seller/:sellerName', async (req, res) => { /* ... (código inalterado) ... */ });
app.get('/api/metrics/team', async (req, res) => { /* ... (código inalterado) ... */ });
app.post('/api/goals/:sellerName', async (req, res) => { /* ... (código inalterado) ... */ });
app.get('/api/goals/:sellerName', async (req, res) => { /* ... (código inalterado) ... */ });

// NOVO: Endpoint para Gráficos de Evolução Histórica
app.get('/api/analysis/historical', async (req, res) => {
    try {
        const { sellerName, metric, startDate, endDate } = req.query;
        if (!metric || !startDate || !endDate) {
            return res.status(400).json({ error: 'Parâmetros metric, startDate e endDate são obrigatórios.' });
        }

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

                if (metric === 'vendas' && activity.type === 'Etapa Alterada' && activity.outcome.includes('para Vendido')) {
                    resultsByDay[day]++;
                } else if (metric === 'ligacoes' && activity.type === 'Ligação') {
                    resultsByDay[day]++;
                } else if (metric === 'reunioes_realizadas' && activity.type === 'Etapa Alterada' && activity.outcome.includes('para R1 - Feita')) {
                    resultsByDay[day]++;
                }
            });
        }
        
        const formattedResults = Object.keys(resultsByDay).map(day => ({ date: day, value: resultsByDay[day] })).sort((a,b) => new Date(a.date) - new Date(b.date));
        res.status(200).json(formattedResults);

    } catch (error) {
        console.error("Erro na análise histórica:", error);
        res.status(500).json({ error: 'Ocorreu um erro interno.' });
    }
});

// NOVO: Endpoint para Ranking de Vendedores
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
        console.error("Erro no ranking:", error);
        res.status(500).json({ error: 'Ocorreu um erro interno.' });
    }
});

// NOVO: Endpoint para Análise de Conversão por Categoria
app.get('/api/analysis/categories', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const leadsSnapshot = await db.collection('crm_leads_shared').get();
        
        const leadsByCategory = {};
        leadsSnapshot.forEach(doc => {
            const lead = doc.data();
            const category = lead.categoria || 'Sem Categoria';
            if (!leadsByCategory[category]) {
                leadsByCategory[category] = { docs: [] };
            }
            leadsByCategory[category].docs.push(doc);
        });

        const analysisPromises = Object.keys(leadsByCategory).map(async (category) => {
            const pseudoSnapshot = { docs: leadsByCategory[category].docs };
            const metrics = await calculateMetricsForLeads(pseudoSnapshot, startDate, endDate);
            const conversionRate = metrics.reunioes_realizadas > 0 ? (metrics.vendas / metrics.reunioes_realizadas) * 100 : 0;
            return {
                category,
                totalLeads: pseudoSnapshot.docs.length,
                metrics,
                conversionRate: conversionRate.toFixed(1)
            };
        });

        const results = await Promise.all(analysisPromises);
        results.sort((a,b) => b.conversionRate - a.conversionRate);
        res.status(200).json(results);

    } catch (error) {
        console.error("Erro na análise de categorias:", error);
        res.status(500).json({ error: 'Ocorreu um erro interno.' });
    }
});


// --- INICIALIZAÇÃO DO SERVIDOR ---
app.listen(PORT, () => {
    console.log(`Servidor da API do CRM v2.5 a rodar na porta ${PORT}`);
});

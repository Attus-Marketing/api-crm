// ### INÍCIO DO CÓDIGO COMPLETO PARA TESTE ###
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

const calculateMetricsForLeads = async (leadDocs, startDate, endDate) => {
    const metrics = { ligacoes: 0, conexoes: 0, conexoes_decisor: 0, reunioes_marcadas: 0, reunioes_realizadas: 0, vendas: 0 };
    const start = startDate ? new Date(startDate) : null;
    const end = endDate ? new Date(endDate) : null;
    if(end) end.setHours(23, 59, 59, 999);

    for (const leadDoc of leadDocs) {
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

// --- LINHA ALTERADA PARA O TESTE ---
app.get('/', (req, res) => res.status(200).send('API v5.0 - TESTE DEPLOY - Funcionando!'));

app.get('/api/sellers', async (req, res) => {
    try {
        const sellersDoc = await db.collection('crm_config').doc('sellers').get();
        if (!sellersDoc.exists) return res.status(404).json({ error: 'Documento de vendedores não encontrado.' });
        res.status(200).json(sellersDoc.data().list || []);
    } catch (error) { res.status(500).json({ error: 'Erro ao buscar vendedores.' }); }
});

app.get('/api/dashboard-data', async (req, res) => {
    try {
        const { sellerName, startDate, endDate } = req.query;
        if (!sellerName || !startDate || !endDate) {
            return res.status(400).json({ error: 'Parâmetros sellerName, startDate e endDate são obrigatórios.' });
        }

        let leadsQuery = db.collection('crm_leads_shared');
        if (sellerName !== 'team') {
            leadsQuery = leadsQuery.where('vendedor', '==', sellerName);
        }
        const leadsSnapshot = await leadsQuery.get();
        
        const metrics = await calculateMetricsForLeads(leadsSnapshot.docs, startDate, endDate);

        const start = new Date(startDate);
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        const resultsByDay = {};
        for (const leadDoc of leadsSnapshot.docs) {
            const activitiesRef = leadDoc.ref.collection('activities');
            const activitiesQuery = activitiesRef.where('timestamp', '>=', start).where('timestamp', '<=', end);
            const activitiesSnapshot = await activitiesQuery.get();
            activitiesSnapshot.forEach(actDoc => {
                const activity = actDoc.data();
                const day = activity.timestamp.toDate().toISOString().split('T')[0];
                if (!resultsByDay[day]) resultsByDay[day] = 0;
                if (activity.type === 'Etapa Alterada' && activity.outcome.includes('para Vendido')) resultsByDay[day]++;
            });
        }
        const historical = Object.keys(resultsByDay).map(day => ({ date: day, value: resultsByDay[day] })).sort((a,b) => new Date(a.date) - new Date(b.date));

        const sellersDoc = await db.collection('crm_config').doc('sellers').get();
        const sellerList = sellersDoc.exists() ? sellersDoc.data()?.list || [] : [];
        const rankingPromises = sellerList.map(async (seller) => {
            if (seller === 'Sem Vendedor') return null;
            const sellerLeadsQuery = db.collection('crm_leads_shared').where('vendedor', '==', seller);
            const sellerLeadsSnapshot = await sellerLeadsQuery.get();
            const sellerMetrics = await calculateMetricsForLeads(sellerLeadsSnapshot.docs, startDate, endDate);
            return { seller, value: sellerMetrics['vendas'] || 0 };
        });
        const ranking = (await Promise.all(rankingPromises)).filter(Boolean).sort((a, b) => b.value - a.value);

        const allLeadsSnapshot = await db.collection('crm_leads_shared').get();
        const leadsByCategory = {};
        allLeadsSnapshot.forEach(doc => {
            const lead = doc.data();
            const category = lead.categoria || 'Sem Categoria';
            if (!leadsByCategory[category]) leadsByCategory[category] = [];
            leadsByCategory[category].push(doc);
        });
        const categoryPromises = Object.keys(leadsByCategory).map(async (category) => {
            const catMetrics = await calculateMetricsForLeads(leadsByCategory[category], startDate, endDate);
            const conversionRate = catMetrics.reunioes_realizadas > 0 ? (catMetrics.vendas / catMetrics.reunioes_realizadas) * 100 : 0;
            return { category, metrics: catMetrics, conversionRate: conversionRate.toFixed(1) };
        });
        const categories = (await Promise.all(categoryPromises)).sort((a,b) => b.conversionRate - a.conversionRate);

        res.status(200).json({
            sellerName: sellerName === 'team' ? 'Equipa Completa' : sellerName,
            metrics,
            historical,
            ranking,
            categories
        });

    } catch (error) {
        console.error("Erro no endpoint de dashboard-data:", error);
        res.status(500).json({ error: `Erro ao processar dados do dashboard: ${error.message}` });
    }
});

app.listen(PORT, () => {
    console.log(`Servidor da API do CRM v4.0 a rodar na porta ${PORT}`);
});
// ### FIM DO CÓDIGO COMPLETO PARA TESTE ###
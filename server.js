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

// --- FUNÇÃO CORRIGIDA ---
// A função agora espera um array de documentos (docs) diretamente,
// em vez de um objeto "snapshot" inteiro. Isso a torna mais simples e robusta.
const calculateMetricsForLeads = async (leadDocs, startDate, endDate) => {
    const metrics = { ligacoes: 0, conexoes: 0, conexoes_decisor: 0, reunioes_marcadas: 0, reunioes_realizadas: 0, vendas: 0 };
    const start = startDate ? new Date(startDate) : null;
    const end = endDate ? new Date(endDate) : null;
    if(end) end.setHours(23, 59, 59, 999);

    // O loop agora itera diretamente sobre o array recebido.
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

// --- ROTAS ---
app.get('/', (req, res) => res.status(200).send('Servidor da API do ATTUS CRM v4.0 está online!'));

app.get('/api/sellers', async (req, res) => {
    try {
        const sellersDoc = await db.collection('crm_config').doc('sellers').get();
        if (!sellersDoc.exists) return res.status(404).json({ error: 'Documento de vendedores não encontrado.' });
        res.status(200).json(sellersDoc.data().list || []);
    } catch (error) { res.status(500).json({ error: 'Erro ao buscar vendedores.' }); }
});

// NOVO "SUPER-ENDPOINT"
app.get('/api/dashboard-data', async (req, res) => {
    try {
        const { sellerName, startDate, endDate } = req.query;
        if (!sellerName || !startDate || !endDate) {
            return res.status(400).json({ error: 'Parâmetros sellerName, startDate e endDate são obrigatórios.' });
        }

        // 1. Obter os leads relevantes
        let leadsQuery = db.collection('crm_leads_shared');
        if (sellerName !== 'team') {
            leadsQuery = leadsQuery.where('vendedor', '==', sellerName);
        }
        const leadsSnapshot = await leadsQuery.get();
        
        // 2. Calcular Métricas
        // --- CORREÇÃO --- : Passamos 'leadsSnapshot.docs' em vez do objeto inteiro.
        const metrics = await calculateMetricsForLeads(leadsSnapshot.docs, startDate, endDate);

        // 3. Calcular Análise Histórica (Vendas)
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

        // 4. Calcular Ranking de Vendedores (sempre da equipa toda)
        const sellersDoc = await db.collection('crm_config').doc('sellers').get();
        // --- MELHORIA --- : Adicionado '?.list' e '|| []' para mais segurança.
        const sellerList = sellersDoc.exists() ? sellersDoc.data()?.list || [] : [];
        const rankingPromises = sellerList.map(async (seller) => {
            if (seller === 'Sem Vendedor') return null;
            const sellerLeadsQuery = db.collection('crm_leads_shared').where('vendedor', '==', seller);
            const sellerLeadsSnapshot = await sellerLeadsQuery.get();
            // --- CORREÇÃO --- : Passamos 'sellerLeadsSnapshot.docs' em vez do objeto inteiro.
            const sellerMetrics = await calculateMetricsForLeads(sellerLeadsSnapshot.docs, startDate, endDate);
            return { seller, value: sellerMetrics['vendas'] || 0 };
        });
        const ranking = (await Promise.all(rankingPromises)).filter(Boolean).sort((a, b) => b.value - a.value);

        // 5. Calcular Análise por Categoria (sempre da equipa toda)
        const allLeadsSnapshot = await db.collection('crm_leads_shared').get();
        const leadsByCategory = {};
        allLeadsSnapshot.forEach(doc => {
            const lead = doc.data();
            const category = lead.categoria || 'Sem Categoria';
            if (!leadsByCategory[category]) leadsByCategory[category] = [];
            leadsByCategory[category].push(doc); // Agora o valor é diretamente o array de docs
        });
        const categoryPromises = Object.keys(leadsByCategory).map(async (category) => {
            // --- CORREÇÃO --- : Passamos o array de documentos diretamente.
            const catMetrics = await calculateMetricsForLeads(leadsByCategory[category], startDate, endDate);
            const conversionRate = catMetrics.reunioes_realizadas > 0 ? (catMetrics.vendas / catMetrics.reunioes_realizadas) * 100 : 0;
            return { category, metrics: catMetrics, conversionRate: conversionRate.toFixed(1) };
        });
        const categories = (await Promise.all(categoryPromises)).sort((a,b) => b.conversionRate - a.conversionRate);

        // 6. Enviar tudo num único pacote
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
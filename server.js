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

// --- FUNÇÃO AUXILIAR PARA CALCULAR MÉTRICAS ---
async function calculateMetricsForLeads(leadsSnapshot, startDate, endDate) {
    const metrics = {
        ligacoes: 0, conexoes: 0, conexoes_decisor: 0,
        reunioes_marcadas: 0, reunioes_realizadas: 0, vendas: 0
    };

    // Converte as strings de data para objetos Date do JavaScript
    const start = startDate ? new Date(startDate) : null;
    const end = endDate ? new Date(endDate) : null;
    if(end) end.setHours(23, 59, 59, 999); // Garante que o dia final é incluído na totalidade

    for (const leadDoc of leadsSnapshot.docs) {
        const leadData = leadDoc.data();
        
        // ATUALIZAÇÃO: A contagem de estágios também precisa de ser filtrada por data.
        // Isto requer que guardemos a data em que um estágio é alterado.
        // Por simplicidade, vamos manter a contagem total de estágios por agora.
        if (leadData.stage === 'Vendido') metrics.vendas++;
        if (leadData.stage === 'R1 - Feita') metrics.reunioes_realizadas++;
        if (leadData.stage === 'R1 - Agendada') metrics.reunioes_marcadas++;

        // A filtragem por data será aplicada apenas às ATIVIDADES.
        const activitiesRef = leadDoc.ref.collection('activities');
        let activitiesQuery = activitiesRef;

        // Constrói a query do Firestore com base nas datas fornecidas
        if (start) {
            activitiesQuery = activitiesQuery.where('timestamp', '>=', start);
        }
        if (end) {
            activitiesQuery = activitiesQuery.where('timestamp', '<=', end);
        }

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

// ATUALIZADO: Aceita startDate e endDate como query params
app.get('/api/metrics/seller/:sellerName', async (req, res) => {
    try {
        const { sellerName } = req.params;
        const { startDate, endDate } = req.query; // Extrai as datas da query

        const leadsQuery = db.collection('crm_leads_shared').where('vendedor', '==', sellerName);
        const leadsSnapshot = await leadsQuery.get();

        if (leadsSnapshot.empty) {
            return res.status(200).json({ sellerName, metrics: { ligacoes: 0, conexoes: 0, conexoes_decisor: 0, reunioes_marcadas: 0, reunioes_realizadas: 0, vendas: 0 } });
        }
        
        const metrics = await calculateMetricsForLeads(leadsSnapshot, startDate, endDate);
        res.status(200).json({ sellerName, metrics });

    } catch (error) {
        res.status(500).json({ error: 'Ocorreu um erro interno no servidor.' });
    }
});

// ATUALIZADO: Aceita startDate e endDate como query params
app.get('/api/metrics/team', async (req, res) => {
    try {
        const { startDate, endDate } = req.query; // Extrai as datas da query
        const leadsSnapshot = await db.collection('crm_leads_shared').get();

        if (leadsSnapshot.empty) {
            return res.status(200).json({ sellerName: "Equipa Completa", metrics: { ligacoes: 0, conexoes: 0, conexoes_decisor: 0, reunioes_marcadas: 0, reunioes_realizadas: 0, vendas: 0 } });
        }

        const metrics = await calculateMetricsForLeads(leadsSnapshot, startDate, endDate);
        res.status(200).json({ sellerName: "Equipa Completa", metrics });

    } catch (error) {
        res.status(500).json({ error: 'Ocorreu um erro interno no servidor.' });
    }
});

// --- INICIALIZAÇÃO DO SERVIDOR ---
app.listen(PORT, () => {
    console.log(`Servidor da API do CRM v2.3 a rodar na porta ${PORT}`);
});

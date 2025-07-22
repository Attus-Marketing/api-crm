// Importação dos módulos necessários
const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');

// --- CONFIGURAÇÃO INICIAL ---
// O Render irá buscar este ficheiro a partir do "Secret File" que configurámos.
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const app = express();
// O Render define a porta automaticamente através da variável de ambiente PORT.
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors()); // Habilita o CORS para todas as rotas.

// --- FUNÇÃO AUXILIAR PARA CALCULAR MÉTRICAS ---
async function calculateMetricsForLeads(leadsSnapshot) {
    const metrics = {
        ligacoes: 0, conexoes: 0, conexoes_decisor: 0,
        reunioes_marcadas: 0, reunioes_realizadas: 0, vendas: 0
    };

    for (const leadDoc of leadsSnapshot.docs) {
        const leadData = leadDoc.data();
        if (leadData.stage === 'Vendido') metrics.vendas++;
        if (leadData.stage === 'R1 - Feita') metrics.reunioes_realizadas++;
        if (leadData.stage === 'R1 - Agendada') metrics.reunioes_marcadas++;

        const activitiesRef = leadDoc.ref.collection('activities');
        const activitiesSnapshot = await activitiesRef.get();
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

// ROTA DE DIAGNÓSTICO: Para verificar se o servidor está a responder.
app.get('/', (req, res) => {
    res.status(200).send('Servidor da API do ATTUS CRM está online e a funcionar!');
});

// Rota para buscar a lista de vendedores
app.get('/api/sellers', async (req, res) => {
    try {
        const sellersDoc = await db.collection('crm_config').doc('sellers').get();
        if (!sellersDoc.exists) {
            return res.status(404).json({ error: 'Documento de vendedores não encontrado.' });
        }
        res.status(200).json(sellersDoc.data().list || []);
    } catch (error) {
        console.error("Erro ao buscar vendedores:", error);
        res.status(500).json({ error: 'Ocorreu um erro interno no servidor.' });
    }
});

// Rota para buscar métricas de um vendedor específico
app.get('/api/metrics/seller/:sellerName', async (req, res) => {
    try {
        const { sellerName } = req.params;
        const leadsQuery = db.collection('crm_leads_shared').where('vendedor', '==', sellerName);
        const leadsSnapshot = await leadsQuery.get();

        if (leadsSnapshot.empty) {
            return res.status(200).json({
                sellerName: sellerName,
                metrics: { ligacoes: 0, conexoes: 0, conexoes_decisor: 0, reunioes_marcadas: 0, reunioes_realizadas: 0, vendas: 0 }
            });
        }
        
        const metrics = await calculateMetricsForLeads(leadsSnapshot);
        res.status(200).json({ sellerName, metrics });

    } catch (error) {
        console.error("Erro ao processar métricas de vendedor:", error);
        res.status(500).json({ error: 'Ocorreu um erro interno no servidor.' });
    }
});

// Rota para buscar métricas da equipa completa
app.get('/api/metrics/team', async (req, res) => {
    try {
        const leadsSnapshot = await db.collection('crm_leads_shared').get();

        if (leadsSnapshot.empty) {
            return res.status(200).json({
                sellerName: "Equipa Completa",
                metrics: { ligacoes: 0, conexoes: 0, conexoes_decisor: 0, reunioes_marcadas: 0, reunioes_realizadas: 0, vendas: 0 }
            });
        }

        const metrics = await calculateMetricsForLeads(leadsSnapshot);
        res.status(200).json({ sellerName: "Equipa Completa", metrics });

    } catch (error) {
        console.error("Erro ao processar métricas da equipa:", error);
        res.status(500).json({ error: 'Ocorreu um erro interno no servidor.' });
    }
});

// --- INICIALIZAÇÃO DO SERVIDOR ---
app.listen(PORT, () => {
    console.log(`Servidor da API do CRM v2.2 a rodar na porta ${PORT}`);
});

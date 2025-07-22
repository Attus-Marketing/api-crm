// Importação dos módulos necessários
// Express é o framework que nos ajuda a criar o servidor e as rotas da API.
// Firebase Admin SDK é o kit de ferramentas para conectar nosso servidor ao Firebase.
const express = require('express');
const admin = require('firebase-admin');

// --- CONFIGURAÇÃO INICIAL ---

// Carregue a sua chave de conta de serviço do Firebase.
// Este ficheiro JSON contém as credenciais seguras para a sua API aceder ao Firestore.
// **AÇÃO NECESSÁRIA:** Gere este ficheiro no seu painel do Firebase e coloque-o na mesma pasta.
const serviceAccount = require('./serviceAccountKey.json');

// Inicialize o SDK do Firebase Admin com as suas credenciais.
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// Crie uma instância do banco de dados Firestore.
const db = admin.firestore();

// Crie uma instância da aplicação Express.
const app = express();
// Defina a porta em que o servidor irá rodar.
const PORT = process.env.PORT || 3000;

// Middleware para permitir que a API receba dados em formato JSON.
app.use(express.json());

// Middleware para habilitar o CORS (Cross-Origin Resource Sharing).
// Isto é essencial para permitir que o seu dashboard (que roda noutra "origem")
// possa fazer pedidos a esta API.
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});


// --- DEFINIÇÃO DAS ROTAS DA API ---

/**
 * ROTA PRINCIPAL DE MÉTRICAS
 * GET /api/metrics
 * * Esta rota calcula as métricas de performance para um vendedor num dado período.
 * * Parâmetros de Query:
 * - sellerName (string, obrigatório): O nome do vendedor para filtrar.
 * - startDate (string, opcional, formato YYYY-MM-DD): Data de início do período.
 * - endDate (string, opcional, formato YYYY-MM-DD): Data de fim do período.
 */
app.get('/api/metrics', async (req, res) => {
    try {
        // Extrai os parâmetros da query da URL.
        const { sellerName, startDate, endDate } = req.query;

        // Validação: Verifica se o nome do vendedor foi fornecido.
        if (!sellerName) {
            return res.status(400).json({ error: 'O parâmetro "sellerName" é obrigatório.' });
        }

        // --- Passo 1: Buscar todos os leads do vendedor ---
        const leadsRef = db.collection('crm_leads_shared');
        const leadsQuery = leadsRef.where('vendedor', '==', sellerName);
        const leadsSnapshot = await leadsQuery.get();

        if (leadsSnapshot.empty) {
            return res.status(404).json({ message: `Nenhum lead encontrado para o vendedor: ${sellerName}` });
        }

        // --- Passo 2: Inicializar contadores de métricas ---
        const metrics = {
            ligacoes: 0,
            conexoes: 0,
            conexoes_decisor: 0,
            reunioes_marcadas: 0, // Será contado pelos estágios
            reunioes_realizadas: 0, // Será contado pelos estágios
            vendas: 0 // Será contado pelos estágios
        };

        // --- Passo 3: Processar cada lead para contar atividades e estágios ---
        // Usamos um loop `for...of` para poder usar `await` dentro dele.
        for (const leadDoc of leadsSnapshot.docs) {
            const leadData = leadDoc.data();

            // Contagem baseada nos ESTÁGIOS do lead
            if (leadData.stage === 'Vendido') metrics.vendas++;
            if (leadData.stage === 'R1 - Feita') metrics.reunioes_realizadas++;
            if (leadData.stage === 'R1 - Agendada') metrics.reunioes_marcadas++;

            // Contagem baseada nas ATIVIDADES registadas (subcoleção)
            const activitiesRef = leadDoc.ref.collection('activities');
            const activitiesSnapshot = await activitiesRef.get();

            activitiesSnapshot.forEach(activityDoc => {
                const activityData = activityDoc.data();

                // Filtra por data se os parâmetros foram fornecidos
                // (Nota: Esta filtragem é feita na aplicação, não na query, por simplicidade)
                const activityDate = activityData.timestamp.toDate();
                if (startDate && activityDate < new Date(startDate)) return;
                if (endDate && activityDate > new Date(endDate)) return;

                // Incrementa os contadores de atividades
                if (activityData.type === 'Ligação') {
                    metrics.ligacoes++;
                    if (activityData.outcome === 'Conexão Realizada') {
                        metrics.conexoes++;
                    }
                    if (activityData.outcome === 'Conexão com Decisor') {
                        metrics.conexoes++; // Uma conexão com decisor também é uma conexão.
                        metrics.conexoes_decisor++;
                    }
                }
            });
        }

        // --- Passo 4: Enviar a resposta com as métricas calculadas ---
        res.status(200).json({
            sellerName: sellerName,
            period: {
                start: startDate || 'Início',
                end: endDate || 'Fim'
            },
            metrics: metrics
        });

    } catch (error) {
        console.error("Erro ao processar as métricas:", error);
        res.status(500).json({ error: 'Ocorreu um erro interno no servidor.' });
    }
});


// --- INICIALIZAÇÃO DO SERVIDOR ---

// O servidor começa a "escutar" por pedidos na porta definida.
app.listen(PORT, () => {
    console.log(`Servidor da API do CRM a rodar na porta ${PORT}`);
    console.log(`Endpoint de teste: http://localhost:${PORT}/api/metrics?sellerName=NOME_DO_VENDEDOR`);
});

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Rota de diagnóstico para sabermos que este é o código certo
app.get('/', (req, res) => {
    res.status(200).send('Servidor de TESTE DE CONEXÃO da API está online!');
});

// Rota de teste para /api/sellers
// Responde com uma lista de vendedores falsa para testar a conexão.
app.get('/api/sellers', (req, res) => {
    console.log("Recebido pedido em /api/sellers (versão de teste)");
    res.status(200).json(["Vendedor A", "Vendedor B", "Vendedor C"]);
});

// Para todas as outras rotas da API, responde com dados vazios para não quebrar o dashboard.
// Isto garante que o dashboard não mostra um erro, mesmo que os dados estejam vazios.
app.get('/api/metrics/:type/:name?', (req, res) => {
    res.status(200).json({
        sellerName: "Modo de Teste",
        metrics: { ligacoes: 0, conexoes: 0, conexoes_decisor: 0, reunioes_marcadas: 0, reunioes_realizadas: 0, vendas: 0 }
    });
});

app.get('/api/analysis/:type', (req, res) => {
    res.status(200).json([]);
});

app.listen(PORT, () => {
    console.log(`Servidor de TESTE DE CONEXÃO da API a rodar na porta ${PORT}`);
});

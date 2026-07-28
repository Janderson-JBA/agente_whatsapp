require('dotenv').config(); // Carrega as variáveis do arquivo .env
const fs = require('fs');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Inicializa o Gemini com a sua chave
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MODELOS_GEMINI_CANDIDATOS = [
    'gemini-flash-lite-latest',
    'gemini-flash-latest',
    'gemini-3.5-flash-lite',
    'gemini-3.5-flash',
    'gemini-pro-latest'
];
const DEBOUNCE_MS = 8000;
const LOG_FILE_PATH = 'mensagens_log.txt';
const BLACKLIST_FILE_PATH = 'blacklist.txt';

let botStartTime = 0;
const filasPorChat = new Map();

function registrarLog(mensagem, erro = null) {
    const dataHora = new Date().toLocaleString('pt-BR');
    const erroDetalhe = erro
        ? ` | Erro: ${erro?.stack || erro?.message || String(erro)}`
        : '';
    const linha = `[${dataHora}] ${mensagem}${erroDetalhe}\n`;
    try {
        fs.appendFileSync(LOG_FILE_PATH, linha, 'utf8');
    } catch {
        // Evita recursão de log em caso de falha de escrita.
    }
}

function carregarBlacklist() {
    try {
        const conteudo = fs.readFileSync(BLACKLIST_FILE_PATH, 'utf8');
        return conteudo
            .split(/\r?\n/)
            .map((linha) => linha.trim())
            .filter((linha) => linha && !linha.startsWith('#'));
    } catch (erro) {
        registrarLog('⚠️ Não foi possível ler blacklist.txt. Prosseguindo sem bloqueios da blacklist.', erro);
        return [];
    }
}

async function gerarRespostaGemini(prompt, systemInstruction, logPrefix) {
    let ultimoErro = null;

    for (const nomeModelo of MODELOS_GEMINI_CANDIDATOS) {
        try {
            const model = genAI.getGenerativeModel({
                model: nomeModelo,
                systemInstruction: systemInstruction
            });

            const result = await model.generateContent(prompt);
            registrarLog(`${logPrefix} ✅ Modelo Gemini em uso: ${nomeModelo}`);
            return result.response.text();
        } catch (erroModelo) {
            ultimoErro = erroModelo;
            const eh404 = erroModelo?.status === 404;

            if (eh404) {
                registrarLog(`${logPrefix} ⚠️ Modelo indisponível (404): ${nomeModelo}. Tentando próximo...`);
                continue;
            }

            throw erroModelo;
        }
    }

    throw ultimoErro;
}

function formatarLinhaContexto(msg) {
    const texto = (msg.body || '').trim();
    if (!texto) {
        return null;
    }
    return `${msg.fromMe ? 'Bot disse' : 'Usuário disse'}: ${texto}`;
}

async function processarFilaDoChat(chatId) {
    const fila = filasPorChat.get(chatId);
    if (!fila || fila.mensagens.length === 0) {
        return;
    }

    const mensagensPendentes = [...fila.mensagens];
    fila.mensagens = [];
    fila.timeoutId = null;
    fila.processing = true;

    const msgBase = mensagensPendentes[mensagensPendentes.length - 1];
    const correlationId = msgBase?.id?._serialized || `${chatId}-${Date.now()}`;
    const logPrefix = `[CID:${correlationId}]`;

    let chat = null;
    let linhasHistorico = [];

    try {
        let systemInstruction = '';
        try {
            systemInstruction = fs.readFileSync('regras.txt', 'utf8');
        } catch (erroRegras) {
            registrarLog(`${logPrefix} ⚠️ Aviso: Arquivo regras.txt não encontrado ou erro na leitura. O bot usará o prompt vazio.`, erroRegras);
        }

        try {
            chat = await msgBase.getChat();
            const historicoBruto = await chat.fetchMessages({ limit: 8 });
            const historicoOrdenado = [...historicoBruto].reverse();

            linhasHistorico = historicoOrdenado
                .map(formatarLinhaContexto)
                .filter(Boolean);
        } catch (erroHistorico) {
            registrarLog(`${logPrefix} ⚠️ Não foi possível carregar contexto do chat via getChat/fetchMessages. Seguindo apenas com mensagens da fila.`, erroHistorico);
            chat = null;
            linhasHistorico = [];
        }

        const linhasNovasMensagens = mensagensPendentes
            .map((m) => (m.body || '').trim())
            .filter(Boolean)
            .map((texto) => `Usuário disse: ${texto}`);

        const contextoCompleto = [
            'Contexto das últimas mensagens:',
            ...(linhasHistorico.length ? linhasHistorico : ['Sem histórico disponível no momento.']),
            'Novas mensagens do usuário:',
            ...linhasNovasMensagens
        ].join('\n');

        const respostaGemini = await gerarRespostaGemini(contextoCompleto, systemInstruction, logPrefix);

        if (chat) {
            try {
                await chat.sendStateTyping();
            } catch (erroTyping) {
                registrarLog(`${logPrefix} ⚠️ Não foi possível ativar o status de digitação. Seguindo sem ele.`, erroTyping);
            }
        }

        await new Promise((resolve) => setTimeout(resolve, 2500));
        await client.sendMessage(chatId, respostaGemini);
        registrarLog(`${logPrefix} 🤖 Resposta do Gemini enviada com sucesso para ${chatId}.`);
    } catch (erroProcessamento) {
        registrarLog(`${logPrefix} ❌ Erro ao processar fila do chat ${chatId}:`, erroProcessamento);
        try {
            await client.sendMessage(chatId, 'Desculpe, não consegui processar sua mensagem agora. Pode tentar de novo em instantes?');
        } catch (erroEnvioFallback) {
            registrarLog(`${logPrefix} ❌ Erro ao enviar mensagem de fallback após falha no processamento:`, erroEnvioFallback);
        }
    } finally {
        if (chat) {
            try {
                await chat.clearState();
            } catch (erroClearState) {
                registrarLog(`${logPrefix} ⚠️ Não foi possível limpar o status de digitação.`, erroClearState);
            }
        }

        const estadoAtualFila = filasPorChat.get(chatId);
        if (estadoAtualFila) {
            estadoAtualFila.processing = false;
            if (estadoAtualFila.mensagens.length === 0 && !estadoAtualFila.timeoutId) {
                filasPorChat.delete(chatId);
            }
        }
    }
}

registrarLog('🚀 Iniciando o whatsapp-web.js e conectando ao WhatsApp...');

// Configuração do whatsapp-web.js com LocalAuth para salvar a sessão no disco
const client = new Client({
    authStrategy: new LocalAuth({ clientId: 'agente-janderson' }),
    puppeteer: {
        executablePath: '/usr/bin/chromium',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-software-rasterizer',
            '--disable-features=IsolateOrigins,site-per-process'
        ]
    }
});

// Evento disparado quando um QR Code é necessário (primeira conexão)
client.on('qr', (qr) => {
    registrarLog('📌 QR Code gerado. Escaneie com o WhatsApp para autenticar.');
    qrcode.generate(qr, { small: true });
});

// Evento disparado quando o bot se conecta com sucesso e está pronto
client.on('ready', () => {
    botStartTime = Math.floor(Date.now() / 1000);
    registrarLog('✅ WhatsApp Conectado! O agente está pronto para ouvir mensagens!');
    registrarLog(`🕒 Filtro de inicialização ativo. botStartTime=${botStartTime}`);
});

// Evento disparado ao receber qualquer mensagem
client.on('message', async (message) => {
    // No whatsapp-web.js, grupos terminam com '@g.us'
    const isGroupMsg = message.from.includes('@g.us');
    const isNewsletterMsg = message.from.includes('@newsletter');
    const ignoredNumbers = carregarBlacklist();
    const isIgnoredNumber = ignoredNumbers.includes(message.from);
    const correlationId = message?.id?._serialized || `${message.from}-${Date.now()}`;
    const logPrefix = `[CID:${correlationId}]`;

    registrarLog(`${logPrefix} Nova mensagem recebida | De: ${message.from} | Grupo: ${isGroupMsg} | Tipo: ${message.type} | Texto: ${message.body}`);
    
    // 6. Filtro rigoroso com explicações no terminal
    if (isGroupMsg) {
        registrarLog(`${logPrefix} [IGNORADO] Motivo: A mensagem veio de um grupo.`);
        return;
    }
    if (isNewsletterMsg) {
        registrarLog(`${logPrefix} [IGNORADO] Motivo: Mensagem de canal/newsletter.`);
        return;
    }
    if (isIgnoredNumber) {
        registrarLog(`${logPrefix} [IGNORADO] Motivo: Contato na blacklist (${message.from}).`);
        return;
    }
    if (!botStartTime || message.timestamp < botStartTime) {
        registrarLog(`${logPrefix} [IGNORADO] Motivo: Mensagem antiga da sincronização (timestamp=${message.timestamp}, botStartTime=${botStartTime}).`);
        return;
    }
    if (message.type !== 'chat') {
        registrarLog(`${logPrefix} [IGNORADO] Motivo: A mensagem não é texto de chat comum (tipo recebido: ${message.type}).`);
        return;
    }
    if (!message.body || message.body.trim() === '') {
        registrarLog(`${logPrefix} [IGNORADO] Motivo: O corpo da mensagem está vazio ou inválido.`);
        return;
    }

    let fila = filasPorChat.get(message.from);
    if (!fila) {
        fila = {
            mensagens: [],
            timeoutId: null,
            processing: false
        };
        filasPorChat.set(message.from, fila);
    }

    if (fila.timeoutId) {
        clearTimeout(fila.timeoutId);
    }

    fila.mensagens.push(message);
    fila.timeoutId = setTimeout(() => {
        processarFilaDoChat(message.from).catch((erroTimer) => {
            registrarLog(`${logPrefix} ❌ Erro inesperado ao processar debounce do chat ${message.from}:`, erroTimer);
        });
    }, DEBOUNCE_MS);

    registrarLog(`${logPrefix} 🧠 Mensagem adicionada à fila de ${message.from}. Total pendente: ${fila.mensagens.length}.`);
});

// Inicia a execução do bot
client.initialize();
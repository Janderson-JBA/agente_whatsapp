require('dotenv').config(); // Carrega as variáveis do arquivo .env
const fs = require('fs');

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const nodemailer = require('nodemailer');

// Inicializa o Gemini com a sua chave
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// Fila de modelos otimizada para custo zero/baixo e alta velocidade
const MODELOS_GEMINI_CANDIDATOS = [
    'gemini-flash-lite-latest',
    'gemini-flash-latest',
    'gemini-2.5-flash-lite',
    'gemini-2-flash-lite',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite'
];
const DEBOUNCE_MS = 4000;
const LIMITE_CONVERSAS_DIARIAS = 25;
const LIMITE_AVISO_DIARIO = 18;
const LIMITE_CARACTERES_MENSAGEM = 1000;
const LOG_FILE_PATH = 'recep_log.txt';
const BLACKLIST_FILE_PATH = 'blacklist.txt';

let botStartTime = 0;
const filasPorChat = new Map();
const chatHistory = new Map();
const controlesDiariosPorChat = new Map();
const mutedChats = new Map();
const botMessageIds = new Set();
const botSendingChats = new Set();

// Controle de anti-spam: evita reenviar notificação enquanto a conversa aguarda intervenção humana.
const notificacoesPendentesPorChat = new Map();
// Controle de anti-spam: evita enviar o e-mail de confirmação de reserva mais de uma vez por chat.
const reservasConfirmadasPorChat = new Map();
const MARCADOR_NOTIFICACAO_REGEX = /\s*\[NOTIFICAR_RECEPCAO(?:\s*:\s*([^\]]*))?\]\s*/i;
const MARCADOR_RESERVA_REGEX = /\s*\[RESERVA_CONFIRMADA\s*:\s*(\{[^\]]*\})\s*\]\s*/i;
let transporterEmail = null;

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
            .filter((linha) => linha && !linha.startsWith('#'))
            .map(normalizarIdentificadorChat);
    } catch (erro) {
        registrarLog('⚠️ Não foi possível ler blacklist.txt. Prosseguindo sem bloqueios da blacklist.', erro);
        return [];
    }
}

function normalizarIdentificadorChat(valor) {
    const texto = String(valor || '').trim();
    if (!texto) {
        return '';
    }

    return texto.split('@')[0].replace(/\D/g, '');
}

function estaNaBlacklist(chatId, blacklistNormalizada) {
    const idNormalizado = normalizarIdentificadorChat(chatId);
    return blacklistNormalizada.includes(idNormalizado);
}

function obterChaveDiaAtual() {
    return new Date().toLocaleDateString('pt-BR');
}

function obterControleDiario(chatId) {
    const chaveDia = obterChaveDiaAtual();
    const controleAtual = controlesDiariosPorChat.get(chatId);

    if (!controleAtual || controleAtual.chaveDia !== chaveDia) {
        const novoControle = {
            chaveDia,
            conversas: 0,
            bloqueado: false
        };
        controlesDiariosPorChat.set(chatId, novoControle);
        return novoControle;
    }

    return controleAtual;
}

function podeProcessarConversaDiaria(chatId) {
    const controle = obterControleDiario(chatId);
    return !controle.bloqueado && controle.conversas < LIMITE_CONVERSAS_DIARIAS;
}

function registrarConversaDiaria(chatId) {
    const controle = obterControleDiario(chatId);
    controle.conversas += 1;
    return controle.conversas;
}

function bloquearChatNoDia(chatId) {
    const controle = obterControleDiario(chatId);
    controle.bloqueado = true;
    return controle;
}

function carregarSystemInstruction() {
    try {
        return fs.readFileSync('regras_recep.txt', 'utf8').replace(/\r/g, '').trim();
    } catch (erroRegras) {
        return '';
    }
}

function obterHistoricoDoChat(chatId) {
    if (!chatHistory.has(chatId)) {
        chatHistory.set(chatId, []);
    }

    return chatHistory.get(chatId);
}

function adicionarAoHistorico(chatId, role, texto) {
    const historico = obterHistoricoDoChat(chatId);
    historico.push({
        role,
        parts: [{ text: texto }]
    });

    if (historico.length > 10) {
        historico.splice(0, 2);
    }

    return historico;
}

const LIMITE_MENSAGENS_HISTORICO_REAL = 10;

// Busca até 10 mensagens reais anteriores no WhatsApp para semear o contexto na primeira interação do chat.
async function carregarHistoricoRealDoChat(chat, chatId, mensagemAtualId, logPrefix) {
    if (chatHistory.has(chatId) && chatHistory.get(chatId).length > 0) {
        return;
    }

    try {
        const mensagensAnteriores = await chat.fetchMessages({ limit: LIMITE_MENSAGENS_HISTORICO_REAL });
        const historico = obterHistoricoDoChat(chatId);

        for (const msg of mensagensAnteriores) {
            const texto = (msg.body || '').trim();
            if (!texto || msg.id?._serialized === mensagemAtualId) {
                continue;
            }
            historico.push({
                role: msg.fromMe ? 'model' : 'user',
                parts: [{ text: texto }]
            });
        }

        if (historico.length > 10) {
            historico.splice(0, historico.length - 10);
        }

        if (historico.length > 0) {
            registrarLog(`${logPrefix} 📜 Histórico carregado a partir do WhatsApp: ${historico.length} mensagem(ns).`);
        }
    } catch (erroFetchMessages) {
        registrarLog(`${logPrefix} ⚠️ Não foi possível carregar mensagens anteriores do WhatsApp. Seguindo apenas com histórico em memória.`, erroFetchMessages);
    }
}

function limparRespostaGemini(texto) {
    const bruto = String(texto || '').trim();
    if (!bruto) {
        return '';
    }

    const linhas = bruto
        .split(/\r?\n+/)
        .map((linha) => linha.trim())
        .filter(Boolean);

    const linhasLimpa = [];
    for (const linha of linhas) {
        if (linhasLimpa[linhasLimpa.length - 1] !== linha) {
            linhasLimpa.push(linha);
        }
    }

    return linhasLimpa.join('\n').trim();
}

// Extrai o marcador interno [NOTIFICAR_RECEPCAO] / [NOTIFICAR_RECEPCAO: motivo] e remove do texto final.
function extrairNotificacao(texto) {
    const bruto = String(texto || '');
    const match = bruto.match(MARCADOR_NOTIFICACAO_REGEX);

    if (!match) {
        return { textoLimpo: bruto.trim(), deveNotificar: false, motivo: null };
    }

    const textoLimpo = bruto.replace(MARCADOR_NOTIFICACAO_REGEX, ' ').trim();
    const motivo = (match[1] || '').trim() || null;

    return { textoLimpo, deveNotificar: true, motivo };
}

// Extrai o marcador interno [RESERVA_CONFIRMADA: {json}], validando o JSON e removendo do texto final.
function extrairReservaConfirmada(texto) {
    const bruto = String(texto || '');
    const match = bruto.match(MARCADOR_RESERVA_REGEX);

    if (!match) {
        return { textoLimpo: bruto.trim(), reserva: null };
    }

    const textoLimpo = bruto.replace(MARCADOR_RESERVA_REGEX, ' ').trim();

    let reserva = null;
    try {
        reserva = JSON.parse(match[1]);
    } catch (erroJson) {
        registrarLog('⚠️ Marcador de reserva encontrado, mas com JSON inválido. Ignorando envio de e-mail.', erroJson);
        return { textoLimpo, reserva: null };
    }

    return { textoLimpo, reserva };
}

const PADRAO_INFORMACAO_SENSIVEL = /senha|password|token|api\s*key|api_key|chave de acesso|credencial|cart[aã]o de cr[eé]dito|cvv/i;

function contemInformacaoSensivel(texto) {
    return PADRAO_INFORMACAO_SENSIVEL.test(String(texto || ''));
}

const PADRAO_URGENCIA = /urgente|urg[eê]ncia|imediat|reclama[cç][aã]o|problema grave|acidente|emerg[eê]ncia/i;

function ehUrgente(...textos) {
    return textos.some((texto) => PADRAO_URGENCIA.test(String(texto || '')));
}

function obterTransportadorEmail() {
    if (!transporterEmail) {
        transporterEmail = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: Number(process.env.SMTP_PORT),
            secure: process.env.SMTP_SECURE === 'true',
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASSWORD
            }
        });
    }

    return transporterEmail;
}

function escaparHtml(texto) {
    return String(texto || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Envia a notificação por e-mail para a recepção; nunca derruba o processamento do WhatsApp em caso de falha.
async function enviarNotificacaoRecepcao({ chatId, nomeContato, mensagemUsuario, respostaIA, motivo, urgente, logPrefix }) {
    if (notificacoesPendentesPorChat.has(chatId)) {
        registrarLog(`${logPrefix} [Notificação] ⚠️ Notificação já enviada para ${chatId}. Evitando duplicação.`);
        return;
    }

    notificacoesPendentesPorChat.set(chatId, Date.now());
    registrarLog(`${logPrefix} [Notificação] 🔔 Conversa marcada para intervenção: ${chatId}`);

    const contemDadoSensivel = contemInformacaoSensivel(mensagemUsuario) || contemInformacaoSensivel(respostaIA);
    const mensagemParaEmail = contemDadoSensivel
        ? 'O hóspede enviou uma informação sensível que requer atenção (não exibida por segurança).'
        : mensagemUsuario;
    const respostaParaEmail = contemDadoSensivel && contemInformacaoSensivel(respostaIA)
        ? 'Resposta omitida por conter possível informação sensível.'
        : respostaIA;

    const dataHora = new Date().toLocaleString('pt-BR');
    const assunto = urgente
        ? `[Recepção] URGENTE - ${nomeContato}`
        : `[Recepção] Atenção necessária - ${nomeContato}`;

    const html = `
        <h2>ATENÇÃO NECESSÁRIA NA RECEPÇÃO</h2>
        <p><strong>Contato:</strong><br>${escaparHtml(nomeContato)}</p>
        <p><strong>WhatsApp:</strong><br>${escaparHtml(chatId)}</p>
        <p><strong>Data/Hora:</strong><br>${escaparHtml(dataHora)}</p>
        <p><strong>Motivo:</strong><br>${escaparHtml(motivo || 'Não especificado pela IA')}</p>
        <p><strong>Mensagem recebida:</strong><br>"${escaparHtml(mensagemParaEmail)}"</p>
        <p><strong>Resposta enviada pela IA:</strong><br>"${escaparHtml(respostaParaEmail)}"</p>
        <p><strong>Status:</strong><br>Aguardando intervenção de um atendente humano</p>
    `;

    try {
        const transporter = obterTransportadorEmail();
        await transporter.sendMail({
            from: `"Recepção do Hotel" <${process.env.SMTP_FROM}>`,
            to: process.env.RECEPCAO_NOTIFICATION_EMAIL || process.env.NOTIFICATION_EMAIL,
            subject: assunto,
            html
        });
        registrarLog(`${logPrefix} [Notificação] 📧 E-mail de atenção enviado com sucesso.`);
    } catch (erroEmail) {
        registrarLog(`${logPrefix} [Notificação] ❌ Falha ao enviar e-mail:`, erroEmail);
    }
}

// Envia o e-mail de confirmação de reserva; só é chamado depois que o hóspede aceita explicitamente.
async function enviarEmailReserva({ chatId, nomeContato, reserva, logPrefix }) {
    if (reservasConfirmadasPorChat.has(chatId)) {
        registrarLog(`${logPrefix} [Reserva] ⚠️ E-mail de reserva já enviado para ${chatId}. Evitando duplicação.`);
        return;
    }

    reservasConfirmadasPorChat.set(chatId, Date.now());
    registrarLog(`${logPrefix} [Reserva] 🔔 Reserva confirmada pelo hóspede: ${chatId}`);

    const dataHora = new Date().toLocaleString('pt-BR');
    const assunto = `[Reserva Confirmada] ${reserva.nome || nomeContato}`;

    const html = `
        <h2>NOVA RESERVA CONFIRMADA</h2>
        <p><strong>Contato:</strong><br>${escaparHtml(nomeContato)}</p>
        <p><strong>WhatsApp:</strong><br>${escaparHtml(chatId)}</p>
        <p><strong>Data/Hora da confirmação:</strong><br>${escaparHtml(dataHora)}</p>
        <p><strong>Nome completo:</strong><br>${escaparHtml(reserva.nome)}</p>
        <p><strong>CPF:</strong><br>${escaparHtml(reserva.cpf)}</p>
        <p><strong>Check-in:</strong><br>${escaparHtml(reserva.checkin)}</p>
        <p><strong>Check-out:</strong><br>${escaparHtml(reserva.checkout)}</p>
        <p><strong>Tipo de quarto:</strong><br>${escaparHtml(reserva.tipo_quarto)}</p>
        <p><strong>Valor da diária:</strong><br>${escaparHtml(reserva.valor_diaria)}</p>
        <p><strong>Observações:</strong><br>${escaparHtml(reserva.observacoes || 'Nenhuma')}</p>
    `;

    try {
        const transporter = obterTransportadorEmail();
        await transporter.sendMail({
            from: `"Recepção do Hotel" <${process.env.SMTP_FROM}>`,
            to: process.env.RECEPCAO_NOTIFICATION_EMAIL || process.env.NOTIFICATION_EMAIL,
            subject: assunto,
            html
        });
        registrarLog(`${logPrefix} [Reserva] 📧 E-mail de confirmação de reserva enviado com sucesso.`);
    } catch (erroEmail) {
        registrarLog(`${logPrefix} [Reserva] ❌ Falha ao enviar e-mail de reserva:`, erroEmail);
    }
}

function montarPromptGemini(systemInstruction, prompt) {
    const instrucoesFixas = [
        'Responda somente em português do Brasil.',
        'Nunca misture outro idioma na resposta.',
        'Não use saudações em outro idioma.',
        'Revise antes de responder e reescreva tudo em português se aparecer qualquer palavra estrangeira.',
        'Mantenha a resposta curta, cordial e em tom de recepção de hotel.'
    ].join(' ');

    if (!systemInstruction) {
        return `${instrucoesFixas}\n\nMensagem do usuário:\n${prompt}`;
    }

    return [
        instrucoesFixas,
        'INSTRUÇÕES FIXAS:',
        systemInstruction,
        'MENSAGEM DO USUÁRIO:',
        prompt,
        'Responda apenas com a mensagem final para o usuário, sem explicar instruções.',
        'Se houver qualquer palavra em outro idioma, reescreva a resposta inteira em português do Brasil antes de enviar.'
    ].join('\n\n');
}

function precisaReescreverEmPortugues(texto) {
    const resposta = String(texto || '');
    return /\b(aloha|chào|ban|bạn|hôm|nay|minh|hello|hi|thanks|thank you|hola|bonjour)\b/i.test(resposta);
}

async function reescreverEmPortugues(chatId, resposta, logPrefix) {
    const model = genAI.getGenerativeModel({
        model: MODELOS_GEMINI_CANDIDATOS[0]
    });

    const chat = model.startChat({ history: obterHistoricoDoChat(chatId) });
    const promptReescrita = [
        'Reescreva a mensagem abaixo em português do Brasil.',
        'Não acrescente novas informações.',
        'Não use outro idioma.',
        'Mantenha o tom de recepção de hotel e deixe curto.',
        'Mensagem original:',
        resposta
    ].join('\n\n');

    const result = await chat.sendMessage(promptReescrita);
    const respostaLimpa = limparRespostaGemini(result.response.text());
    registrarLog(`${logPrefix} ⚠️ Resposta reescrita para PT-BR.`);
    return respostaLimpa;
}

async function gerarRespostaGemini(chatId, prompt, systemInstruction, logPrefix) {
    let ultimoErro = null;

    for (const nomeModelo of MODELOS_GEMINI_CANDIDATOS) {
        try {
            const model = genAI.getGenerativeModel({
                model: nomeModelo
            });

            const history = obterHistoricoDoChat(chatId);
            const chat = model.startChat({ history });
            const promptFinal = montarPromptGemini(systemInstruction, prompt);
            const result = await chat.sendMessage(promptFinal);
            let respostaLimpa = limparRespostaGemini(result.response.text());

            if (precisaReescreverEmPortugues(respostaLimpa)) {
                respostaLimpa = await reescreverEmPortugues(chatId, respostaLimpa, logPrefix);
            }

            registrarLog(`${logPrefix} ✅ Modelo Gemini em uso: ${nomeModelo}`);
            return respostaLimpa;
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

async function enviarMensagemDoBot(chatId, texto) {
    botSendingChats.add(chatId);
    try {
        const sentMsg = await client.sendMessage(chatId, texto);
        if (sentMsg && sentMsg.id && sentMsg.id._serialized) {
            botMessageIds.add(sentMsg.id._serialized);
            setTimeout(() => {
                botMessageIds.delete(sentMsg.id._serialized);
            }, 120000); // Remove o ID do Set após 2 minutos para evitar vazamento de memória
        }
        return sentMsg;
    } finally {
        // Mantém a flag um pouco além do envio para cobrir o delay do evento message_create.
        setTimeout(() => {
            botSendingChats.delete(chatId);
        }, 5000);
    }
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

    try {
        const systemInstruction = carregarSystemInstruction();
        if (!systemInstruction) {
            registrarLog(`${logPrefix} ⚠️ Aviso: regras_recep.txt vazio ou indisponível. O bot seguirá sem instruções fixas.`);
        }

        try {
            chat = await msgBase.getChat();
        } catch (erroHistorico) {
            registrarLog(`${logPrefix} ⚠️ Não foi possível obter o chat via getChat (comum em contatos @lid). Seguindo com histórico em memória.`, erroHistorico);
            chat = null;
        }

        if (chat) {
            await carregarHistoricoRealDoChat(chat, chatId, msgBase?.id?._serialized, logPrefix);
        }

        const linhasNovasMensagens = mensagensPendentes
            .map((m) => (m.body || '').trim())
            .filter(Boolean)
            .map((texto) => texto);

        const textoMensagemUsuario = linhasNovasMensagens.join('\n').trim();

        if (!textoMensagemUsuario) {
            throw new Error('Mensagem do usuário vazia após o debounce.');
        }

        if (textoMensagemUsuario.length > LIMITE_CARACTERES_MENSAGEM) {
            registrarLog(`${logPrefix} ⚠️ Mensagem acima do limite de caracteres (${textoMensagemUsuario.length}/${LIMITE_CARACTERES_MENSAGEM}).`);
            await client.sendMessage(chatId, `Sua mensagem ficou longa demais. Pode me enviar em partes menores, por favor?`);
            return;
        }

        const controleDiario = obterControleDiario(chatId);

        if (controleDiario.bloqueado || controleDiario.conversas >= LIMITE_CONVERSAS_DIARIAS) {
            registrarLog(`${logPrefix} ⚠️ Limite diário atingido para ${chatId}. Chat ignorado até virar o dia.`);
            return;
        }

        if (controleDiario.conversas >= LIMITE_AVISO_DIARIO) {
            bloquearChatNoDia(chatId);
            registrarLog(`${logPrefix} ⚠️ Chat próximo do limite diário (${controleDiario.conversas}/${LIMITE_CONVERSAS_DIARIAS}). Avisando e ignorando o restante do dia.`);
            await enviarMensagemDoBot(chatId, 'Por hoje já registrei bastante coisa por aqui. Em breve alguém da recepção continua o atendimento.');
            return;
        }

        registrarConversaDiaria(chatId);

        adicionarAoHistorico(chatId, 'user', textoMensagemUsuario);

        const respostaGemini = await gerarRespostaGemini(chatId, textoMensagemUsuario, systemInstruction, logPrefix);

        if (!respostaGemini) {
            throw new Error('Resposta vazia após limpeza de duplicações.');
        }

        const { textoLimpo: textoSemReserva, reserva } = extrairReservaConfirmada(respostaGemini);
        const { textoLimpo: respostaLimpaFinal, deveNotificar, motivo } = extrairNotificacao(textoSemReserva);

        if (!respostaLimpaFinal) {
            throw new Error('Resposta vazia após remover marcadores internos.');
        }

        adicionarAoHistorico(chatId, 'model', respostaLimpaFinal);

        let nomeContato = chatId;
        if (deveNotificar || reserva) {
            try {
                const contato = await msgBase.getContact();
                nomeContato = contato?.pushname || contato?.name || contato?.number || chatId;
            } catch (erroContato) {
                registrarLog(`${logPrefix} ⚠️ Não foi possível obter o nome do contato. Usando o ID do chat.`, erroContato);
            }
        }

        // O e-mail de reserva só é enviado quando o hóspede confirma explicitamente todos os dados.
        if (reserva) {
            await enviarEmailReserva({ chatId, nomeContato, reserva, logPrefix });
        }

        if (deveNotificar) {
            await enviarNotificacaoRecepcao({
                chatId,
                nomeContato,
                mensagemUsuario: textoMensagemUsuario,
                respostaIA: respostaLimpaFinal,
                motivo,
                urgente: ehUrgente(textoMensagemUsuario, motivo),
                logPrefix
            });
        }

        if (chat) {
            try {
                await chat.sendStateTyping();
            } catch (erroTyping) {
                registrarLog(`${logPrefix} ⚠️ Não foi possível ativar o status de digitação. Seguindo sem ele.`, erroTyping);
            }
        }

        await new Promise((resolve) => setTimeout(resolve, 2500));
        await enviarMensagemDoBot(chatId, respostaLimpaFinal);
        registrarLog(`${logPrefix} 🤖 Resposta do Gemini enviada com sucesso para ${chatId}.`);
    } catch (erroProcessamento) {
        registrarLog(`${logPrefix} ❌ Erro ao processar fila do chat ${chatId}:`, erroProcessamento);
        try {
            await enviarMensagemDoBot(chatId, 'Desculpe, não consegui processar sua mensagem agora. Pode tentar novamente em instantes?');
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

registrarLog('🚀 Iniciando o whatsapp-web.js (recepção) e conectando ao WhatsApp...');

// Configuração do whatsapp-web.js com LocalAuth para salvar a sessão no disco (clientId próprio, separado do index.js)
const client = new Client({
    authStrategy: new LocalAuth({ clientId: 'agente-recepcao' }),
    authTimeoutMs: 120000,
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.31 Safari/537.36',
    webVersion: '2.3000.1045828994-alpha',
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html',
        strict: true
    },
    puppeteer: {
        executablePath: fs.existsSync('/usr/bin/chromium')
            ? '/usr/bin/chromium'
            : (fs.existsSync('/usr/bin/chromium-browser') ? '/usr/bin/chromium-browser' : undefined),
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
    registrarLog('✅ WhatsApp Conectado! A recepção virtual está pronta para atender!');
    registrarLog(`🕒 Filtro de inicialização ativo. botStartTime=${botStartTime}`);
    registrarLog(`👤 Conta conectada: ${client.info?.wid?._serialized || 'não identificada'}`);
});

client.on('authenticated', () => {
    registrarLog('🔐 Sessão do WhatsApp autenticada com sucesso.');
});

client.on('auth_failure', (mensagem) => {
    registrarLog(`❌ Falha na autenticação do WhatsApp: ${mensagem}`);
});

client.on('disconnected', (motivo) => {
    registrarLog(`⚠️ WhatsApp desconectado: ${motivo}`);
    process.exitCode = 1;
    process.exit();
});

client.on('change_state', (estado) => {
    registrarLog(`ℹ️ Estado do WhatsApp alterado: ${estado}`);
});

client.on('error', (erro) => {
    registrarLog('❌ Erro do cliente do WhatsApp.', erro);
});

// Mantém o processo vivo; a conexão é monitorada pelos eventos do cliente.
const manterProcessoAtivo = setInterval(() => {}, 60 * 60 * 1000);

// Evento disparado para todas as mensagens criadas (enviadas por mim ou recebidas)
client.on('message_create', async (message) => {
    registrarLog(`[RAW] Mensagem ${message.fromMe ? 'de saída' : 'de entrada'} | De: ${message.from} | Para: ${message.to} | Tipo: ${message.type} | Texto: ${message.body || '[sem texto]'}`);

    // Verifica se a mensagem foi enviada por mim (atendente humano da recepção)
    // E garante que essa mensagem não foi disparada pelo próprio código do bot
    if (message.fromMe && !botMessageIds.has(message.id._serialized) && !botSendingChats.has(message.to)) {
        const endOfDay = new Date();
        endOfDay.setHours(23, 59, 59, 999);
        const expirationTimestamp = endOfDay.getTime();

        mutedChats.set(message.to, expirationTimestamp);
        registrarLog(`[Human Takeover] Mensagem enviada pelo humano para ${message.to}. Chat silenciado para o bot até ${new Date(expirationTimestamp).toLocaleString('pt-BR')}.`);

        if (notificacoesPendentesPorChat.delete(message.to)) {
            registrarLog(`[Notificação] ✅ Pendência de notificação resetada para ${message.to} (atendente respondeu manualmente).`);
        }
    }
});

// Evento disparado ao receber qualquer mensagem
client.on('message', async (message) => {
    // Verifica se o chat está pausado devido ao Human Takeover
    const expiration = mutedChats.get(message.from);
    if (expiration) {
        if (Date.now() < expiration) {
            registrarLog(`[Pausa/Human Takeover] Chat ${message.from} ignorado/silenciado temporariamente.`);
            return;
        } else {
            mutedChats.delete(message.from);
        }
    }

    // No whatsapp-web.js, grupos terminam com '@g.us'
    const isGroupMsg = message.from.includes('@g.us');
    const isBroadcastMsg = message.from.includes('@broadcast');
    const isNewsletterMsg = message.from.includes('@newsletter');
    const ignoredNumbers = carregarBlacklist();
    const isIgnoredNumber = estaNaBlacklist(message.from, ignoredNumbers);
    const correlationId = message?.id?._serialized || `${message.from}-${Date.now()}`;
    const logPrefix = `[CID:${correlationId}]`;

    registrarLog(`${logPrefix} Nova mensagem recebida | De: ${message.from} | Grupo: ${isGroupMsg} | Tipo: ${message.type} | Texto: ${message.body}`);

    // Filtro rigoroso com explicações no terminal
    if (isGroupMsg) {
        registrarLog(`${logPrefix} [IGNORADO] Motivo: A mensagem veio de um grupo.`);
        return;
    }
    if (isBroadcastMsg) {
        registrarLog(`${logPrefix} [IGNORADO] Motivo: Mensagem de status/broadcast.`);
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
client.initialize().catch((erroInicializacao) => {
    registrarLog('❌ Falha ao inicializar o cliente do WhatsApp.', erroInicializacao);
});

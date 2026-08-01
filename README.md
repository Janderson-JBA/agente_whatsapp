# Agente WhatsApp

Projeto simples para automatizar interações no WhatsApp usando Node.js.

## Objetivo

Este projeto cria um agente que pode responder mensagens automaticamente com base em regras e integração com modelos de IA.

## Estrutura do Projeto

Arquivos que o projeto usa para funcionar:

- `index.js`: arquivo principal do bot, com a lógica do WhatsApp, debounce, histórico, blacklist e Gemini.
- `package.json`: dependências e metadata do projeto.
- `.env`: variáveis de ambiente locais, principalmente a chave da API do Gemini.
- `regras.txt`: instruções de comportamento/persona lidas pelo bot antes de responder.
- `blacklist.txt`: contatos bloqueados, um por linha.

Arquivos gerados automaticamente durante a execução:

- `mensagens_log.txt`: log de execução e erros.
- `.wwebjs_auth/`: sessão autenticada do WhatsApp.
- `.wwebjs_cache/`: cache interno do `whatsapp-web.js`.

Arquivos opcionais, mas recomendados:

- `.env.example`: modelo para copiar e criar o arquivo `.env`.

## Requisitos

- Node.js
- npm

## Configuração

1. Instale as dependências.

```bash
npm install
```

2. Crie o arquivo `.env` com base em `.env.example` e adicione sua chave do Gemini.

3. Confira `regras.txt` e `blacklist.txt` antes de iniciar o bot.

## Instalação

```bash
npm install
```

## Execução

```bash
node index.js
```

## Observações

- Se `regras.txt` não existir, o bot pode subir sem a personalidade/configuração de comportamento.
- Se `blacklist.txt` não existir, o bot não terá contatos bloqueados.
- As pastas `.wwebjs_auth/` e `.wwebjs_cache/` são criadas automaticamente pela autenticação do WhatsApp.
# Changelog

## [Não lançado]

### Adicionado
- `recep.js`: novo agente de WhatsApp para recepção de hotel, rodando em uma sessão separada (`clientId: agente-recepcao`), com fluxo de reserva guiado (datas, tipo de quarto, valor, nome e CPF) e envio de e-mail de confirmação apenas após o hóspede aceitar explicitamente a reserva.
- `regras_recep.txt`: prompt de regras da recepcionista virtual, com tabela de tipos de quarto/valores, fluxo passo a passo de reserva e marcadores internos `[RESERVA_CONFIRMADA]` e `[NOTIFICAR_RECEPCAO]`.
- `ecosystem.config.js`: configuração do PM2 para manter `agente-pessoal` (`index.js`) e `agente-recepcao` (`recep.js`) rodando simultaneamente, cada um com sua própria sessão de WhatsApp, com restart automático em caso de falha.
- Script `start:recep` no `package.json` para rodar o `recep.js` isoladamente (`npm run start:recep`).
- Variável opcional `RECEPCAO_NOTIFICATION_EMAIL` para definir um e-mail de notificação específico da recepção (cai no `NOTIFICATION_EMAIL` se não configurada).

### Alterado
- `.gitignore`: passou a ignorar `recep_log.txt`, `regras_recep.txt`, pastas de backup `.wwebjs_cache.backup-*/` e o arquivo de anotações pessoais `comanos.txt`.

### Infraestrutura
- PM2 instalado e configurado no servidor para gerenciar os dois agentes (`agente-pessoal` e `agente-recepcao`) como processos independentes, com `pm2 save` para persistir a lista de processos entre reinícios.

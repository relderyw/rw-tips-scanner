# RW TIPS Strategy Scanner

Painel web (React + Vite + Tailwind) para validar estratégias de opções binárias com backtest sobre candles históricos, mais uma ponte Python (FastAPI) que entrega candles reais da IQ Option.

> Resultados históricos não garantem resultados futuros. Opções binárias envolvem alto risco de perda total do capital.

## Rodar o painel

```bash
npm install
npm run dev        # http://localhost:5173
```

Sem configurar a ponte, o painel usa **candles simulados determinísticos** (badge "dados simulados").
O login é feito pelo Firebase Authentication. A configuração web fica no `.env` local, ignorado pelo Git; não use nem publique o arquivo de credenciais Firebase Admin SDK no frontend.

No Firebase Console, habilite o provedor **E-mail/senha** em Authentication > Sign-in method. Crie manualmente a conta inicial do administrador no Firebase Authentication e autorize o domínio do painel em Authentication > Settings > Authorized domains.

```dotenv
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
VITE_FIREBASE_ADMIN_EMAIL=...
```

Copie os valores da configuração do app web do Firebase para `.env` (o projeto já inclui os valores web fornecidos). Defina `VITE_FIREBASE_ADMIN_EMAIL` para a conta inicial de administrador. Depois de alterar o `.env`, reinicie `npm run dev`.

## Estrutura

```
src/
  App.jsx                 rotas
  pages/                  Login, Dashboard, Scanner, Strategies, StrategyDetail, Assets, RadarLive, Administrator
  components/             Layout, ui, CandleMiniChart, BankrollChart, RequireAuth
  data/
    candleData.js         ÚNICO ponto de acesso a candles/payouts (ponte -> fallback simulado)
    strategies.js         catálogo de estratégias do PROMPT.txt e status de implementação
  lib/
    indicators.js         EMA, SMA, RSI, Bollinger, Estocástico, MACD, ATR...
    detectors.js          detectores de sinal (um por tipo de regra)
    backtestEngine.js     sinais, simulação com até 2 Gales, estatísticas, curva de banca
    strategyValidation.js valida cada paridade/estratégia e libera sinais aprovados
    stats.js              break-even, expectância, Wilson 95%, confiança, formatadores pt-BR
    runner.js             carrega candles + roda backtests/scan (com cache)
  services/
    bridgeApi.js          cliente HTTP da ponte
    dataStatus.js         store de estado (fonte simulada/real, payouts, health)
    authService.js        autenticação e validade de acesso via Firebase Authentication
bridge/                   ponte Python (FastAPI + Firebase Admin + SQLite + Docker)
```

## Conectar a ponte (candles reais)

1. Suba a ponte (abaixo).
2. Configure apenas o endereço da ponte no `.env` da raiz:
   ```
   VITE_BRIDGE_URL=http://localhost:8000
   ```
3. Abra o painel, entre com seu usuário e acesse **Conectar IQ**. Cada pessoa informa seu próprio e-mail e senha da conta real. A ponte cria uma sessão e um banco SQLite isolados para essa conta.

As credenciais IQ só são mantidas em memória na ponte enquanto a sessão está conectada; não são armazenadas no navegador nem no banco de candles. O token temporário da sessão fica em `sessionStorage` e expira após 15 minutos sem uso. Em produção, sirva o painel e a ponte por HTTPS e configure `CORS_ORIGINS` para a origem do painel.

A aba **Administrador** cria usuários por meio de um endpoint da ponte protegido pelo Firebase Admin SDK. Configure `FIREBASE_ADMIN_EMAIL` com o mesmo e-mail definido no painel e disponibilize as credenciais de serviço **somente no servidor** (`FIREBASE_ADMIN_CREDENTIALS` como caminho do arquivo ou `FIREBASE_ADMIN_CREDENTIALS_JSON` como variável secreta). A chave de serviço nunca deve ser copiada para uma variável `VITE_*` nem publicada no GitHub. Cada novo usuário recebe a claim `access_expires_at`; o painel encerra a sessão quando o prazo expira.

Os sinais confirmados do Radar são exibidos no formato pronto para compartilhar, podem ser copiados e são enviados ao destino Telegram comum configurado no servidor com o ticker exatamente como recebido da IQ Option. A ponte persiste os IDs de sinais e de mensagens em `bridge/data/telegram_signals.sqlite3` para bloquear reenvios após reiniciar; mantenha `bridge/data` em volume persistente na hospedagem. Ao completar a operação, o Radar edita a mensagem original com Green ✅ ou Red ❌; DOJI não altera a mensagem. Configure `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID` em `bridge/.env` local ou como variáveis secretas no host da ponte (por exemplo, Railway). Todas as sessões enviam apenas para esse destino; o token nunca vai ao navegador, não deve ser colocado em `VITE_*` e não deve ser commitado.

## Ponte Python

```bash
cd bridge
cp .env.example .env
docker compose up -d --build
```

Sem Docker: `pip install -r requirements.txt && uvicorn main:app --port 8000` (Python 3.10+).

Para autenticar uma conta, use a página **Conectar IQ** no painel. Ela envia as credenciais à ponte, que devolve um token temporário para as consultas autenticadas; não reutilize nem compartilhe esse token.

Notas:
- `iqoptionapi` é **não oficial**: pode quebrar com mudanças da plataforma e pode violar os termos da IQ Option. A tela conecta à conta real para consulta de saldo, histórico e candles; a ponte não envia ordens.
- Cada login IQ cria seu próprio coletor e banco SQLite sob `bridge/data/users/`; os bancos usam identificadores derivados do e-mail, não o e-mail em texto puro.
- A aba **Entradas** consulta o saldo atual e até 100 operações recentes da conta real. A integração é somente leitura: não há envio de ordens pelo app.
- A aba **Ativos** consulta dinamicamente os ativos binários que a IQ Option informa como abertos para a conta e seus payouts atuais. A análise individual busca candles fechados diretamente na IQ e mantém o histórico em cache isolado por usuário. Um ativo novo que ainda não exista no mapeamento de candles da biblioteca aparece na lista, mas fica sem análise até a biblioteca suportá-lo.
- O coletor contínuo/WebSocket mantém o conjunto de streams configurado em `bridge/config.py`. O Radar seleciona os 10 ativos abertos com maior payout entre os que a biblioteca suporta e consulta seus candles reais pela ponte; o ranking é atualizado a cada 60 s e o histórico é revalidado em até 2 min. Ativos sem candles suportados não entram no ranking analisado.
- O coletor consome streams de candles fechados, faz backfill paginado, persiste no SQLite e disponibiliza REST/WebSocket. Se a conexão cair, tenta reconectar com backoff e recuperar candles faltantes.
- Ao abrir o painel autenticado, o catálogo é reavaliado nos ativos suportados e nos timeframes das estratégias implementadas, com atualização a cada 2 minutos. As estatísticas consideram o período definido para avaliação.
- O catálogo segue as 34 estratégias e exibe status de implementação e `backtest_enabled`. As regras executáveis foram implementadas como evaluators independentes. 31 estão `IMPLEMENTADA`, com documentação e testes; as três estratégias de rompimento/reteste continuam `VALIDAÇÃO PENDENTE` porque exigem tick-size por ativo. Elas não entram no scanner até a ponte fornecer esse dado. As variantes indicadas como propostas são regras do RW TIPS e não alegações de equivalência universal com versões externas de mesmo nome.
- A MHI 1 usa as três primeiras velas M1 fechadas de cada bloco de cinco minutos UTC, entra na abertura da quarta e expira no fechamento dela. As regras e exemplos válidos/inválidos de todas as estratégias estão no catálogo; dojis cancelam sinais dependentes da direção e um candle final empatado é registrado como DOJI, fora da assertividade.
- A API de candles ainda não retorna precisão/tick-size confiável por ativo. Precisão pode ser fornecida quando disponível; rompimento de resistência, rompimento de suporte e breakout com reteste permanecem desabilitados até existir tick-size real para a cotação.
- O Radar Live só exibe sinais de configurações com dados reais, pelo menos 10 operações completas na janela e assertividade acima do break-even. A ponte mantém os candles no SQLite; após reabrir o painel, o catálogo é calculado novamente a partir desses dados.

## Como o backtest funciona

- As regras do catálogo geram sinais somente com candles fechados; a entrada padrão é na abertura da vela seguinte e expira após uma vela. Regras de ciclo calculam seus offsets explicitamente.
- Gale/Martingale é desativado por padrão (gale 0); níveis adicionais são apenas uma simulação opcional. Sinais sobrepostos da mesma estratégia/ativo são bloqueados.
- O filtro inicial do scanner exige payout mínimo de 85%. Operações que não atingem a expiração não são contabilizadas.
- Payout em %; break-even = 100 / (1 + payout). Expectância = lucro médio por operação (em unidades da entrada base).
- Os candles simulados são um passeio aleatório: espere assertividade ≈ 50% (abaixo do break-even). Isso é proposital — qualquer "edge" nesses dados é ruído.

## Adicionar uma estratégia

1. Se precisar de uma lógica nova, crie um evaluator independente em `src/lib/detectors.js`.
2. Adicione uma entrada em `src/data/strategies.js` com todos os campos operacionais, exemplos, fonte e status formal.
3. Só use `IMPLEMENTADA` com documentação completa, evaluator identificado e testes aprovados; os filtros de backtest e scanner aplicam esse gate.

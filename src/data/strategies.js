const STATUS = Object.freeze({
  IMPLEMENTED: 'IMPLEMENTADA',
  VALIDATION_PENDING: 'VALIDAÇÃO PENDENTE',
  RULE_PENDING: 'REGRA PENDENTE',
  DISABLED: 'DESATIVADA',
});

export const STRATEGY_STATUSES = Object.values(STATUS);
export const CATEGORIES = ['Candles', 'Padrões específicos', 'Price Action'];

const definitions = [
  ['mhi-1-minority-5m', 'MHI 1 — Minoria em bloco de 5 minutos', 'Candles', 'mhi1MinorityBlock5m', 'M1', 3, 'Bloco fixo de 5 minutos UTC; referências nas posições 1–3.', '2 CALL + 1 PUT → PUT; 2 PUT + 1 CALL → CALL.', 'Abertura da 4ª vela do bloco.', 'Doji, lacuna, bloco incompleto/desalinhado ou empate.', 'Fácil de auditar.', 'Ignora tendência e contexto.', { cycle: 300 }],
  ['mhi-2-four-candle-minority', 'MHI 2 — Minoria de quatro velas', 'Candles', 'mhi2FourCandleMinority', 'M1', 4, 'Bloco fixo de 5 minutos UTC; quatro primeiras velas como referência.', '3 CALL + 1 PUT → PUT; 3 PUT + 1 CALL → CALL.', 'Abertura da 5ª vela do bloco.', 'Doji, falha de dados, bloco incompleto ou empate 2×2.', 'Regra matemática explícita.', 'Variante proposta; reduz a frequência.', { cycle: 300 }],
  ['mhi-3-moving-minority', 'MHI 3 — Minoria em janela móvel', 'Candles', 'mhi3MovingMinority', 'M1', 3, 'Janela móvel das três últimas velas M1 fechadas.', 'Distribuição 2×1; sinal na direção contrária à maioria.', 'Abertura da vela após a confirmação.', 'Doji ou candle/dado inválido.', 'Não depende de bloco fixo.', 'Pode produzir sinais correlacionados.', {}],
  ['mhi-majority-5m', 'MHI Maioria — Continuidade em bloco de 5 minutos', 'Candles', 'mhiMajority5m', 'M1', 3, 'Bloco fixo de 5 minutos UTC; referências nas posições 1–3.', '2 CALL + 1 PUT → CALL; 2 PUT + 1 CALL → PUT.', 'Abertura da 4ª vela do bloco.', 'Doji, empate, falha de dados ou bloco incompleto.', 'Comparação direta com MHI 1.', 'Maioria passada não garante continuidade.', { cycle: 300 }],
  ['torres-gemeas', 'Torres Gêmeas — Duas velas direcionais', 'Candles', 'twinTowers', 'M1', 2, 'Duas velas consecutivas com corpos ≥50% da amplitude.', 'Duas direções iguais e corpos dentro do limite → mesma direção.', 'Abertura da 3ª vela.', 'Doji, lacuna ou corpo abaixo de 50%.', 'Critérios mensuráveis.', 'Nome tem variantes tradicionais diferentes.', { bodyMin: 0.5 }],
  ['five-flip', 'Five Flip — Inversão após cinco velas', 'Candles', 'fiveFlip', 'M1', 5, 'Cinco velas consecutivas da janela móvel.', 'Cinco CALL → PUT; cinco PUT → CALL.', 'Abertura da 6ª vela.', 'Doji, lacuna ou sequência quebrada.', 'Regra simples de reversão.', 'Sequência pode continuar.', {}],
  ['seven-flip', 'Seven Flip — Inversão após sete velas', 'Candles', 'sevenFlip', 'M1', 7, 'Sete velas consecutivas da janela móvel.', 'Sete CALL → PUT; sete PUT → CALL.', 'Abertura da 8ª vela.', 'Doji, lacuna ou sequência quebrada.', 'Identifica movimentos prolongados.', 'Padrão potencialmente raro.', {}],
  ['tres-vizinhos', 'Três Vizinhos — Continuidade de três velas', 'Candles', 'threeNeighbors', 'M1', 3, 'Três velas consecutivas da janela móvel.', 'Três CALL → CALL; três PUT → PUT.', 'Abertura da 4ª vela.', 'Doji, lacuna ou vela contrária.', 'Fácil de auditar.', 'Pode entrar após movimento estendido.', {}],
  ['milhao-six-majority', 'Milhão — Maioria em janela de seis velas', 'Candles', 'millionSixMajority', 'M1', 6, 'Seis velas por bloco UTC de 6 minutos.', 'Quatro ou mais da mesma direção determinam o sinal.', 'Abertura da 7ª vela.', 'Doji, empate, lacuna ou janela incompleta.', 'Considera mais observações.', 'Janela pode misturar regimes.', { cycle: 360 }],
  ['triplicacao', 'Triplicação — Três velas na mesma direção', 'Candles', 'triplication', 'M1', 3, 'Três velas consecutivas da janela móvel.', 'Três CALL → CALL; três PUT → PUT.', 'Abertura da 4ª vela.', 'Doji, lacuna ou quebra da sequência.', 'Automatização simples.', 'Pode confundir continuidade e exaustão.', {}],
  ['nao-triplicacao', 'Não Triplicação — Reversão após duas velas', 'Candles', 'noTriplication', 'M1', 2, 'Duas velas consecutivas da janela móvel.', 'Duas CALL → PUT; duas PUT → CALL.', 'Abertura da 3ª vela.', 'Doji, lacuna ou quebra da sequência.', 'Contraponto à continuidade.', 'A terceira vela pode continuar a sequência.', {}],
  ['intercalacao', 'Intercalação — Alternância de quatro velas', 'Candles', 'intercalation', 'M1', 4, 'Janela móvel de quatro direções alternadas.', 'CALL/PUT/CALL/PUT ou PUT/CALL/PUT/CALL → direção da 4ª.', 'Abertura da 5ª vela.', 'Doji, lacuna ou quebra da alternância.', 'Padrão visual claro.', 'Alternância não implica continuação.', {}],
  ['r7', 'R7 — Maioria em sete velas', 'Padrões específicos', 'r7Majority', 'M1', 7, 'Janela móvel de sete candles.', 'Pelo menos 5 CALL → CALL; pelo menos 5 PUT → PUT.', 'Abertura da próxima vela.', 'Doji, falta de maioria mínima ou dados ausentes.', 'Janela maior reduz peso de uma vela.', 'Variante proposta; confirmar equivalência tradicional.', { minimumMajority: 5 }],
  ['padrao-23', 'Padrão 23 — Segunda e terceira velas iguais', 'Padrões específicos', 'pattern23', 'M1', 2, 'Bloco fixo de 5 minutos; posições 2 e 3.', 'Se as posições 2 e 3 apontarem à mesma direção, seguir essa direção.', 'Abertura da 4ª vela, após confirmação no fechamento da 3ª.', 'Doji, direções diferentes ou bloco desalinhado.', 'Regra compacta e explícita.', 'Poucas referências; variante proposta.', { cycle: 300 }],
  ['padrao-3x1', 'Padrão 3×1 — Retomada após correção', 'Padrões específicos', 'pattern3x1', 'M1', 4, 'Três velas consecutivas e uma vela de correção.', 'Três iguais seguidas de uma contrária → direção das três primeiras.', 'Abertura da 5ª vela.', 'Doji ou ausência de correção contrária.', 'Compara sequência e correção.', 'A correção não garante retomada.', {}],
  ['padrao-impar', 'Padrão Ímpar — Maioria nas posições ímpares', 'Padrões específicos', 'oddPattern', 'M1', 3, 'Posições 1, 3 e 5 de uma janela de cinco velas.', 'Maioria das três posições determina direção.', 'Abertura da 6ª vela.', 'Doji nas posições avaliadas, dados ausentes ou empate.', 'Investiga distribuição ordinal.', 'Ignora posições pares e amplitudes.', {}],
  ['quinto-elemento', 'Quinto Elemento — Confirmação da maioria', 'Padrões específicos', 'fifthElement', 'M1', 5, 'As quatro primeiras velas formam maioria; quinta confirma.', 'Maioria entre quatro e quinta vela iguais → continuidade.', 'Abertura da 6ª vela.', 'Doji, empate nas quatro ou confirmação divergente.', 'Adiciona confirmação.', 'Menos sinais e pode perder movimentos rápidos.', {}],
  ['tres-mosqueteiros', 'Três Mosqueteiros — Progressão de três velas', 'Padrões específicos', 'threeMusketeers', 'M1', 3, 'Três velas iguais, fechamentos progressivos e corpo entre 40–80% do range.', 'CALL com closes crescentes; PUT com closes decrescentes.', 'Abertura da 4ª vela.', 'Doji, corpo fora do intervalo ou falta de progressão.', 'Combina direção e progressão.', 'Pode selecionar movimento já estendido.', { bodyMin: 0.4, bodyMax: 0.8 }],
  ['twin-candle', 'Twin Candle — Corpos semelhantes e direções opostas', 'Padrões específicos', 'twinCandle', 'M1', 2, 'Duas velas consecutivas opostas; diferença entre corpos ≤10%.', 'Seguir a direção da segunda vela.', 'Abertura da 3ª vela.', 'Doji, lacuna ou diferença de corpos >10%.', 'Critério de semelhança explícito.', 'Semelhança não garante direção futura.', { bodyTolerance: 0.1 }],
  ['mirror', 'Mirror — Repetição espelhada', 'Padrões específicos', 'mirror', 'M1', 6, 'Duas sequências consecutivas de três direções; a segunda é a primeira invertida.', 'Seguir a última direção da segunda sequência.', 'Abertura da 7ª vela.', 'Doji, lacuna ou vetores sem simetria.', 'Compara sequências explicitamente.', 'Ocorrências podem ser poucas.', {}],
  ['wolf', 'Wolf — Progressão de máximas e mínimas', 'Padrões específicos', 'wolf', 'M1', 3, 'Máximas e mínimas estritamente crescentes ou decrescentes.', 'Estrutura crescente → CALL; decrescente → PUT.', 'Abertura da 4ª vela.', 'Doji, igualdade ou estrutura mista.', 'Usa OHLC além das cores.', 'Sensível à precisão do ativo.', {}],
  ['garra', 'Garra — Padrão externo–contrário–externo', 'Padrões específicos', 'claw', 'M1', 3, 'Duas velas externas iguais envolvendo uma vela central oposta.', 'Seguir direção das velas externas.', 'Abertura da 4ª vela.', 'Doji, lacuna ou ausência da estrutura.', 'Padrão visual curto.', 'Três candles podem não representar rejeição.', {}],
  ['tres-irmaos', 'Três Irmãos — Progressão com corpos válidos', 'Padrões específicos', 'threeBrothers', 'M1', 3, 'Três velas iguais, corpos entre 40–80% do range e fechamentos progressivos.', 'CALL com closes crescentes; PUT com closes decrescentes.', 'Abertura da 4ª vela.', 'Doji, corpo fora do intervalo ou falta de progressão.', 'Filtra candles pequenos e sem progressão.', 'Limites são parâmetros da variante proposta.', { bodyMin: 0.4, bodyMax: 0.8 }],
  ['tres-pares', 'Três Pares — Três pares na mesma direção', 'Padrões específicos', 'threePairs', 'M1', 6, 'Três pares consecutivos; cada par e os três pares apontam à mesma direção.', 'Seis CALL → CALL; seis PUT → PUT.', 'Abertura da 7ª vela.', 'Doji ou qualquer par divergente.', 'Verifica persistência em pares.', 'Baixa frequência e janela específica.', {}],
  ['engolfo-alta', 'Engolfo de alta', 'Price Action', 'bullishEngulfing', 'M5', 2, 'Candle de baixa seguido de alta cujo corpo envolve o corpo anterior.', 'CALL quando open atual ≤ close anterior e close atual ≥ open anterior.', 'Abertura do candle seguinte.', 'Corpo não envolve o anterior ou há doji.', 'Padrão objetivo.', 'Pode ocorrer sem contexto técnico.', {}],
  ['engolfo-baixa', 'Engolfo de baixa', 'Price Action', 'bearishEngulfing', 'M5', 2, 'Candle de alta seguido de baixa cujo corpo envolve o corpo anterior.', 'PUT quando open atual ≥ close anterior e close atual ≤ open anterior.', 'Abertura do candle seguinte.', 'Corpo não envolve o anterior ou há doji.', 'Padrão objetivo.', 'Pode ocorrer sem contexto técnico.', {}],
  ['martelo-suporte', 'Martelo em suporte', 'Price Action', 'hammerSupport', 'M5', 21, 'Mínima das 20 velas anteriores como suporte; tolerância 0,1%; wick inferior ≥2× corpo, superior ≤ corpo; fecha na metade superior.', 'CALL após toque/rejeição do suporte.', 'Abertura do candle seguinte.', 'Sem suporte próximo, wick insuficiente, doji ou histórico curto.', 'Combina candle e nível.', 'Suporte por janela é aproximação.', { lookback: 20, tolerance: 0.001 }],
  ['estrela-cadente-resistencia', 'Estrela cadente em resistência', 'Price Action', 'shootingStarResistance', 'M5', 21, 'Máxima das 20 velas anteriores; tolerância 0,1%; wick superior ≥2× corpo, inferior ≤ corpo; fecha na metade inferior.', 'PUT após toque/rejeição da resistência.', 'Abertura do candle seguinte.', 'Sem resistência próxima, wick insuficiente, doji ou histórico curto.', 'Simétrica ao martelo.', 'Pode detectar pavios aleatórios.', { lookback: 20, tolerance: 0.001 }],
  ['pullback-tendencia', 'Pullback de tendência', 'Price Action', 'trendPullback', 'M5', 4, 'EMA 9/21; tendência e inclinação de 3 velas, correção toca EMA9 sem fechar além EMA21 e candle retoma.', 'Seguir tendência após confirmação.', 'Abertura do candle seguinte.', 'Tendência rompida, doji, ausência de toque ou histórico curto.', 'Opera a favor da tendência.', 'Médias são atrasadas.', { fastPeriod: 9, slowPeriod: 21, slopeBars: 3 }],
  ['rompimento-resistencia', 'Rompimento de resistência', 'Price Action', 'resistanceBreakout', 'M5', 21, 'Fechamento supera a maior máxima das 20 velas anteriores por pelo menos um tick.', 'CALL após fechamento de rompimento.', 'Abertura do candle seguinte.', 'Sem tick-size por ativo ou fechamento não supera o nível.', 'Condição reproduzível.', 'Rompimentos falsos; requer tick-size.', { lookback: 20 }],
  ['rompimento-suporte', 'Rompimento de suporte', 'Price Action', 'supportBreakout', 'M5', 21, 'Fechamento fica abaixo da menor mínima das 20 velas anteriores por pelo menos um tick.', 'PUT após fechamento de rompimento.', 'Abertura do candle seguinte.', 'Sem tick-size por ativo ou fechamento não supera o nível.', 'Simétrico à resistência.', 'Rompimentos falsos; requer tick-size.', { lookback: 20 }],
  ['breakout-reteste', 'Breakout com reteste', 'Price Action', 'breakoutRetest', 'M5', 26, 'Rompimento válido seguido de reteste/rejeição dentro das cinco velas seguintes; tolerância 0,1%.', 'Seguir direção do rompimento após rejeição.', 'Abertura da vela posterior ao reteste.', 'Tick-size ausente, close atravessa nível ou reteste não ocorre em 5 velas.', 'Exige confirmação após rompimento.', 'Menos sinais; requer tick-size.', { lookback: 20, retestBars: 5, tolerance: 0.001 }],
  ['rejeicao-suporte', 'Rejeição de suporte', 'Price Action', 'supportRejection', 'M5', 21, 'Mínima das 20 velas anteriores; toque na zona 0,1%, wick inferior ≥2× corpo e fechamento acima do suporte.', 'CALL após rejeição.', 'Abertura do candle seguinte.', 'Fecha abaixo do suporte, wick insuficiente, doji ou histórico curto.', 'Combina reação e nível.', 'Pode anteceder rompimento.', { lookback: 20, tolerance: 0.001 }],
  ['rejeicao-resistencia', 'Rejeição de resistência', 'Price Action', 'resistanceRejection', 'M5', 21, 'Máxima das 20 velas anteriores; toque na zona 0,1%, wick superior ≥2× corpo e fechamento abaixo da resistência.', 'PUT após rejeição.', 'Abertura do candle seguinte.', 'Fecha acima da resistência, wick insuficiente, doji ou histórico curto.', 'Região técnica definida.', 'Resistência pode romper.', { lookback: 20, tolerance: 0.001 }],
];

const examples = {
  'mhi-1-minority-5m': [['CALL', 'CALL', 'PUT'], 'PUT'],
  'mhi-2-four-candle-minority': [['CALL', 'CALL', 'PUT', 'CALL'], 'PUT'],
  'mhi-3-moving-minority': [['PUT', 'PUT', 'CALL'], 'CALL'],
  'mhi-majority-5m': [['PUT', 'CALL', 'PUT'], 'PUT'],
  'torres-gemeas': [['CALL', 'CALL'], 'CALL'],
  'five-flip': [['CALL', 'CALL', 'CALL', 'CALL', 'CALL'], 'PUT'],
  'seven-flip': [['PUT', 'PUT', 'PUT', 'PUT', 'PUT', 'PUT', 'PUT'], 'CALL'],
  'tres-vizinhos': [['CALL', 'CALL', 'CALL'], 'CALL'],
  'milhao-six-majority': [['CALL', 'CALL', 'CALL', 'CALL', 'PUT', 'PUT'], 'CALL'],
  triplicacao: [['PUT', 'PUT', 'PUT'], 'PUT'],
  'nao-triplicacao': [['CALL', 'CALL'], 'PUT'],
  intercalacao: [['CALL', 'PUT', 'CALL', 'PUT'], 'PUT'],
  r7: [['CALL', 'CALL', 'PUT', 'CALL', 'CALL', 'PUT', 'CALL'], 'CALL'],
  'padrao-23': [['CALL', 'PUT', 'PUT'], 'PUT'],
  'padrao-3x1': [['CALL', 'CALL', 'CALL', 'PUT'], 'CALL'],
  'padrao-impar': [['PUT', 'CALL', 'PUT'], 'PUT'],
  'quinto-elemento': [['CALL', 'CALL', 'PUT', 'CALL', 'CALL'], 'CALL'],
  'tres-mosqueteiros': [['CALL', 'CALL', 'CALL'], 'CALL'],
  'twin-candle': [['CALL', 'PUT'], 'PUT'],
  mirror: [['CALL', 'PUT', 'CALL', 'CALL', 'PUT', 'CALL'], 'CALL'],
  wolf: [['CALL', 'CALL', 'CALL'], 'CALL'],
  garra: [['CALL', 'PUT', 'CALL'], 'CALL'],
  'tres-irmaos': [['CALL', 'CALL', 'CALL'], 'CALL'],
  'tres-pares': [['CALL', 'CALL', 'CALL', 'CALL', 'CALL', 'CALL'], 'CALL'],
  'engolfo-alta': ['baixa, depois corpo de alta engolfando o anterior', 'CALL'],
  'engolfo-baixa': ['alta, depois corpo de baixa engolfando o anterior', 'PUT'],
  'martelo-suporte': ['hammer válido junto à mínima das 20 velas anteriores', 'CALL'],
  'estrela-cadente-resistencia': ['shooting star válida junto à máxima das 20 velas anteriores', 'PUT'],
  'pullback-tendencia': ['EMA9 > EMA21, correção toca EMA9, candle retoma em alta', 'CALL'],
  'rompimento-resistencia': ['close > máxima anterior + 1 tick', 'CALL'],
  'rompimento-suporte': ['close < mínima anterior - 1 tick', 'PUT'],
  'breakout-reteste': ['rompimento confirmado seguido de reteste e close de rejeição', 'CALL/PUT'],
  'rejeicao-suporte': ['toque do suporte com wick inferior e close acima', 'CALL'],
  'rejeicao-resistencia': ['toque da resistência com wick superior e close abaixo', 'PUT'],
};

const tickRequired = new Set(['rompimento-resistencia', 'rompimento-suporte', 'breakout-reteste']);
const supportedEvaluators = new Set(definitions.map((definition) => definition[3]));

export const STRATEGIES = definitions.map(([id, name, category, evaluator, timeframe, referenceCandles, cycle, condition, entry, cancellation, pros, cons, params = {}]) => {
  const [validSequence, expectedDirection] = examples[id];
  const isTickPending = tickRequired.has(id);
  const invalidSequence = Array.isArray(validSequence)
    ? validSequence.map((direction, index) => index === validSequence.length - 1 ? 'DOJI' : direction)
    : `Vela de sinal doji em: ${validSequence}`;
  return {
    id,
    name,
    variant: id === 'mhi-1-minority-5m'
      ? 'minority_block_5m'
      : name.includes(' — ') ? name.split(' — ').slice(1).join(' — ') : 'Variante operacional definida no PROMPT.txt',
    category,
    evaluator,
    description: condition,
    ruleSummary: condition,
    timeframe,
    expiration: 1,
    rulesetVersion: 3,
    status: isTickPending ? STATUS.VALIDATION_PENDING : STATUS.IMPLEMENTED,
    backtest_enabled: !isTickPending,
    notes: isTickPending
      ? 'A regra está implementada, mas depende do tick-size confiável do ativo para validação e liberação no scanner.'
      : 'Variante operacional do catálogo RW TIPS; não implica equivalência universal a versões externas com o mesmo nome.',
    validation: {
      approved: !isTickPending,
      testFile: 'src/lib/backtestEngine.test.js',
    },
    rules: {
      timeframe,
      referenceCandles,
      cycle,
      condition,
      direction: condition,
      entry,
      expiration: 'Fechamento da vela de expiração seguinte à entrada (1 candle).',
      signalValidation: 'Usar apenas candles fechados, cronologicamente contínuos e válidos; a entrada só pode ocorrer na vela posterior à confirmação.',
      cancellation,
      dojiAndTie: 'Doji em referência que exija classificação de direção cancela o sinal; empates sem direção única não geram sinal.',
      validExample: { sequence: validSequence, expected: expectedDirection },
      invalidExample: { sequence: invalidSequence, expected: 'Sem sinal: DOJI_SIGNAL_CANDLE.' },
      pricePrecision: 'Classificar doji pela precisão do ativo quando disponível; não inventar tick-size ausente.',
      pros: [pros],
      cons: [cons],
      complexity: category === 'Price Action' ? 'Média' : 'Baixa',
      source: {
        type: 'PROMPT.txt',
        details: `Catálogo operacional RW TIPS; estratégia ${name}.`,
        note: 'Variantes propostas são regras específicas do aplicativo e não afirmações sobre definições universais.',
      },
      params,
    },
  };
});

export function hasOperationalRule(strategy) {
  const rule = strategy?.rules;
  return Boolean(
    strategy &&
    typeof strategy.id === 'string' &&
    typeof strategy.name === 'string' &&
    typeof strategy.category === 'string' &&
    typeof strategy.description === 'string' &&
    supportedEvaluators.has(strategy.evaluator) &&
    typeof strategy.rulesetVersion === 'number' &&
    rule &&
    typeof rule.timeframe === 'string' &&
    Number.isInteger(rule.referenceCandles) &&
    rule.referenceCandles > 0 &&
    rule.cycle &&
    typeof rule.condition === 'string' &&
    typeof rule.direction === 'string' &&
    typeof rule.entry === 'string' &&
    typeof rule.expiration === 'string' &&
    typeof rule.signalValidation === 'string' &&
    typeof rule.cancellation === 'string' &&
    typeof rule.dojiAndTie === 'string' &&
    rule.validExample &&
    rule.invalidExample &&
    Array.isArray(rule.pros) &&
    rule.pros.length > 0 &&
    Array.isArray(rule.cons) &&
    rule.cons.length > 0 &&
    typeof rule.complexity === 'string' &&
    rule.source
  );
}

export function isStrategyBacktestEnabled(strategy) {
  return strategy?.status === STATUS.IMPLEMENTED &&
    strategy.backtest_enabled === true &&
    strategy.validation?.approved === true &&
    typeof strategy.validation.testFile === 'string' &&
    hasOperationalRule(strategy);
}

export const IMPLEMENTED_STRATEGIES = STRATEGIES.filter(isStrategyBacktestEnabled);
export const getStrategy = (id) => STRATEGIES.find((strategy) => strategy.id === id);
export { STATUS };

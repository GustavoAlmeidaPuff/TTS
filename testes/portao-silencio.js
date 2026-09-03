// O modo timbre falava sozinho.
//
// Com a pessoa calada, o app ficava murmurando: o gerador do RVC e um vocoder e
// nunca devolve silencio -- alimentado so com ruido de sala, ele INVENTA voz.
// Num jogo isso aparece como "eu nao falei nada e saiu um som".
//
// O portao de silencio (electron/voz/rvc/streaming.js) mede o bloco antes de
// converter. Este teste prova as quatro coisas que ele tem que fazer, e a que
// ele nao pode fazer de jeito nenhum: cortar a voz de quem esta falando.
//
// O conversor daqui e de mentira e sempre devolve um tom de amplitude cheia,
// exatamente como o de verdade faz com silencio na entrada. Assim, todo trecho
// que sai baixo na saida saiu baixo PORQUE o portao fechou -- e nao por acaso.
//
//   node testes/portao-silencio.js
const { Streaming, TAXA_ENTRADA } = require('../electron/voz/rvc/streaming');

const BLOCO_S = 0.75;
const ESCALA = 2; // conversor de mentira: 32 kHz de saida pra 16 kHz de entrada
const TAXA_SAIDA = TAXA_ENTRADA * ESCALA;

/** Conversor de mentira: ignora a entrada e cospe voz alta, sempre. */
const conversorFalso = {
  chamadas: 0,
  async converter(janela) {
    this.chamadas++;
    const n = janela.length * ESCALA;
    const audio = new Float32Array(n);
    for (let i = 0; i < n; i++) audio[i] = 0.3 * Math.sin((2 * Math.PI * 200 * i) / TAXA_SAIDA);
    return { audio, taxa: TAXA_SAIDA, tom: { seu: 120, alvo: 220, semitons: 10 } };
  },
};

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const amostras = (s) => Math.round(TAXA_ENTRADA * s);

function tom(n, amplitude, hz = 130) {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / TAXA_ENTRADA);
  return a;
}

function juntar(...partes) {
  const total = partes.reduce((s, p) => s + p.length, 0);
  const fora = new Float32Array(total);
  let em = 0;
  for (const p of partes) { fora.set(p, em); em += p.length; }
  return fora;
}

/** Nivel de um trecho da saida, em RMS. */
function nivel(audio, de = 0, ate = audio.length) {
  let soma = 0;
  const a = Math.max(0, de);
  const b = Math.min(audio.length, ate);
  for (let i = a; i < b; i++) soma += audio[i] * audio[i];
  return Math.sqrt(soma / Math.max(1, b - a));
}

/** Roda um trecho de entrada pelo streaming e devolve o que ele emitiu. */
async function rodar(entrada) {
  conversorFalso.chamadas = 0;
  const fluxo = new Streaming(conversorFalso, { blocoS: BLOCO_S, contextoS: 0.35 });
  const eventos = [];
  fluxo.on('audio', (d) => eventos.push(d));
  fluxo.on('erro', (e) => eventos.push({ erro: e.message }));

  // Em pedacos de 100ms, como o worklet entrega.
  const passo = amostras(0.1);
  for (let i = 0; i < entrada.length; i += passo) {
    fluxo.alimentar(entrada.subarray(i, Math.min(i + passo, entrada.length)));
    await esperar(2);
  }
  await esperar(60);

  return {
    eventos,
    conversoes: conversorFalso.chamadas,
    calados: eventos.filter((e) => e.silencio).length,
    comAudio: eventos.filter((e) => e.audio && e.audio.length),
  };
}

// ---------------------------------------------------------------------- casos

const casos = [];
const anotar = (nome, ok, detalhe) => casos.push({ nome, ok, detalhe });

(async () => {
  // 1. Silencio de verdade: nem chega perto da GPU.
  {
    const r = await rodar(new Float32Array(amostras(3)));
    anotar(
      'silencio nao vira som',
      r.conversoes === 0 && r.comAudio.length === 0 && r.calados >= 2,
      `${r.conversoes} conversoes, ${r.comAudio.length} blocos de audio, ${r.calados} calados`
    );
  }

  // 2. Ruido de sala (ventilador, fone chiando): tambem nao.
  {
    const chiado = new Float32Array(amostras(3));
    for (let i = 0; i < chiado.length; i++) chiado[i] = (Math.random() * 2 - 1) * 0.004;
    const r = await rodar(chiado);
    anotar(
      'ruido de fundo nao vira som',
      r.conversoes === 0 && r.comAudio.length === 0,
      `${r.conversoes} conversoes, nivel do chiado ~0.0023 RMS`
    );
  }

  // 3. Fala de verdade passa inteira -- este e o caso que NAO pode quebrar.
  {
    const r = await rodar(tom(amostras(3), 0.12));
    const todoAlto = r.comAudio.every((e) => nivel(e.audio) > 0.15);
    anotar(
      'fala continua passa inteira',
      r.comAudio.length >= 3 && r.calados === 0 && todoAlto,
      `${r.comAudio.length} blocos de audio, ${r.calados} calados, todos altos: ${todoAlto}`
    );
  }

  // 4. Pausa curta no meio da frase (150ms) NAO pode ser cortada: e assim que
  //    se fala. A folga de 200ms de cada lado existe pra isso.
  {
    const r = await rodar(juntar(
      tom(amostras(0.4), 0.12),
      new Float32Array(amostras(0.15)),
      tom(amostras(0.4), 0.12)
    ));
    const bloco = r.comAudio[0];
    // A pausa cai em 0,4s-0,55s da entrada, ou seja 0,8s-1,1s da saida.
    const naPausa = bloco ? nivel(bloco.audio, 0.4 * TAXA_SAIDA, 0.55 * TAXA_SAIDA) : 0;
    anotar(
      'pausa curta no meio da fala nao e cortada',
      Boolean(bloco) && naPausa > 0.15,
      `nivel na pausa: ${naPausa.toFixed(3)} (a saida cheia e 0.212)`
    );
  }

  // 5. Bloco misto: 0,7s calado e so depois a voz. O comeco tem que sair mudo,
  //    o fim tem que sair. Antes, esses 0,7s viravam murmuro a cada bloco.
  {
    const r = await rodar(juntar(
      new Float32Array(amostras(0.7)),
      tom(amostras(0.3), 0.12)
    ));
    const bloco = r.comAudio[0];
    const comeco = bloco ? nivel(bloco.audio, 0, 0.4 * TAXA_SAIDA) : 1;
    const fim = bloco ? nivel(bloco.audio, 0.72 * TAXA_SAIDA, 0.75 * TAXA_SAIDA) : 0;
    anotar(
      'no bloco misto, so o trecho calado sai mudo',
      Boolean(bloco) && comeco < 0.02 && fim > 0.15,
      `comeco (calado): ${comeco.toFixed(3)}   fim (voz): ${fim.toFixed(3)}`
    );
  }

  // 6. Sala barulhenta: o corte sobe junto com o ruido, mas a fala continua
  //    passando. Se o piso aprendesse durante a fala, ele subiria ate a altura
  //    da voz e o portao fecharia na cara de quem esta falando.
  {
    const chiado = new Float32Array(amostras(2));
    for (let i = 0; i < chiado.length; i++) chiado[i] = (Math.random() * 2 - 1) * 0.008;
    const r = await rodar(juntar(chiado, tom(amostras(3), 0.12)));
    const ultimo = r.comAudio[r.comAudio.length - 1];
    anotar(
      'depois de aprender o ruido, a fala ainda passa',
      r.comAudio.length >= 3 && Boolean(ultimo) && nivel(ultimo.audio) > 0.15,
      `${r.calados} blocos calados (o chiado) e ${r.comAudio.length} com voz; ` +
        `corte aprendido: ${ultimo ? ultimo.limiar.toFixed(4) : '?'}`
    );
  }

  // 7. O evento de silencio precisa dizer o que mediu -- e o que a tela mostra
  //    no placar, e e por ali que se descobre um portao mal calibrado.
  {
    const r = await rodar(new Float32Array(amostras(2)));
    const e = r.eventos.find((x) => x.silencio);
    anotar(
      'o bloco calado se explica pra tela',
      Boolean(e) && e.audio === null && typeof e.nivel === 'number' && e.limiar >= 0.01,
      e ? `nivel ${e.nivel.toFixed(4)}, corte ${e.limiar.toFixed(4)}` : 'nenhum evento de silencio'
    );
  }

  // ------------------------------------------------------------------ balanco

  console.log('=== PORTAO DE SILENCIO ===\n');
  let falhas = 0;
  for (const c of casos) {
    if (!c.ok) falhas++;
    console.log(`${c.ok ? 'ok    ' : 'FALHOU'} ${c.nome}\n         ${c.detalhe}`);
  }
  console.log(
    '\n' + (falhas ? `${falhas} de ${casos.length} FALHARAM` : `todos os ${casos.length} casos passaram`)
  );
  process.exit(falhas ? 1 : 0);
})().catch((e) => {
  console.error('FALHOU:', e.stack);
  process.exit(1);
});

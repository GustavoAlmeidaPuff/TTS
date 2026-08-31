// Circuito fechado: o Piper fala ingles, o reconhecedor escuta, e a gente mede
// QUANDO cada trecho foi liberado em relacao ao audio ja consumido -- que e o
// atraso que voce sente, nao o tempo de CPU.
//
//   node _t/teste-reconhecedor.js [en-20M|en-preciso] [janelaMs] [margem]
const path = require('path');
const piper = require('../electron/tts/piper');
const modelos = require('../electron/voz/modelos');
const { Reconhecedor } = require('../electron/voz/reconhecedor');

const RAIZ = path.join(process.env.APPDATA, 'voz-tts', 'motores');
modelos.definirRaiz(RAIZ);
piper.definirRaiz(RAIZ);

const MODELO = process.argv[2] || 'en-20M';
const JANELA = Number(process.argv[3] || 400);
const MARGEM = Number(process.argv[4] || 2);
const AQUECE = Number(process.argv[5] || 0.2);
const LINGUA = process.argv[6] || 'en';

const FRASES = {
  en: { voz: 'en_US-amy-medium', texto: 'Hello everyone, welcome back to the stream. Today we are going to try something completely different.' },
  pt: { voz: 'pt_BR-faber-medium', texto: 'Olá pessoal, sejam bem-vindos de volta. Hoje nós vamos tentar uma coisa completamente diferente.' },
};
const FRASE = FRASES[LINGUA].texto;

const PEDACO_MS = 100;

/** Le um WAV PCM 16 bits sem depender de biblioteca. */
function lerWav(wav) {
  const taxa = wav.readUInt32LE(24);
  const bits = wav.readUInt16LE(34);
  if (bits !== 16) throw new Error('esperava WAV de 16 bits, veio ' + bits);
  let pos = 12;
  while (pos < wav.length && wav.toString('ascii', pos, pos + 4) !== 'data') {
    pos += 8 + wav.readUInt32LE(pos + 4);
  }
  const inicio = pos + 8;
  const n = (wav.length - inicio) >> 1;
  const amostras = new Float32Array(n);
  for (let i = 0; i < n; i++) amostras[i] = wav.readInt16LE(inicio + i * 2) / 32768;
  return { amostras, taxa };
}

/** Taxa de erro de palavra: (trocas + faltas + sobras) / palavras do original. */
function wer(referencia, hipotese) {
  const r = referencia, h = hipotese;
  const d = Array.from({ length: r.length + 1 }, (_, i) =>
    Array.from({ length: h.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= r.length; i++) {
    for (let j = 1; j <= h.length; j++) {
      d[i][j] = r[i - 1] === h[j - 1]
        ? d[i - 1][j - 1]
        : 1 + Math.min(d[i - 1][j - 1], d[i][j - 1], d[i - 1][j]);
    }
  }
  return d[r.length][h.length] / r.length;
}

const limpa = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);

(async () => {
  console.log('modelo: ' + MODELO + '  |  janela ' + JANELA + 'ms  |  margem ' + MARGEM + ' palavras');
  console.log('frase original:\n  "' + FRASE + '"\n');

  // O Piper sintetiza com um pouco de ruido aleatorio, entao cada chamada gera
  // um audio ligeiramente diferente. Comparar configuracoes sobre audios
  // diferentes nao mede nada -- entao a amostra e gerada UMA vez e reusada.
  const fs = require('fs');
  const cache = path.join(__dirname, 'amostra-fixa-' + LINGUA + '.wav');
  if (!fs.existsSync(cache)) {
    fs.writeFileSync(cache, await piper.sintetizar({ texto: FRASE, voz: FRASES[LINGUA].voz }));
    console.log('(amostra de referencia gerada e congelada em ' + path.basename(cache) + ')');
  }
  const { amostras: orig, taxa } = lerWav(fs.readFileSync(cache));
  console.log('audio: ' + (orig.length / taxa).toFixed(1) + 's a ' + taxa + ' Hz\n');

  const sherpa = require('sherpa-onnx-node');
  const amostras = new sherpa.LinearResampler(taxa, 16000).resample(orig);

  const arquivos = modelos.localizarArquivos(MODELO);
  if (!arquivos) throw new Error('modelo ' + MODELO + ' nao esta baixado');

  const t0 = Date.now();
  const rec = new Reconhecedor(arquivos, { janelaEstavelMs: JANELA, margemFinal: MARGEM, minPalavras: 2, aquecimentoS: AQUECE });
  console.log('carregou em ' + (Date.now() - t0) + 'ms\n');

  const trechos = [];
  const atrasos = [];
  let audioMs = 0;
  let palavrasFaladas = 0;

  rec.on('trecho', ({ texto, fim }) => {
    trechos.push(texto);
    // Estimativa do atraso: onde essas palavras estavam no audio, contra quando
    // sairam. Usa a duracao total dividida pelo total de palavras.
    palavrasFaladas += texto.split(/\s+/).length;
    const posicaoEsperadaMs = (palavrasFaladas / limpa(FRASE).length) * (orig.length / taxa) * 1000;
    const atraso = audioMs - posicaoEsperadaMs;
    atrasos.push(atraso);
    console.log(
      '  [' + String(audioMs).padStart(5) + 'ms]  atraso ~' + String(Math.round(atraso)).padStart(5) +
      'ms  -> "' + texto + '"' + (fim ? '  (fim)' : '')
    );
  });

  const porPedaco = Math.round((16000 * PEDACO_MS) / 1000);
  const inicio = Date.now();
  for (let i = 0; i < amostras.length; i += porPedaco) {
    rec.alimentar(amostras.subarray(i, Math.min(i + porPedaco, amostras.length)));
    audioMs += PEDACO_MS;
    const jaPassou = Date.now() - inicio;
    if (audioMs > jaPassou) await new Promise((r) => setTimeout(r, audioMs - jaPassou));
  }
  rec.encerrarTrecho();

  const reconhecido = trechos.join(' ');
  console.log('\nreconhecido:\n  "' + reconhecido + '"');

  const taxaErro = wer(limpa(FRASE), limpa(reconhecido));

  // O WER pune "every one" no lugar de "everyone" como dois erros -- mas faladas
  // por um TTS as duas soam IGUAIS. Pro nosso caso, o que interessa e a sequencia
  // de letras sem os espacos: isso separa erro de verdade de erro de espacamento.
  const semEspaco = (s) => limpa(s).join('');
  const cer = wer(semEspaco(FRASE).split(''), semEspaco(reconhecido).split(''));

  const medio = atrasos.reduce((a, b) => a + b, 0) / (atrasos.length || 1);
  console.log(
    '\nWER (grafia exata) : ' + (taxaErro * 100).toFixed(1) + '%' +
    '\nCER (som, sem espaco): ' + (cer * 100).toFixed(1) + '%   <- e este que importa pro TTS' +
    '\ntrechos: ' + trechos.length +
    '  |  atraso medio: ' + Math.round(medio) + 'ms' +
    '  |  primeiro trecho aos: ' + Math.round(atrasos[0] || 0) + 'ms de atraso'
  );
})().catch((e) => {
  console.error('FALHOU:', e.message);
  console.error(e.stack.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
});

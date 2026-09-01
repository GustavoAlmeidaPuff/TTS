// Converte uma fala de verdade e mede tudo que da pra medir sem ouvir:
// tempos, faixa de tom detectada, e se o audio saiu com nivel plausivel.
// O julgamento final (soa bem?) so o ouvido faz -- por isso salva o WAV.
require('../electron/comum/onnx'); // ordem: antes do sherpa
const path = require('path');
const fs = require('fs');
const { Conversor, TAXA_ENTRADA } = require('../electron/voz/rvc');
const piper = require('../electron/tts/piper');

const RAIZ = path.join(process.env.APPDATA, 'voz-tts', 'motores');
const DIR = path.join(RAIZ, 'rvc');
piper.definirRaiz(RAIZ);

const FRASE =
  'Hello everyone, welcome back to the stream. Today we are going to try something completely different.';

function lerWav(wav) {
  const taxa = wav.readUInt32LE(24);
  let p = 12;
  while (p < wav.length && wav.toString('ascii', p, p + 4) !== 'data') p += 8 + wav.readUInt32LE(p + 4);
  const inicio = p + 8;
  const n = (wav.length - inicio) >> 1;
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = wav.readInt16LE(inicio + i * 2) / 32768;
  return { amostras: a, taxa };
}

function escreverWav(amostras, taxa, destino) {
  const pcm = Buffer.alloc(amostras.length * 2);
  for (let i = 0; i < amostras.length; i++) {
    const v = Math.max(-1, Math.min(1, amostras[i]));
    pcm.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const c = Buffer.alloc(44);
  c.write('RIFF', 0); c.writeUInt32LE(36 + pcm.length, 4); c.write('WAVE', 8);
  c.write('fmt ', 12); c.writeUInt32LE(16, 16); c.writeUInt16LE(1, 20); c.writeUInt16LE(1, 22);
  c.writeUInt32LE(taxa, 24); c.writeUInt32LE(taxa * 2, 28);
  c.writeUInt16LE(2, 32); c.writeUInt16LE(16, 34);
  c.write('data', 36); c.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(destino, Buffer.concat([c, pcm]));
}

const estatisticas = (a) => {
  let pico = 0, soma = 0, nans = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i])) { nans++; continue; }
    const v = Math.abs(a[i]);
    if (v > pico) pico = v;
    soma += a[i] * a[i];
  }
  return { pico, rms: Math.sqrt(soma / a.length), nans };
};

(async () => {
  // 1. Fala de origem (a "sua voz" no teste).
  const cache = path.join(__dirname, 'rvc-origem.wav');
  if (!fs.existsSync(cache)) {
    fs.writeFileSync(cache, await piper.sintetizar({ texto: FRASE, voz: 'en_US-amy-medium' }));
  }
  const origem = lerWav(fs.readFileSync(cache));

  // 2. Reamostra pra 16 kHz, que e o que as tres redes exigem.
  const sherpa = require('sherpa-onnx-node');
  const entrada = origem.taxa === TAXA_ENTRADA
    ? origem.amostras
    : new sherpa.LinearResampler(origem.taxa, TAXA_ENTRADA).resample(origem.amostras);

  const est0 = estatisticas(entrada);
  console.log('ENTRADA : ' + (entrada.length / TAXA_ENTRADA).toFixed(2) + 's a ' + TAXA_ENTRADA +
    ' Hz | pico ' + est0.pico.toFixed(3) + ' | rms ' + est0.rms.toFixed(4));

  // 3. Carrega e converte.
  const conv = new Conversor({
    contentvec: path.join(DIR, 'vec-768-layer-12.onnx'),
    rmvpe: path.join(DIR, 'rmvpe.onnx'),
    gerador: path.join(DIR, 'woman_1.onnx'),
  });

  const tc = Date.now();
  await conv.carregar((p) => console.log('  ' + p.rotulo + '...'));
  console.log('carregou os tres modelos em ' + ((Date.now() - tc) / 1000).toFixed(1) + 's' +
    (conv.semGpu ? '  (ATENCAO: sem GPU, o gerador foi pra CPU)' : '  (gerador na GPU)'));

  const r = await conv.converter(entrada, { semitons: Number(process.argv[2] || 0) });

  // 4. O que da pra afirmar sem ouvir.
  const est1 = estatisticas(r.audio);
  console.log('\nSAIDA   : ' + (r.audio.length / r.taxa).toFixed(2) + 's a ' + r.taxa +
    ' Hz | pico ' + est1.pico.toFixed(3) + ' | rms ' + est1.rms.toFixed(4) +
    ' | NaNs: ' + est1.nans);

  const duracaoEntrada = entrada.length / TAXA_ENTRADA;
  const duracaoSaida = r.audio.length / r.taxa;
  console.log('duracao bateu? ' +
    (Math.abs(duracaoSaida - duracaoEntrada) < 0.15 ? 'SIM' : 'NAO (' +
      duracaoEntrada.toFixed(2) + 's -> ' + duracaoSaida.toFixed(2) + 's)'));

  console.log('\nTEMPOS para ' + r.tempos.segundosDeAudio.toFixed(1) + 's de audio:');
  console.log('  conteudo : ' + String(r.tempos.conteudo).padStart(5) + 'ms');
  console.log('  melodia  : ' + String(r.tempos.melodia).padStart(5) + 'ms');
  console.log('  gerador  : ' + String(r.tempos.gerador).padStart(5) + 'ms');
  console.log('  TOTAL    : ' + String(r.tempos.total).padStart(5) + 'ms  | fator ' +
    (r.tempos.total / (r.tempos.segundosDeAudio * 1000)).toFixed(2) + 'x');

  const destino = path.join(__dirname, 'rvc-convertido.wav');
  escreverWav(r.audio, r.taxa, destino);
  console.log('\nsalvo em ' + destino);

  await conv.liberar();
})().catch((e) => {
  console.error('FALHOU:', e.message);
  console.error(e.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});

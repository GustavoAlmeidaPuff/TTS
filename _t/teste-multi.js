// O nemotron promete 40 idiomas com deteccao automatica. Este teste verifica
// se isso vale AQUI, pelo binding do Node, sem passar idioma por fluxo.
const path = require('path');
const fs = require('fs');
const piper = require('../electron/tts/piper');

const RAIZ = path.join(process.env.APPDATA, 'voz-tts', 'motores');
piper.definirRaiz(RAIZ);

const PASTA = path.join(
  RAIZ, 'reconhecimento', 'sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-320ms-int8-2026-06-11'
);

function lerWav(wav) {
  const taxa = wav.readUInt32LE(24);
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

(async () => {
  const sherpa = require('sherpa-onnx-node');

  const t0 = Date.now();
  const rec = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: path.join(PASTA, 'encoder.int8.onnx'),
        decoder: path.join(PASTA, 'decoder.int8.onnx'),
        joiner: path.join(PASTA, 'joiner.int8.onnx'),
      },
      tokens: path.join(PASTA, 'tokens.txt'),
      numThreads: 4,
      provider: 'cpu',
      debug: 0,
    },
    decodingMethod: 'greedy_search',
    enableEndpoint: false,
  });
  console.log('modelo carregou em ' + (Date.now() - t0) + 'ms  (' +
    Math.round(fs.statSync(path.join(PASTA, 'encoder.int8.onnx')).size / 1048576) + 'MB de encoder)\n');

  /** Transcreve um Float32Array inteiro de uma vez. */
  function transcrever(amostras, taxa) {
    const dados = taxa === 16000
      ? amostras
      : new sherpa.LinearResampler(taxa, 16000).resample(amostras);
    const fluxo = rec.createStream();
    fluxo.acceptWaveform({ samples: new Float32Array(3200), sampleRate: 16000 });
    fluxo.acceptWaveform({ samples: dados, sampleRate: 16000 });
    fluxo.acceptWaveform({ samples: new Float32Array(8000), sampleRate: 16000 });
    const inicio = Date.now();
    while (rec.isReady(fluxo)) rec.decode(fluxo);
    const ms = Date.now() - inicio;
    const rtf = ms / ((dados.length / 16000) * 1000);
    return { texto: (rec.getResult(fluxo).text || '').trim(), ms, rtf };
  }

  // 1. Os audios de referencia que vieram no pacote (idiomas conhecidos).
  console.log('--- audios de referencia do proprio modelo ---');
  const pastaWavs = path.join(PASTA, 'test_wavs');
  for (const arq of fs.readdirSync(pastaWavs).slice(0, 5)) {
    const { amostras, taxa } = lerWav(fs.readFileSync(path.join(pastaWavs, arq)));
    const r = transcrever(amostras, taxa);
    console.log('  ' + arq.padEnd(8) + ' -> "' + r.texto.slice(0, 70) + '"');
  }

  // 2. O que interessa: portugues e ingles, no mesmo reconhecedor, sem trocar nada.
  console.log('\n--- os SEUS dois idiomas, sem trocar de modelo ---');
  const casos = [
    { voz: 'en_US-amy-medium', lingua: 'INGLES  ',
      texto: 'Hello everyone, welcome back to the stream. Today we are going to try something completely different.' },
    { voz: 'pt_BR-faber-medium', lingua: 'PORTUGUES',
      texto: 'Olá pessoal, sejam bem-vindos de volta. Hoje nós vamos tentar uma coisa completamente diferente.' },
  ];

  for (const caso of casos) {
    const { amostras, taxa } = lerWav(await piper.sintetizar({ texto: caso.texto, voz: caso.voz }));
    const r = transcrever(amostras, taxa);
    console.log('\n  ' + caso.lingua + '  (' + (amostras.length / taxa).toFixed(1) + 's de audio)');
    console.log('    falado     : "' + caso.texto + '"');
    console.log('    reconhecido: "' + r.texto + '"');
    console.log('    decodificou em ' + r.ms + 'ms  |  fator tempo real: ' + r.rtf.toFixed(2) +
      'x  (abaixo de 1.0 = da conta ao vivo)');
  }
})().catch((e) => {
  console.error('FALHOU:', e.message);
  console.error(e.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});

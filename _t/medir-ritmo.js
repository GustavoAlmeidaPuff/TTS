// Por que a fila cresce? A hipotese e que o audio SINTETIZADO de um trecho
// dura mais do que o trecho levou pra ser FALADO. Se a razao passa de 1.0, o
// atraso cresce sem limite e nenhuma fila resolve.
const path = require('path');
const piper = require('../electron/tts/piper');

piper.definirRaiz(path.join(process.env.APPDATA, 'voz-tts', 'motores'));

function duracaoWav(wav) {
  const taxa = wav.readUInt32LE(24);
  let pos = 12;
  while (pos < wav.length && wav.toString('ascii', pos, pos + 4) !== 'data') {
    pos += 8 + wav.readUInt32LE(pos + 4);
  }
  const n = (wav.length - pos - 8) >> 1;
  return { segundos: n / taxa, taxa, amostras: n, inicioDados: pos + 8 };
}

/** Onde comeca e termina o som de verdade, ignorando o silencio das pontas. */
function medirSilencio(wav) {
  const { taxa, amostras, inicioDados } = duracaoWav(wav);
  const limiar = 0.01;
  let primeiro = amostras, ultimo = 0;
  for (let i = 0; i < amostras; i++) {
    if (Math.abs(wav.readInt16LE(inicioDados + i * 2) / 32768) > limiar) {
      if (i < primeiro) primeiro = i;
      ultimo = i;
    }
  }
  return { inicioS: primeiro / taxa, fimS: (amostras - ultimo) / taxa };
}

const FRASE_INTEIRA =
  'Hello everyone, welcome back to the stream. Today we are going to try something completely different.';

// Os trechos que o reconhecedor de fato entregou no teste ao vivo.
const TRECHOS = [
  'Hello everyone, welcome', 'back to', 'the stream.', 'Today, we',
  'are going', 'to try', 'something completely different',
];

(async () => {
  const t0 = Date.now();
  const inteira = await piper.sintetizar({ texto: FRASE_INTEIRA, voz: 'en_US-amy-medium' });
  const dInteira = duracaoWav(inteira).segundos;
  console.log('frase inteira de uma vez:');
  console.log('  sintetizou em ' + (Date.now() - t0) + 'ms  |  audio de ' + dInteira.toFixed(2) + 's\n');

  console.log('em trechos (como o modo ao vivo faz):');
  let somaAudio = 0, somaSintese = 0, somaSilencio = 0;

  for (const trecho of TRECHOS) {
    const t = Date.now();
    const wav = await piper.sintetizar({ texto: trecho, voz: 'en_US-amy-medium' });
    const ms = Date.now() - t;
    const d = duracaoWav(wav).segundos;
    const sil = medirSilencio(wav);
    somaAudio += d;
    somaSintese += ms;
    somaSilencio += sil.inicioS + sil.fimS;
    console.log(
      '  ' + ('"' + trecho + '"').padEnd(36) +
      ' sintese ' + String(ms).padStart(4) + 'ms' +
      ' | audio ' + d.toFixed(2) + 's' +
      ' | silencio ' + (sil.inicioS + sil.fimS).toFixed(2) + 's'
    );
  }

  console.log('\n--- a conta que importa ---');
  console.log('  fala original            : ' + dInteira.toFixed(2) + 's');
  console.log('  audio somado dos trechos : ' + somaAudio.toFixed(2) + 's');
  console.log('  tempo gasto sintetizando : ' + (somaSintese / 1000).toFixed(2) + 's');
  console.log('  silencio inutil nas pontas: ' + somaSilencio.toFixed(2) + 's');
  console.log('');
  const razaoAudio = somaAudio / dInteira;
  const razaoTotal = (somaAudio + somaSintese / 1000) / dInteira;
  console.log('  RAZAO so do audio  : ' + razaoAudio.toFixed(2) + 'x');
  console.log('  RAZAO audio+sintese: ' + razaoTotal.toFixed(2) + 'x   <- acima de 1.0 = atraso cresce sem parar');
  console.log('');
  console.log('  sem o silencio das pontas: ' +
    ((somaAudio - somaSilencio + somaSintese / 1000) / dInteira).toFixed(2) + 'x');
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });

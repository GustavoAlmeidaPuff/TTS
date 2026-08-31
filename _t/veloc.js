const piper = require('../electron/tts/piper');
const path = require('path');
piper.definirRaiz(path.join(process.env.APPDATA, 'voz-tts', 'motores'));
const dur = (w) => { const t = w.readUInt32LE(24); let p = 12;
  while (p < w.length && w.toString('ascii', p, p+4) !== 'data') p += 8 + w.readUInt32LE(p+4);
  return ((w.length - p - 8) >> 1) / t; };
const TRECHOS = ['Hello everyone, welcome','back to','the stream.','Today, we','are going','to try','something completely different'];
const ORIGINAL = 6.41;
(async () => {
  for (const v of [0, 15, 25, 35]) {
    let soma = 0, ms = 0;
    for (const t of TRECHOS) {
      const t0 = Date.now();
      soma += dur(await piper.sintetizar({ texto: t, voz: 'en_US-amy-medium', velocidade: v }));
      ms += Date.now() - t0;
    }
    console.log('velocidade +' + String(v).padStart(2) + '%  ->  audio ' + soma.toFixed(2) +
      's  | razao ' + (soma/ORIGINAL).toFixed(2) + 'x  | sintese ' + (ms/1000).toFixed(2) + 's');
  }
  piper.encerrarTudo();
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });

// Custo em REGIME (nao a primeira chamada) para cada voz, num bloco fixo.
// E este numero que decide se a voz escolhida cabe ao vivo.
require('../electron/comum/onnx');
const path = require('path');
const { Conversor, TAXA_ENTRADA } = require('../electron/voz/rvc');
const DIR = path.join(process.env.APPDATA, 'voz-tts', 'motores', 'rvc');

(async () => {
  const SEG = Number(process.argv[2] || 0.5);
  const n = Math.round(TAXA_ENTRADA * SEG);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    a[i] = 0.3 * Math.sin(2*Math.PI*120*i/TAXA_ENTRADA) * (0.6 + 0.4*Math.sin(2*Math.PI*3*i/TAXA_ENTRADA));
  }

  const conv = new Conversor({
    contentvec: path.join(DIR, 'vec-768-layer-12.onnx'),
    rmvpe: path.join(DIR, 'rmvpe.onnx'),
    gerador: path.join(DIR, 'woman_1.onnx'),
  });
  await conv.carregar();
  console.log('bloco de ' + SEG + 's, 6 medicoes apos 3 de aquecimento:\n');
  console.log('voz        saida     vec  rmvpe  gerador   TOTAL   fator');

  for (const voz of ['woman_1', 'woman_2', 'woman_3']) {
    await conv.trocarGerador(path.join(DIR, voz + '.onnx'));
    for (let i = 0; i < 3; i++) await conv.converter(a, { tomAlvo: 220 });

    const t = { v: 0, r: 0, g: 0 };
    const N = 6;
    let taxa = 0;
    for (let i = 0; i < N; i++) {
      const x = await conv.converter(a, { tomAlvo: 220 });
      t.v += x.tempos.conteudo; t.r += x.tempos.melodia; t.g += x.tempos.gerador;
      taxa = x.taxa;
    }
    const total = (t.v + t.r + t.g) / N;
    const fator = total / (SEG * 1000);
    console.log(
      voz.padEnd(10) + String(taxa).padStart(6) + 'Hz' +
      String(Math.round(t.v/N)).padStart(6) + 'ms' +
      String(Math.round(t.r/N)).padStart(6) + 'ms' +
      String(Math.round(t.g/N)).padStart(8) + 'ms' +
      String(Math.round(total)).padStart(8) + 'ms   ' +
      fator.toFixed(2) + 'x' + (fator < 1 ? '  cabe' : '  NAO CABE')
    );
  }
  await conv.liberar();
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });

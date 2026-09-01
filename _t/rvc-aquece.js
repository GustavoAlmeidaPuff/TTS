// Mesmo bloco, varias vezes: separa custo de aquecimento (primeira chamada de
// cada formato) do custo de regime (o que vale pro tempo real).
require('../electron/comum/onnx');
const path = require('path');
const { Conversor, TAXA_ENTRADA } = require('../electron/voz/rvc');
const DIR = path.join(process.env.APPDATA, 'voz-tts', 'motores', 'rvc');

(async () => {
  const conv = new Conversor({
    contentvec: path.join(DIR, 'vec-768-layer-12.onnx'),
    rmvpe: path.join(DIR, 'rmvpe.onnx'),
    gerador: path.join(DIR, 'woman_1.onnx'),
  });
  await conv.carregar();

  const SEG = 0.5;
  const n = Math.round(TAXA_ENTRADA * SEG);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = 0.3 * Math.sin(2 * Math.PI * 140 * i / TAXA_ENTRADA);

  console.log('bloco fixo de ' + SEG + 's, 8 chamadas seguidas:\n');
  console.log('  #   conteudo  melodia   gerador    TOTAL   fator');
  for (let i = 0; i < 8; i++) {
    const r = await conv.converter(a);
    const f = r.tempos.total / (SEG * 1000);
    console.log('  ' + (i+1) + '   ' +
      String(r.tempos.conteudo).padStart(6) + 'ms' +
      String(r.tempos.melodia).padStart(8) + 'ms' +
      String(r.tempos.gerador).padStart(9) + 'ms' +
      String(r.tempos.total).padStart(8) + 'ms   ' + f.toFixed(2) + 'x');
  }
  await conv.liberar();
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });

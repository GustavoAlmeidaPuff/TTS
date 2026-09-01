// E se as TRES redes rodarem na RTX, em vez de duas na CPU?
// A hipotese: as sessoes de CPU estao sendo estranguladas pela espera ativa do
// DirectML, e na GPU elas fogem disso alem de rodarem mais rapido.
require('../electron/comum/onnx');
const path = require('path');
const { Conversor, TAXA_ENTRADA } = require('../electron/voz/rvc');
const DIR = path.join(process.env.APPDATA, 'voz-tts', 'motores', 'rvc');

(async () => {
  const n = Math.round(TAXA_ENTRADA * 0.5);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = 0.3*Math.sin(2*Math.PI*120*i/TAXA_ENTRADA);

  for (const leve of ['cpu', 'dml']) {
    const conv = new Conversor({
      contentvec: path.join(DIR, 'vec-768-layer-12.onnx'),
      rmvpe: path.join(DIR, 'rmvpe.onnx'),
      gerador: path.join(DIR, 'woman_3.onnx'),
    }, { provedorLeve: leve, dispositivo: 1 });

    try {
      await conv.carregar();
      for (let i = 0; i < 4; i++) await conv.converter(a, { tomAlvo: 220 });
      const t = { v:0, r:0, g:0 };
      const N = 8;
      for (let i = 0; i < N; i++) {
        const x = await conv.converter(a, { tomAlvo: 220 });
        t.v += x.tempos.conteudo; t.r += x.tempos.melodia; t.g += x.tempos.gerador;
      }
      const total = (t.v+t.r+t.g)/N;
      console.log('leves em ' + leve.toUpperCase().padEnd(4) +
        ' -> vec ' + String(Math.round(t.v/N)).padStart(4) + 'ms' +
        ' | rmvpe ' + String(Math.round(t.r/N)).padStart(4) + 'ms' +
        ' | gerador ' + String(Math.round(t.g/N)).padStart(4) + 'ms' +
        ' | TOTAL ' + String(Math.round(total)).padStart(4) + 'ms' +
        ' | fator ' + (total/500).toFixed(2) + 'x' + (total/500 < 1 ? '  CABE' : ''));
      await conv.liberar();
    } catch (e) {
      console.log('leves em ' + leve + ' -> FALHOU: ' + e.message.split('\n')[0].slice(0,80));
    }
  }
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });

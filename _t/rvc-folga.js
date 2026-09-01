// A degradacao a partir da 3a chamada e acumulo recuperavel ou custo real?
// Se dar folga entre as chamadas devolve a velocidade, e acumulo.
require('../electron/comum/onnx');
const path = require('path');
const { Conversor, TAXA_ENTRADA } = require('../electron/voz/rvc');
const DIR = path.join(process.env.APPDATA, 'voz-tts', 'motores', 'rvc');

(async () => {
  const n = Math.round(TAXA_ENTRADA * 0.5);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = 0.3*Math.sin(2*Math.PI*120*i/TAXA_ENTRADA);

  const conv = new Conversor({
    contentvec: path.join(DIR, 'vec-768-layer-12.onnx'),
    rmvpe: path.join(DIR, 'rmvpe.onnx'),
    gerador: path.join(DIR, 'woman_3.onnx'),
  });
  await conv.carregar();

  for (const folga of [0, 200, 500, 1000]) {
    const t = [];
    for (let i = 0; i < 6; i++) {
      const t0 = Date.now();
      await conv.converter(a, { tomAlvo: 220 });
      t.push(Date.now() - t0);
      if (folga) await new Promise(r => setTimeout(r, folga));
    }
    const ultimos = t.slice(2);
    const media = ultimos.reduce((x,y)=>x+y,0)/ultimos.length;
    console.log('folga ' + String(folga).padStart(4) + 'ms entre chamadas -> ' +
      Math.round(media) + 'ms por bloco de 500ms  (fator ' + (media/500).toFixed(2) + 'x)' +
      '   [' + t.join(', ') + ']');
  }
  await conv.liberar();
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });

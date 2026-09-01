// Como o custo do gerador cresce com o tamanho do bloco? Isso define qual
// pedaco usar no tempo real: o menor fator ganha.
require('../electron/comum/onnx');
const path = require('path');
const { Conversor, TAXA_ENTRADA } = require('../electron/voz/rvc');
const DIR = path.join(process.env.APPDATA, 'voz-tts', 'motores', 'rvc');

(async () => {
  const conv = new Conversor({
    contentvec: path.join(DIR, 'vec-768-layer-12.onnx'),
    rmvpe: path.join(DIR, 'rmvpe.onnx'),
    gerador: path.join(DIR, 'woman_3.onnx'),
  });
  await conv.carregar();
  console.log('gerador em: ' + conv.provedorGerador + '\n');
  console.log('bloco     conteudo  melodia   gerador     TOTAL    fator');

  for (const seg of [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0]) {
    const n = Math.round(TAXA_ENTRADA * seg);
    const a = new Float32Array(n);
    // Uma senoide com envelope, pra ter tom detectavel de verdade.
    for (let i = 0; i < n; i++) {
      a[i] = 0.3 * Math.sin(2 * Math.PI * 140 * i / TAXA_ENTRADA) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 2 * i / TAXA_ENTRADA));
    }
    await conv.converter(a); // aquecimento desta forma
    const r = await conv.converter(a);
    const f = r.tempos.total / (seg * 1000);
    console.log(
      String(seg.toFixed(2)).padStart(5) + 's  ' +
      String(r.tempos.conteudo).padStart(7) + 'ms' +
      String(r.tempos.melodia).padStart(8) + 'ms' +
      String(r.tempos.gerador).padStart(9) + 'ms' +
      String(r.tempos.total).padStart(9) + 'ms  ' +
      f.toFixed(2) + 'x' + (f < 1 ? '  <-- cabe' : '')
    );
  }
  await conv.liberar();
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });

// woman_3 carregada DIRETO, sem trocarGerador. Se ficar rapido, a troca de
// sessao DirectML e que estava deixando um rastro.
require('../electron/comum/onnx');
const path = require('path');
const { Conversor, TAXA_ENTRADA } = require('../electron/voz/rvc');
const DIR = path.join(process.env.APPDATA, 'voz-tts', 'motores', 'rvc');

(async () => {
  const SEG = Number(process.argv[2] || 0.5);
  const n = Math.round(TAXA_ENTRADA * SEG);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    a[i] = 0.3*Math.sin(2*Math.PI*120*i/TAXA_ENTRADA)*(0.6+0.4*Math.sin(2*Math.PI*3*i/TAXA_ENTRADA));
  }

  const conv = new Conversor({
    contentvec: path.join(DIR, 'vec-768-layer-12.onnx'),
    rmvpe: path.join(DIR, 'rmvpe.onnx'),
    gerador: path.join(DIR, 'woman_3.onnx'),   // <- direto, sem troca
  });
  await conv.carregar();

  console.log('woman_3 carregada direto | bloco ' + SEG + 's\n');
  console.log('  #     vec  rmvpe  gerador   TOTAL   fator');
  for (let i = 0; i < 10; i++) {
    const x = await conv.converter(a, { tomAlvo: 220 });
    const f = x.tempos.total / (SEG*1000);
    console.log('  ' + String(i+1).padStart(2) + String(x.tempos.conteudo).padStart(7) + 'ms' +
      String(x.tempos.melodia).padStart(6) + 'ms' + String(x.tempos.gerador).padStart(8) + 'ms' +
      String(x.tempos.total).padStart(8) + 'ms   ' + f.toFixed(2) + 'x' + (f<1?'  cabe':''));
  }
  await conv.liberar();
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });

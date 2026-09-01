// Teste no RITMO REAL: converte um bloco, espera o tempo que o proximo bloco
// levaria pra chegar do microfone, converte de novo. E assim que vai funcionar
// ao vivo -- e o teste anterior, sem pausa, criava uma fila na GPU que nao
// existiria na pratica.
require('../electron/comum/onnx');
const path = require('path');
const { Conversor, TAXA_ENTRADA } = require('../electron/voz/rvc');
const DIR = path.join(process.env.APPDATA, 'voz-tts', 'motores', 'rvc');

(async () => {
  const SEG = Number(process.argv[2] || 0.5);
  const VOZ = process.argv[3] || 'woman_3';
  const n = Math.round(TAXA_ENTRADA * SEG);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    a[i] = 0.3*Math.sin(2*Math.PI*120*i/TAXA_ENTRADA)*(0.6+0.4*Math.sin(2*Math.PI*3*i/TAXA_ENTRADA));
  }

  const conv = new Conversor({
    contentvec: path.join(DIR, 'vec-768-layer-12.onnx'),
    rmvpe: path.join(DIR, 'rmvpe.onnx'),
    gerador: path.join(DIR, VOZ + '.onnx'),
  });
  await conv.carregar();

  const orcamento = SEG * 1000;
  console.log(VOZ + ' | bloco ' + SEG + 's | orcamento ' + orcamento + 'ms por bloco\n');
  console.log('  #   converteu   sobrou   situacao');

  // Aquece ANTES de comecar a contar: carregar modelo e sondar GPU nao e custo
  // de regime, e contar isso como atraso mentia sobre o resultado.
  for (let i = 0; i < 4; i++) await conv.converter(a, { tomAlvo: 220 });

  let atrasoAcumulado = 0;
  for (let i = 0; i < 14; i++) {
    const t0 = Date.now();
    const x = await conv.converter(a, { tomAlvo: 220 });
    const gasto = Date.now() - t0;
    const folga = orcamento - gasto;
    atrasoAcumulado = Math.max(0, atrasoAcumulado - folga);

    if (i >= 2) {
      console.log('  ' + String(i+1).padStart(2) + String(gasto).padStart(9) + 'ms' +
        String(Math.round(folga)).padStart(9) + 'ms   ' +
        (folga > 0 ? 'ok' : 'ATRASOU') +
        (atrasoAcumulado > 0 ? '  (atraso acumulado ' + Math.round(atrasoAcumulado) + 'ms)' : ''));
    }

    // Espera o proximo bloco "chegar do microfone".
    if (folga > 0) await new Promise(r => setTimeout(r, folga));
  }

  console.log('\natraso acumulado no fim: ' + Math.round(atrasoAcumulado) + 'ms');
  console.log(atrasoAcumulado < 200 ? '=> ACOMPANHA ao vivo' : '=> NAO acompanha: o atraso cresce');
  await conv.liberar();
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });

// A pergunta que decide se RVC em tempo real e possivel aqui:
// os tres modelos, juntos, processam 1 segundo de audio em menos de 1 segundo?
//
// Mede com entradas do formato certo (conteudo e irrelevante pro tempo) em CPU
// e em DirectML (a RTX 4050 via DX12). Fator abaixo de 1.0 = da conta ao vivo.
const ort = require('onnxruntime-node');
const path = require('path');

const DIR = path.join(process.env.APPDATA, 'voz-tts', 'motores', 'rvc');
const TAXA = 16000;

const aleatorio = (n) => {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.random() * 2 - 1;
  return a;
};

async function medir(rotulo, sessao, montarEntradas, repeticoes, segundosDeAudio) {
  // Duas passadas de aquecimento: a primeira sempre paga alocacao de buffers.
  for (let i = 0; i < 2; i++) await sessao.run(montarEntradas());

  const tempos = [];
  for (let i = 0; i < repeticoes; i++) {
    const t0 = performance.now();
    await sessao.run(montarEntradas());
    tempos.push(performance.now() - t0);
  }
  tempos.sort((a, b) => a - b);
  const mediana = tempos[Math.floor(tempos.length / 2)];
  console.log(
    '    ' + rotulo.padEnd(14) +
    ' mediana ' + mediana.toFixed(0).padStart(5) + 'ms' +
    '  | fator ' + (mediana / (segundosDeAudio * 1000)).toFixed(2) + 'x'
  );
  return mediana;
}

(async () => {
  for (const ep of ['cpu', 'dml']) {
    console.log('\n########## ' + ep.toUpperCase() + ' ##########');

    // Bloco de 1 segundo de audio a 16 kHz.
    const SEG = 1.0;
    const amostras = Math.round(TAXA * SEG);
    const quadros = Math.floor(amostras / 160); // hop de 160 = 10ms
    const T = Math.floor(amostras / 320); // saida do ContentVec (hop 320)

    let total = 0;

    try {
      const vec = await ort.InferenceSession.create(path.join(DIR, 'vec-768-layer-12.onnx'), {
        executionProviders: [ep], graphOptimizationLevel: 'all',
      });
      total += await medir('ContentVec', vec,
        () => ({ source: new ort.Tensor('float32', aleatorio(amostras), [1, 1, amostras]) }), 6, SEG);
      await vec.release();
    } catch (e) { console.log('    ContentVec FALHOU: ' + e.message.split('\n')[0].slice(0, 110)); }

    try {
      const rmvpe = await ort.InferenceSession.create(path.join(DIR, 'rmvpe.onnx'), {
        executionProviders: [ep], graphOptimizationLevel: 'all',
      });
      total += await medir('RMVPE (tom)', rmvpe,
        () => ({ input: new ort.Tensor('float32', aleatorio(128 * quadros), [1, 128, quadros]) }), 6, SEG);
      await rmvpe.release();
    } catch (e) { console.log('    RMVPE FALHOU: ' + e.message.split('\n')[0].slice(0, 110)); }

    try {
      const ger = await ort.InferenceSession.create(path.join(DIR, 'woman_1.onnx'), {
        executionProviders: [ep], graphOptimizationLevel: 'all',
      });
      // O gerador trabalha no dobro dos quadros do ContentVec.
      const T2 = T * 2;
      total += await medir('Gerador', ger, () => ({
        phone: new ort.Tensor('float32', aleatorio(T2 * 768), [1, T2, 768]),
        phone_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(T2)]), [1]),
        pitch: new ort.Tensor('int64', BigInt64Array.from({ length: T2 }, () => 150n), [1, T2]),
        pitchf: new ort.Tensor('float32', new Float32Array(T2).fill(220), [1, T2]),
        ds: new ort.Tensor('int64', BigInt64Array.from([0n]), [1]),
        rnd: new ort.Tensor('float32', aleatorio(192 * T2), [1, 192, T2]),
      }), 6, SEG);
      await ger.release();
    } catch (e) { console.log('    Gerador FALHOU: ' + e.message.split('\n')[0].slice(0, 140)); }

    console.log('    ' + '-'.repeat(46));
    console.log('    ' + 'TOTAL'.padEnd(14) + ' ' + total.toFixed(0).padStart(12) + 'ms' +
      '  | fator ' + (total / 1000).toFixed(2) + 'x  <- abaixo de 1.0 da conta ao vivo');
  }
})().catch((e) => {
  console.error('FALHOU:', e.message);
  process.exit(1);
});

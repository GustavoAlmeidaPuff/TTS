'use strict';

/**
 * Mede qual placa de video e a mais rapida, e imprime o resultado como JSON.
 *
 * ---------------------------------------------------------------------------
 * Por que isto e um PROCESSO SEPARADO
 * ---------------------------------------------------------------------------
 * Sondar exige abrir e fechar uma sessao grande na GPU por dispositivo. Fazendo
 * isso dentro do processo que vai converter, a placa fica num estado ruim: numa
 * medicao, a conversao seguinte levou 53 SEGUNDOS -- e como a fila e serial,
 * tudo atras dela parou junto.
 *
 * Liberar a sessao nao resolve; o rastro fica no processo. Entao a sondagem
 * roda num processo proprio, que morre logo depois levando o rastro junto.
 *
 * Uso:
 *   node sondar-gpu.js <caminho-do-modelo.onnx>
 * Saida (stdout):
 *   {"dispositivo":1,"medidas":[{"dispositivo":0,"ms":270},...]}
 * ---------------------------------------------------------------------------
 */

const ort = require('onnxruntime-node');

const modelo = process.argv[2];
if (!modelo) {
  console.error('falta o caminho do modelo');
  process.exit(1);
}

const T = 50; // bloco minusculo: serve pra comparar, nao pra usar
const entradas = () => ({
  phone: new ort.Tensor('float32', new Float32Array(T * 768), [1, T, 768]),
  phone_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(T)]), [1]),
  pitch: new ort.Tensor('int64', BigInt64Array.from({ length: T }, () => 180n), [1, T]),
  pitchf: new ort.Tensor('float32', new Float32Array(T).fill(220), [1, T]),
  ds: new ort.Tensor('int64', BigInt64Array.from([0n]), [1]),
  rnd: new ort.Tensor('float32', new Float32Array(192 * T), [1, 192, T]),
});

(async () => {
  const medidas = [];
  let melhor = { dispositivo: 0, ms: Infinity };

  for (let dev = 0; dev < 4; dev++) {
    let sessao = null;
    try {
      sessao = await ort.InferenceSession.create(modelo, {
        executionProviders: [{ name: 'dml', deviceId: dev }],
        graphOptimizationLevel: 'all',
      });
      await sessao.run(entradas()); // a primeira chamada sempre mente

      const t0 = Date.now();
      await sessao.run(entradas());
      await sessao.run(entradas());
      const ms = Math.round((Date.now() - t0) / 2);

      medidas.push({ dispositivo: dev, ms });
      if (ms < melhor.ms) melhor = { dispositivo: dev, ms };
    } catch (_) {
      break; // acabaram os dispositivos
    } finally {
      if (sessao) await sessao.release().catch(() => {});
    }
  }

  process.stdout.write(JSON.stringify({ dispositivo: melhor.dispositivo, medidas }));
  process.exit(0);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});

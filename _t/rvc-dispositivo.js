// DirectML escolhe o dispositivo 0 por padrao. Em notebook isso costuma ser a
// placa INTEGRADA, nao a dedicada. Se for o caso, estamos medindo a GPU errada.
require('../electron/comum/onnx');
const { ort } = require('../electron/comum/onnx');
const path = require('path');
const DIR = path.join(process.env.APPDATA, 'voz-tts', 'motores', 'rvc');
const rnd = (n) => { const a = new Float32Array(n); for (let i=0;i<n;i++) a[i]=Math.random(); return a; };

(async () => {
  const T = 100;
  const entradas = () => ({
    phone: new ort.Tensor('float32', rnd(T*768), [1, T, 768]),
    phone_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(T)]), [1]),
    pitch: new ort.Tensor('int64', BigInt64Array.from({length:T},()=>180n), [1, T]),
    pitchf: new ort.Tensor('float32', new Float32Array(T).fill(220), [1, T]),
    ds: new ort.Tensor('int64', BigInt64Array.from([0n]), [1]),
    rnd: new ort.Tensor('float32', rnd(192*T), [1, 192, T]),
  });

  for (const dev of [0, 1, 2]) {
    try {
      const s = await ort.InferenceSession.create(path.join(DIR, 'woman_3.onnx'), {
        executionProviders: [{ name: 'dml', deviceId: dev }],
        graphOptimizationLevel: 'all',
      });
      for (let i = 0; i < 3; i++) await s.run(entradas());
      const t = [];
      for (let i = 0; i < 6; i++) {
        const t0 = Date.now();
        await s.run(entradas());
        t.push(Date.now() - t0);
      }
      t.sort((a,b)=>a-b);
      console.log('dispositivo ' + dev + ': mediana ' + t[3] + 'ms  [' + t.join(', ') + ']');
      await s.release();
    } catch (e) {
      console.log('dispositivo ' + dev + ': indisponivel (' + e.message.split('\n')[0].slice(0,60) + ')');
    }
  }
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });

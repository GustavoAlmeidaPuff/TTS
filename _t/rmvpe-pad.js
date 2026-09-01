const ort = require('onnxruntime-node');
const path = require('path');
const DIR = path.join(process.env.APPDATA, 'voz-tts', 'motores', 'rvc');
const rnd = (n) => { const a = new Float32Array(n); for (let i=0;i<n;i++) a[i]=Math.random(); return a; };
(async () => {
  const s = await ort.InferenceSession.create(path.join(DIR, 'rmvpe.onnx'), { executionProviders: ['cpu'] });
  console.log('RESULTADO sessao CPU criada');
  for (const q of [100, 96, 128, 160]) {
    try {
      const t0 = Date.now();
      const r = await s.run({ input: new ort.Tensor('float32', rnd(128*q), [1,128,q]) });
      console.log('RESULTADO quadros ' + String(q).padStart(4) + ' mult32=' + (q%32===0) + ' -> OK saida ' + JSON.stringify(r.output.dims) + ' em ' + (Date.now()-t0) + 'ms');
    } catch (e) {
      console.log('RESULTADO quadros ' + String(q).padStart(4) + ' mult32=' + (q%32===0) + ' -> FALHOU');
    }
  }
  await s.release();
})();

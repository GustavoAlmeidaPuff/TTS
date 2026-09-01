// Testa se limitar as threads de cada sessao resolve a disputa. O DirectML
// segura nucleos em espera ativa; sem teto, as sessoes de CPU ficam sem vez.
require('../electron/comum/onnx');
const { ort } = require('../electron/comum/onnx');
const path = require('path');
const sinal = require('../electron/voz/rvc/sinal');
const DIR = path.join(process.env.APPDATA, 'voz-tts', 'motores', 'rvc');
const TAXA = 16000;

async function experimento(rotulo, threadsLeves, threadsGerador) {
  const opcoesLeves = { executionProviders: ['cpu'], graphOptimizationLevel: 'all' };
  if (threadsLeves) { opcoesLeves.intraOpNumThreads = threadsLeves; opcoesLeves.interOpNumThreads = 1; }
  const opcoesGer = { executionProviders: ['dml'], graphOptimizationLevel: 'all' };
  if (threadsGerador) { opcoesGer.intraOpNumThreads = threadsGerador; opcoesGer.interOpNumThreads = 1; }

  const vec = await ort.InferenceSession.create(path.join(DIR, 'vec-768-layer-12.onnx'), opcoesLeves);
  const rmv = await ort.InferenceSession.create(path.join(DIR, 'rmvpe.onnx'), opcoesLeves);
  const ger = await ort.InferenceSession.create(path.join(DIR, 'woman_1.onnx'), opcoesGer);

  const SEG = 0.5, n = Math.round(TAXA * SEG);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = 0.3 * Math.sin(2 * Math.PI * 140 * i / TAXA);
  const filtros = sinal.bancoMel({ taxa: TAXA, nFft: 1024, nMels: 128, fMin: 30, fMax: 8000 });
  const janela = sinal.janelaHann(1024);

  const somas = { v: 0, r: 0, g: 0 };
  const N = 6;
  for (let it = 0; it < N + 1; it++) {
    let t = Date.now();
    const emb = await vec.run({ source: new ort.Tensor('float32', a, [1, 1, n]) });
    const tv = Date.now() - t;
    const T = emb.embed.dims[1] * 2, dim = emb.embed.dims[2];

    t = Date.now();
    const mel = sinal.melEspectrograma(a, { taxa: TAXA, nFft: 1024, salto: 160, nMels: 128, filtros, janela });
    const alvo = Math.ceil(mel.quadros / 32) * 32;
    const pad = new Float32Array(128 * alvo);
    for (let m = 0; m < 128; m++) pad.set(mel.dados.subarray(m * mel.quadros, (m + 1) * mel.quadros), m * alvo);
    await rmv.run({ input: new ort.Tensor('float32', pad, [1, 128, alvo]) });
    const tr = Date.now() - t;

    const dob = new Float32Array(T * dim);
    for (let q = 0; q < T; q++) dob.set(emb.embed.data.subarray(Math.floor(q/2)*dim, Math.floor(q/2)*dim+dim), q*dim);
    const rnd = new Float32Array(192 * T);
    t = Date.now();
    await ger.run({
      phone: new ort.Tensor('float32', dob, [1, T, dim]),
      phone_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(T)]), [1]),
      pitch: new ort.Tensor('int64', BigInt64Array.from({length:T},()=>150n), [1, T]),
      pitchf: new ort.Tensor('float32', new Float32Array(T).fill(140), [1, T]),
      ds: new ort.Tensor('int64', BigInt64Array.from([0n]), [1]),
      rnd: new ort.Tensor('float32', rnd, [1, 192, T]),
    });
    const tg = Date.now() - t;
    if (it > 0) { somas.v += tv; somas.r += tr; somas.g += tg; }
  }
  const total = (somas.v + somas.r + somas.g) / N;
  console.log(rotulo.padEnd(28) +
    ' vec ' + String(Math.round(somas.v/N)).padStart(4) + 'ms' +
    ' | rmvpe ' + String(Math.round(somas.r/N)).padStart(4) + 'ms' +
    ' | ger ' + String(Math.round(somas.g/N)).padStart(4) + 'ms' +
    ' | TOTAL ' + String(Math.round(total)).padStart(4) + 'ms' +
    ' | fator ' + (total / (SEG*1000)).toFixed(2) + 'x');
  for (const s of [vec, rmv, ger]) await s.release();
}

(async () => {
  await experimento('sem teto (padrao)', null, null);
  await experimento('leves=2', 2, null);
  await experimento('leves=4', 4, null);
  await experimento('leves=2, gerador=1', 2, 1);
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });

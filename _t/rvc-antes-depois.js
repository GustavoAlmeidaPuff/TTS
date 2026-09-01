require('../electron/comum/onnx');
const path = require('path');
const fs = require('fs');
const { Conversor, TAXA_ENTRADA, sinal } = require('../electron/voz/rvc');
const piper = require('../electron/tts/piper');
const RAIZ = path.join(process.env.APPDATA, 'voz-tts', 'motores');
piper.definirRaiz(RAIZ);
const DIR = path.join(RAIZ, 'rvc');

function lerWav(w) {
  const taxa = w.readUInt32LE(24); let p = 12;
  while (p < w.length && w.toString('ascii', p, p+4) !== 'data') p += 8 + w.readUInt32LE(p+4);
  const i0 = p+8, n = (w.length-i0)>>1, a = new Float32Array(n);
  for (let i=0;i<n;i++) a[i] = w.readInt16LE(i0+i*2)/32768;
  return { amostras: a, taxa };
}
function escrever(a, taxa, d) {
  const pcm = Buffer.alloc(a.length*2);
  for (let i=0;i<a.length;i++) pcm.writeInt16LE(Math.round(Math.max(-1,Math.min(1,a[i]))*32767), i*2);
  const c = Buffer.alloc(44);
  c.write('RIFF',0); c.writeUInt32LE(36+pcm.length,4); c.write('WAVE',8); c.write('fmt ',12);
  c.writeUInt32LE(16,16); c.writeUInt16LE(1,20); c.writeUInt16LE(1,22);
  c.writeUInt32LE(taxa,24); c.writeUInt32LE(taxa*2,28); c.writeUInt16LE(2,32); c.writeUInt16LE(16,34);
  c.write('data',36); c.writeUInt32LE(pcm.length,40);
  fs.writeFileSync(d, Buffer.concat([c,pcm]));
}
function contarBuracos(f0) {
  let n = 0, i = 0;
  while (i < f0.length) {
    if (f0[i] === 0) {
      const ini = i; while (i < f0.length && f0[i] === 0) i++;
      if (ini > 0 && i < f0.length && i - ini <= 3) n++;
    } else i++;
  }
  return n;
}
const desenhar = (f0, n) => Array.from(f0.subarray(0, n))
  .map(v => v === 0 ? '.' : String.fromCharCode(65 + Math.min(25, Math.floor((v-60)/12)))).join('');

(async () => {
  const wav = await piper.sintetizar({
    texto: 'Olá pessoal, sejam bem-vindos de volta ao canal. Hoje o teste é outro completamente diferente.',
    voz: 'pt_BR-faber-medium',
  });
  const o = lerWav(wav);
  const sherpa = require('sherpa-onnx-node');
  const entrada = new sherpa.LinearResampler(o.taxa, TAXA_ENTRADA).resample(o.amostras);

  for (const max of [0, 5]) {
    const conv = new Conversor({
      contentvec: path.join(DIR, 'vec-768-layer-12.onnx'),
      rmvpe: path.join(DIR, 'rmvpe.onnx'),
      gerador: path.join(DIR, 'woman_1.onnx'),
    }, { maxBuraco: max });
    await conv.carregar();

    const f0 = await conv._melodia(entrada);
    const r = await conv.converter(entrada, { tomAlvo: 200 });
    const rotulo = max === 0 ? 'SEM tapar' : 'TAPANDO ate 5 quadros';
    console.log(rotulo);
    console.log('  buracos curtos restantes: ' + contarBuracos(f0));
    console.log('  buracos que tapou       : ' + r.tom.buracosTapados);
    console.log('  melodia: ' + desenhar(f0, 90));
    escrever(r.audio, r.taxa, path.join(__dirname, max === 0 ? 'catarro-antes.wav' : 'catarro-depois.wav'));
    console.log('');
    await conv.liberar();
  }
})().catch(e => { console.error('FALHOU:', e.message); console.error(e.stack.split('\n')[1]); process.exit(1); });

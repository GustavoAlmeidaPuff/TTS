require('../electron/comum/onnx');
const path = require('path');
const fs = require('fs');
const { Conversor, TAXA_ENTRADA } = require('../electron/voz/rvc');
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

(async () => {
  const wav = await piper.sintetizar({
    texto: 'Olá pessoal, sejam bem-vindos de volta ao canal. Hoje o teste é outro completamente diferente.',
    voz: 'pt_BR-faber-medium',
  });
  const o = lerWav(wav);
  const sherpa = require('sherpa-onnx-node');
  const entrada = new sherpa.LinearResampler(o.taxa, TAXA_ENTRADA).resample(o.amostras);

  const conv = new Conversor({
    contentvec: path.join(DIR, 'vec-768-layer-12.onnx'),
    rmvpe: path.join(DIR, 'rmvpe.onnx'),
    gerador: path.join(DIR, 'woman_1.onnx'),
  });
  await conv.carregar();

  const casos = [
    ['woman_1', 200], ['woman_2', 200], ['woman_3', 200],
    ['woman_1', 230],
  ];

  for (const [voz, hz] of casos) {
    await conv.trocarGerador(path.join(DIR, voz + '.onnx'));
    const r = await conv.converter(entrada, { tomAlvo: hz });
    const nome = `voz-${voz}-${hz}hz.wav`;
    escrever(r.audio, r.taxa, path.join(__dirname, nome));
    console.log(nome.padEnd(26) + ' | ' + r.tom.seu + ' Hz -> ' + hz + ' Hz (' +
      (r.tom.semitons > 0 ? '+' : '') + r.tom.semitons + ' st) | saida ' + r.taxa + ' Hz | ' +
      (r.tempos.total/(r.tempos.segundosDeAudio*1000)).toFixed(2) + 'x');
  }
  await conv.liberar();
})().catch(e => { console.error('FALHOU:', e.message); console.error(e.stack.split('\n')[1]); process.exit(1); });

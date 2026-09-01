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
  const i0 = p + 8, n = (w.length - i0) >> 1, a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = w.readInt16LE(i0 + i*2) / 32768;
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
    texto: 'Olá pessoal, sejam bem-vindos de volta ao canal. Hoje o teste é outro.',
    voz: 'pt_BR-faber-medium',
  });
  const o = lerWav(wav);
  const sherpa = require('sherpa-onnx-node');
  const entrada = new sherpa.LinearResampler(o.taxa, TAXA_ENTRADA).resample(o.amostras);
  escrever(entrada, TAXA_ENTRADA, path.join(__dirname, 'auto-origem-masculina.wav'));

  const conv = new Conversor({
    contentvec: path.join(DIR, 'vec-768-layer-12.onnx'),
    rmvpe: path.join(DIR, 'rmvpe.onnx'),
    gerador: path.join(DIR, 'woman_1.onnx'),
  });
  await conv.carregar();

  console.log('voz de entrada: masculina (Faber)\n');
  // Sem transposicao (o caso "rouco" que ele relatou)
  const semAjuste = await conv.converter(entrada, { semitons: 0 });
  console.log('SEM ajuste   : seu tom ' + semAjuste.tom.seu + ' Hz | transpos ' + semAjuste.tom.semitons + ' semitons');
  escrever(semAjuste.audio, semAjuste.taxa, path.join(__dirname, 'auto-sem-ajuste.wav'));

  // Com o automatico
  const auto = await conv.converter(entrada, { tomAlvo: 200 });
  console.log('COM automatico: seu tom ' + auto.tom.seu + ' Hz -> alvo ' + auto.tom.alvo +
    ' Hz | transpos ' + auto.tom.semitons + ' semitons');
  escrever(auto.audio, auto.taxa, path.join(__dirname, 'auto-com-ajuste.wav'));

  console.log('\nfator de tempo real: ' + (auto.tempos.total/(auto.tempos.segundosDeAudio*1000)).toFixed(2) + 'x');
  await conv.liberar();
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });

// Diagnostico do "catarro": procura defeitos na melodia extraida.
//
// Hipotese: o detector perde a voz por um ou dois quadros no meio de uma vogal
// e devolve zero. O gerador entao troca de excitacao harmonica pra ruido e volta,
// varias vezes por segundo -- e isso soa como gargarejo.
//
// Este teste conta os defeitos em vez de adivinhar qual e.
require('../electron/comum/onnx');
const path = require('path');
const fs = require('fs');
const { Conversor, TAXA_ENTRADA, sinal } = require('../electron/voz/rvc');
const piper = require('../electron/tts/piper');

const RAIZ = path.join(process.env.APPDATA, 'voz-tts', 'motores');
piper.definirRaiz(RAIZ);
const DIR = path.join(RAIZ, 'rvc');

function lerWav(w) {
  const taxa = w.readUInt32LE(24);
  let p = 12;
  while (p < w.length && w.toString('ascii', p, p + 4) !== 'data') p += 8 + w.readUInt32LE(p + 4);
  const i0 = p + 8, n = (w.length - i0) >> 1, a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = w.readInt16LE(i0 + i * 2) / 32768;
  return { amostras: a, taxa };
}

(async () => {
  const arquivo = process.argv[2];
  let entrada;

  if (arquivo && fs.existsSync(arquivo)) {
    const o = lerWav(fs.readFileSync(arquivo));
    const sherpa = require('sherpa-onnx-node');
    entrada = o.taxa === TAXA_ENTRADA
      ? o.amostras
      : new sherpa.LinearResampler(o.taxa, TAXA_ENTRADA).resample(o.amostras);
    console.log('fonte: ' + path.basename(arquivo));
  } else {
    const wav = await piper.sintetizar({
      texto: 'Olá pessoal, sejam bem-vindos de volta ao canal. Hoje o teste é outro completamente diferente.',
      voz: 'pt_BR-faber-medium',
    });
    const o = lerWav(wav);
    const sherpa = require('sherpa-onnx-node');
    entrada = new sherpa.LinearResampler(o.taxa, TAXA_ENTRADA).resample(o.amostras);
    console.log('fonte: fala masculina do Piper');
  }

  const conv = new Conversor({
    contentvec: path.join(DIR, 'vec-768-layer-12.onnx'),
    rmvpe: path.join(DIR, 'rmvpe.onnx'),
    gerador: path.join(DIR, 'woman_1.onnx'),
  });
  await conv.carregar();

  const f0 = await conv._melodia(entrada);
  const n = f0.length;

  let comVoz = 0;
  for (let i = 0; i < n; i++) if (f0[i] > 0) comVoz++;

  // Buraco: quadro sem voz cercado de voz dos dois lados. E o defeito suspeito.
  const buracos = [];
  let i = 0;
  while (i < n) {
    if (f0[i] === 0) {
      const inicio = i;
      while (i < n && f0[i] === 0) i++;
      const tamanho = i - inicio;
      const cercado = inicio > 0 && i < n && f0[inicio - 1] > 0 && f0[i] > 0;
      if (cercado) buracos.push(tamanho);
    } else i++;
  }

  // Salto de oitava: a frequencia dobra ou cai pela metade de um quadro pro outro.
  let saltos = 0;
  let maiorSalto = 0;
  for (let k = 1; k < n; k++) {
    if (f0[k] > 0 && f0[k - 1] > 0) {
      const razao = f0[k] / f0[k - 1];
      const semitons = Math.abs(12 * Math.log2(razao));
      if (semitons > maiorSalto) maiorSalto = semitons;
      if (semitons > 6) saltos++; // meia oitava de um quadro pro outro nao e fala
    }
  }

  const curtos = buracos.filter((b) => b <= 3).length;
  console.log('\nquadros            : ' + n + '  (' + (n / 100).toFixed(1) + 's)');
  console.log('com voz            : ' + comVoz + '  (' + Math.round((comVoz / n) * 100) + '%)');
  console.log('buracos no meio    : ' + buracos.length);
  console.log('  deles curtos(<=3): ' + curtos + '   <- estes sao o "catarro"');
  console.log('  o maior tinha    : ' + (buracos.length ? Math.max(...buracos) : 0) + ' quadros');
  console.log('saltos de tom >6st : ' + saltos + '  (maior: ' + maiorSalto.toFixed(1) + ' semitons)');

  const porSegundo = curtos / (n / 100);
  console.log('\nburacos curtos por segundo: ' + porSegundo.toFixed(1));
  console.log(porSegundo > 1
    ? '=> CONFIRMADO: ha buracos suficientes pra causar o gargarejo'
    : '=> poucos buracos; a causa provavel e outra');

  // Desenha o comeco da melodia, pra ver o defeito com os olhos.
  console.log('\nmelodia (primeiros 90 quadros, "." = sem voz):');
  let linha = '';
  for (let k = 0; k < Math.min(90, n); k++) {
    linha += f0[k] === 0 ? '.' : String.fromCharCode(65 + Math.min(25, Math.floor((f0[k] - 60) / 12)));
  }
  console.log('  ' + linha);

  await conv.liberar();
})().catch((e) => {
  console.error('FALHOU:', e.message);
  console.error(e.stack.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
});

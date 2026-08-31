// Testa o modo --json-input do Piper, onde EU escolho o nome do arquivo de
// saida. Isso da um delimitador deterministico ("o arquivo apareceu e parou de
// crescer") em vez do palpite frageil de "o cano ficou quieto".
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(process.env.APPDATA, 'voz-tts', 'motores');
const EXE = path.join(RAIZ, 'piper', 'piper', 'piper.exe');
const MODELO = path.join(RAIZ, 'vozes', 'en_US-amy-medium.onnx');
const DIR = path.join(process.env.TEMP, 'pipertest');

fs.mkdirSync(DIR, { recursive: true });

const proc = spawn(
  EXE,
  ['--model', MODELO, '--json-input', '--sentence_silence', '0', '--quiet'],
  { cwd: path.dirname(EXE), windowsHide: true }
);
proc.stderr.on('data', (d) => process.stderr.write('[piper] ' + d));

function esperarArquivo(caminho, limiteMs = 15000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const ver = () => {
      if (fs.existsSync(caminho)) {
        const tamanho = fs.statSync(caminho).size;
        // O arquivo aparece antes de estar completo; espera parar de crescer.
        setTimeout(() => {
          if (fs.statSync(caminho).size === tamanho && tamanho > 44) {
            return resolve(Date.now() - t0);
          }
          ver();
        }, 30);
        return;
      }
      if (Date.now() - t0 > limiteMs) return reject(new Error('tempo esgotado'));
      setTimeout(ver, 15);
    };
    ver();
  });
}

function duracao(w) {
  const taxa = w.readUInt32LE(24);
  let p = 12;
  while (p < w.length && w.toString('ascii', p, p + 4) !== 'data') p += 8 + w.readUInt32LE(p + 4);
  return ((w.length - p - 8) >> 1) / taxa;
}

const TEXTOS = [
  'Hello everyone, welcome back to the stream. Today we are going to try something completely different.',
  'Hello everyone, welcome', 'back to', 'the stream.', 'Today, we',
  'are going', 'to try', 'something completely different',
];

(async () => {
  let i = 0;
  let somaAudio = 0;
  let somaMs = 0;
  let inteira = 0;

  for (const texto of TEXTOS) {
    const saida = path.join(DIR, 'out' + i++ + '.wav');
    const t = Date.now();
    proc.stdin.write(JSON.stringify({ text: texto, output_file: saida }) + '\n');
    try {
      await esperarArquivo(saida);
      const ms = Date.now() - t;
      const d = duracao(fs.readFileSync(saida));
      if (i === 1) inteira = d;
      else { somaAudio += d; somaMs += ms; }
      console.log(
        '  ' + String(ms).padStart(5) + 'ms | audio ' + d.toFixed(2) + 's | "' + texto.slice(0, 44) + '"'
      );
    } catch (e) {
      console.log('  FALHOU "' + texto.slice(0, 30) + '": ' + e.message);
    }
  }

  console.log('\n  frase inteira            : ' + inteira.toFixed(2) + 's  (esperado ~6.9s)');
  console.log('  audio somado dos trechos : ' + somaAudio.toFixed(2) + 's');
  console.log('  sintese somada           : ' + (somaMs / 1000).toFixed(2) + 's');
  console.log('  RAZAO so do audio        : ' + (somaAudio / inteira).toFixed(2) + 'x');

  proc.stdin.end();
  proc.kill();
})();

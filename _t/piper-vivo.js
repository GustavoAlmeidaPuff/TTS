// Mede o ganho de manter UM processo do Piper vivo, em vez de lancar um por
// trecho. A hipotese e que os ~750ms fixos por trecho sao carregamento do
// modelo, e nao sintese -- e portanto pagaveis uma vez so.
const { spawn } = require('child_process');
const path = require('path');

const RAIZ = path.join(process.env.APPDATA, 'voz-tts', 'motores');
const EXE = path.join(RAIZ, 'piper', 'piper', 'piper.exe');
const MODELO = path.join(RAIZ, 'vozes', 'en_US-amy-medium.onnx');

const TRECHOS = [
  'Hello everyone, welcome', 'back to', 'the stream.', 'Today, we',
  'are going', 'to try', 'something completely different',
];

/** Piper vivo: uma linha entra no stdin, o PCM cru sai no stdout. */
function abrirPiper(silencioFinal) {
  const proc = spawn(
    EXE,
    ['--model', MODELO, '--output_raw', '--sentence_silence', String(silencioFinal), '--quiet'],
    { cwd: path.dirname(EXE), windowsHide: true }
  );
  proc.stderr.resume();
  return proc;
}

/**
 * Manda uma linha e junta o audio ate a saida ficar quieta.
 * O Piper gera bem mais rapido que tempo real, entao uma pausa de 120ms sem
 * nenhum byte quer dizer que aquele trecho acabou.
 */
function falar(proc, texto, quietudeMs = 120) {
  return new Promise((resolve) => {
    const pedacos = [];
    let temporizador = null;
    let primeiroByteEm = 0;
    const inicio = Date.now();

    const aoDado = (d) => {
      if (!primeiroByteEm) primeiroByteEm = Date.now() - inicio;
      pedacos.push(d);
      clearTimeout(temporizador);
      temporizador = setTimeout(terminar, quietudeMs);
    };

    const terminar = () => {
      proc.stdout.off('data', aoDado);
      const pcm = Buffer.concat(pedacos);
      resolve({
        bytes: pcm.length,
        segundos: pcm.length / 2 / 22050,
        totalMs: Date.now() - inicio - quietudeMs,
        primeiroByteEm,
      });
    };

    proc.stdout.on('data', aoDado);
    proc.stdin.write(texto + '\n');
    // Se nada vier em 5s, desiste em vez de pendurar.
    temporizador = setTimeout(terminar, 5000);
  });
}

(async () => {
  for (const silencio of [0.2, 0.0]) {
    console.log('=== silencio por frase: ' + silencio + 's ===');
    const proc = abrirPiper(silencio);

    // A primeira chamada paga o carregamento do modelo; e ela que a gente
    // quer provar que nao se repete.
    const aquecer = await falar(proc, 'warm up');
    console.log('  1a chamada (carrega o modelo): ' + aquecer.totalMs + 'ms');

    let somaMs = 0, somaAudio = 0;
    for (const t of TRECHOS) {
      const r = await falar(proc, t);
      somaMs += r.totalMs;
      somaAudio += r.segundos;
      console.log(
        '  ' + ('"' + t + '"').padEnd(36) +
        ' ' + String(r.totalMs).padStart(4) + 'ms' +
        ' | audio ' + r.segundos.toFixed(2) + 's' +
        ' | 1o byte em ' + r.primeiroByteEm + 'ms'
      );
    }

    proc.stdin.end();
    proc.kill();

    const original = 6.92;
    console.log('  ----');
    console.log('  sintese somada: ' + (somaMs / 1000).toFixed(2) + 's  (antes: 5.30s)');
    console.log('  audio somado  : ' + somaAudio.toFixed(2) + 's  (antes: 9.89s)');
    console.log('  RAZAO         : ' + ((somaAudio + somaMs / 1000) / original).toFixed(2) +
      'x  (antes: 2.19x)\n');
  }
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });

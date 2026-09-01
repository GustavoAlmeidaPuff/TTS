// Testa o modo AO VIVO do RVC sem ninguem falando: injeta fala no lugar do
// microfone e confere se os blocos convertidos saem continuos e no prazo.
//
//   npx electron testes/rvc-vivo-teste.js
require('../electron/comum/onnx');

const { app, BrowserWindow, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const { Conversor } = require('../electron/voz/rvc');
const { Streaming } = require('../electron/voz/rvc/streaming');
const piper = require('../electron/tts/piper');

app.setName('voz-tts');
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const RAIZ = path.join(app.getPath('userData'), 'motores');
  const DIR = path.join(RAIZ, 'rvc');
  piper.definirRaiz(RAIZ);

  session.defaultSession.setPermissionRequestHandler((_c, p, permitir) =>
    permitir(p === 'media' || p === 'audioCapture')
  );

  console.log('carregando os modelos...');
  const conversor = new Conversor({
    contentvec: path.join(DIR, 'vec-768-layer-12.onnx'),
    rmvpe: path.join(DIR, 'rmvpe.onnx'),
    gerador: path.join(DIR, 'woman_3.onnx'),
  }, { cacheDispositivo: path.join(RAIZ, 'gpu-escolhida.json') });
  await conversor.carregar();
  console.log('gerador em ' + conversor.provedorGerador + ', dispositivo ' + conversor.dispositivo);
  console.log('GPUs medidas: ' + JSON.stringify(conversor.gpusMedidas));

  const streaming = new Streaming(conversor, { blocoS: 0.5, contextoS: 0.5 });
  streaming.definirOpcoes({ tomAlvo: 220 });

  const blocos = [];
  streaming.on('audio', (d) => {
    blocos.push(d);
    console.log(
      '  bloco ' + String(blocos.length).padStart(2) +
      ': ' + String(d.audio.length).padStart(6) + ' amostras a ' + d.taxa + 'Hz' +
      ' | gastou ' + String(d.gastoMs).padStart(4) + 'ms' +
      ' | folga ' + String(d.folgaMs).padStart(4) + 'ms' +
      (d.folgaMs < 0 ? '  ATRASOU' : '')
    );
  });
  streaming.on('erro', (e) => console.log('  ERRO: ' + e.message));

  // Fala de teste, em 16 kHz.
  const wav = await piper.sintetizar({
    texto: 'Olá pessoal, sejam bem-vindos de volta ao canal. Hoje o teste é da conversão ao vivo, que precisa acompanhar a fala sem atrasar.',
    voz: 'pt_BR-faber-medium',
  });
  const taxa = wav.readUInt32LE(24);
  let p = 12;
  while (p < wav.length && wav.toString('ascii', p, p + 4) !== 'data') p += 8 + wav.readUInt32LE(p + 4);
  const i0 = p + 8, n = (wav.length - i0) >> 1;
  const bruto = new Float32Array(n);
  for (let i = 0; i < n; i++) bruto[i] = wav.readInt16LE(i0 + i * 2) / 32768;

  const sherpa = require('sherpa-onnx-node');
  const fala = new sherpa.LinearResampler(taxa, 16000).resample(bruto);
  console.log('\nfala de teste: ' + (fala.length / 16000).toFixed(1) + 's\n');

  // Alimenta em blocos de 100ms, NO RITMO REAL (como o microfone faria).
  const porPedaco = 1600;
  const inicio = Date.now();
  let entregues = 0;
  for (let i = 0; i < fala.length; i += porPedaco) {
    streaming.alimentar(fala.slice(i, Math.min(i + porPedaco, fala.length)));
    entregues += 100;
    const jaPassou = Date.now() - inicio;
    if (entregues > jaPassou) await esperar(entregues - jaPassou);
  }

  await esperar(2000); // deixa o ultimo bloco terminar

  const duracaoEntrada = fala.length / 16000;
  const amostrasSaida = blocos.reduce((a, b) => a + b.audio.length, 0);
  const duracaoSaida = blocos.length ? amostrasSaida / blocos[0].taxa : 0;
  const atrasados = blocos.filter((b) => b.folgaMs < 0).length;
  const gastoMedio = blocos.reduce((a, b) => a + b.gastoMs, 0) / (blocos.length || 1);

  console.log('\n=== RESULTADO ===');
  console.log('entrou  : ' + duracaoEntrada.toFixed(2) + 's de fala');
  console.log('saiu    : ' + duracaoSaida.toFixed(2) + 's de voz convertida  (' + blocos.length + ' blocos)');
  console.log('gasto medio por bloco: ' + Math.round(gastoMedio) + 'ms de 500ms');
  console.log('blocos atrasados     : ' + atrasados + ' de ' + blocos.length);
  const perda = Math.abs(duracaoSaida - duracaoEntrada) / duracaoEntrada;
  console.log('perda de duracao     : ' + (perda * 100).toFixed(1) + '%');
  console.log(
    atrasados === 0 && perda < 0.12
      ? '\n=> ACOMPANHA: contínuo e no prazo'
      : '\n=> revisar: ' + (atrasados ? atrasados + ' blocos atrasados' : '') +
        (perda >= 0.12 ? ' perda de duracao alta' : '')
  );

  // Junta tudo num WAV pra ouvir se as emendas estao limpas.
  if (blocos.length) {
    const total = new Float32Array(amostrasSaida);
    let pos = 0;
    for (const b of blocos) { total.set(b.audio, pos); pos += b.audio.length; }
    const t = blocos[0].taxa;
    const pcm = Buffer.alloc(total.length * 2);
    for (let i = 0; i < total.length; i++) {
      pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, total[i])) * 32767), i * 2);
    }
    const c = Buffer.alloc(44);
    c.write('RIFF', 0); c.writeUInt32LE(36 + pcm.length, 4); c.write('WAVE', 8); c.write('fmt ', 12);
    c.writeUInt32LE(16, 16); c.writeUInt16LE(1, 20); c.writeUInt16LE(1, 22);
    c.writeUInt32LE(t, 24); c.writeUInt32LE(t * 2, 28); c.writeUInt16LE(2, 32); c.writeUInt16LE(16, 34);
    c.write('data', 36); c.writeUInt32LE(pcm.length, 40);
    const destino = path.join(__dirname, 'vivo-costurado.wav');
    fs.writeFileSync(destino, Buffer.concat([c, pcm]));
    console.log('\naudio costurado salvo em ' + destino);
  }

  await conversor.liberar();
  app.quit();
}).catch((e) => {
  console.error('FALHOU:', e.message);
  console.error(e.stack);
  app.exit(1);
});

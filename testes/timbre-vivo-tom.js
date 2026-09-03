// Troca de timbre ao vivo, de ponta a ponta DENTRO DO APP e sem ninguem falar.
//
// A fala e gerada pelo proprio Piper e injetada no lugar do microfone, entao o
// caminho percorrido e o de verdade: worklet -> IPC -> conversor -> streaming
// -> volta pra tela -> agendador do AudioContext.
//
//   npx electron testes/timbre-vivo.js
const { app } = require('electron');
const path = require('path');
const { abrirApp, esperar, fotografar } = require('./comum');

const FRASE =
  'Olá pessoal, sejam bem-vindos de volta ao canal. Hoje o teste é da troca de timbre ao vivo dentro do aplicativo.';

(async () => {
  const { janela, mensagens } = await abrirApp();

  // 1. Abre a aba e espera ela se montar.
  await janela.webContents.executeJavaScript(`document.getElementById('aba-timbre').click(); true`);
  await esperar(2500);

  const pronto = await janela.webContents.executeJavaScript(
    `!document.getElementById('timbre-pronto').classList.contains('oculto')`
  );
  if (!pronto) {
    console.error('FALHOU: os modelos do RVC nao estao baixados nesta maquina');
    return app.exit(1);
  }

  // 2. Gera a fala com o Piper e troca o microfone por ela.
  const montagem = await janela.webContents.executeJavaScript(`(async () => {
    // Tom sintetico no proprio renderer: NAO chama o Piper, pra que nenhum
    // processo dele fique vivo competindo por CPU durante a medicao.
    const ctx = new AudioContext();
    const dur = 7;
    const buffer = ctx.createBuffer(1, Math.round(ctx.sampleRate * dur), ctx.sampleRate);
    const d = buffer.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      const s = i / ctx.sampleRate;
      d[i] = 0.3 * Math.sin(2 * Math.PI * 120 * s) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 2.5 * s));
    }
    const comSilencio = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.3) + buffer.length, ctx.sampleRate);
    comSilencio.getChannelData(0).set(buffer.getChannelData(0), Math.round(ctx.sampleRate * 0.3));

    const destino = ctx.createMediaStreamDestination();
    const fonte = ctx.createBufferSource();
    fonte.buffer = comSilencio;
    fonte.connect(destino);

    window.__falaFalsa = { ctx, fonte };
    navigator.mediaDevices.getUserMedia = async () => destino.stream;

    // Espiona o agendador: e ele que prova que a voz saiu colada.
    window.__espia = { agendados: 0, amostras: 0, gastos: [] };
    // window.api vem do contextBridge e e congelado -- nao da pra embrulhar.
    // Entao a sonda le o placar da tela, que e atualizado a cada bloco.
    window.__espia.timer = setInterval(() => {
      const m = /^([0-9]+) ms/.exec(document.getElementById('tb-gasto').textContent);
      if (m) {
        const v = Number(m[1]);
        const g = window.__espia.gastos;
        if (g[g.length - 1] !== v) g.push(v);
      }
    }, 150);
    const criar = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function () {
      const f = criar.call(this);
      const start = f.start.bind(f);
      f.start = (...a) => {
        if (f.buffer && f.buffer.length > 1000) {
          window.__espia.agendados++;
          window.__espia.amostras += f.buffer.length;
        }
        return start(...a);
      };
      return f;
    };

    return { segundos: +comSilencio.duration.toFixed(2) };
  })()`);

  if (montagem.erro) {
    console.error('FALHOU ao gerar a fala: ' + montagem.erro);
    return app.exit(1);
  }
  console.log('fala injetada: ' + montagem.segundos + 's\n');

  // 3. Liga a troca de timbre (carrega os modelos na GPU: leva alguns segundos).
  await janela.webContents.executeJavaScript(`document.getElementById('btn-timbre').click(); true`);
  await esperar(20000); // carga + aquecimento

  const ligou = await janela.webContents.executeJavaScript(
    `document.getElementById('btn-timbre').textContent.trim()`
  );
  console.log('estado do botao apos ligar: "' + ligou + '"');

  // 4. Solta o audio e deixa correr.
  await janela.webContents.executeJavaScript(`window.__falaFalsa.fonte.start(); true`);
  await esperar(Math.ceil(montagem.segundos * 1000) + 6000);

  const r = await janela.webContents.executeJavaScript(`(() => ({
    estado: document.getElementById('estado').textContent,
    atraso: document.getElementById('tb-atraso').textContent,
    gasto: document.getElementById('tb-gasto').textContent,
    tom: document.getElementById('tb-tom').textContent,
    gpu: document.getElementById('tb-gpu').textContent,
    espia: window.__espia,
  }))()`);

  await fotografar(janela, 'tela-timbre-vivo.png');

  const segundosSaida = r.espia.amostras / 48000;
  console.log('\n=== RESULTADO ===');
  console.log('blocos agendados : ' + r.espia.agendados);
  console.log('audio produzido  : ' + segundosSaida.toFixed(2) + 's  (entrou ' + montagem.segundos + 's)');
  console.log('atraso mostrado  : ' + r.atraso);
  const g = r.espia.gastos || [];
  const meio = g.slice(2);
  const media = meio.length ? Math.round(meio.reduce((a,b)=>a+b,0)/meio.length) : 0;
  console.log('por bloco        : ' + r.gasto);
  console.log('  todos          : ' + g.join(', '));
  const orc = Number(process.env.BLOCO || 500);
  console.log('  media (sem os 2 primeiros): ' + media + 'ms de ' + orc + 'ms  -> ' + (media/orc).toFixed(2) + 'x');
  console.log('tom              : ' + r.tom);
  console.log('gpu              : ' + r.gpu);
  console.log('estado           : ' + r.estado);

  const cobertura = segundosSaida / montagem.segundos;
  console.log(
    '\n' +
      (r.espia.agendados >= 5 && cobertura > 0.7
        ? '=> FUNCIONA: a voz saiu contínua pelo app'
        : '=> revisar: ' + r.espia.agendados + ' blocos, cobertura ' + (cobertura * 100).toFixed(0) + '%')
  );

  if (mensagens.length) {
    console.log('\n=== CONSOLE DA PAGINA ===');
    console.log(mensagens.join('\n'));
  }

  app.quit();
})().catch((e) => {
  console.error('FALHOU:', e.message);
  console.error(e.stack);
  app.exit(1);
});

// Segundo arranjo: dirige a interface de verdade -- escreve o texto, aperta
// Falar, e confere se o audio percorreu tudo (sintese -> blob -> setSinkId ->
// play -> ended). E o teste que prova o roteamento, nao so a tela.
const { app, BrowserWindow, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const RAIZ = path.join(__dirname, '..');
const motores = require(path.join(RAIZ, 'electron', 'tts'));
app.setName('voz-tts');
motores.piper.definirRaiz(path.join(app.getPath('userData'), 'motores'));

ipcMain.handle('tts:motores', async () => motores.listarMotores());
ipcMain.handle('tts:vozes', async (_e, motor) => {
  try { return { ok: true, vozes: await motores.listarVozes(motor) }; }
  catch (e) { return { ok: false, erro: e.message }; }
});
ipcMain.handle('tts:falar', async (_e, pedido) => {
  try {
    const { audio, mime } = await motores.sintetizar(pedido);
    return { ok: true, audio: new Uint8Array(audio), mime };
  } catch (e) { return { ok: false, erro: e.message }; }
});
ipcMain.handle('piper:status', async () => motores.piper.status());
ipcMain.handle('piper:instalar', async () => ({ ok: false, erro: 'desligado no teste' }));
ipcMain.handle('config:ler', async () => ({}));
ipcMain.handle('config:salvar', async () => true);
ipcMain.handle('app:abrirLink', async () => {});

const mensagens = [];

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_c, p, permitir) =>
    permitir(p === 'media' || p === 'audioCapture')
  );

  const janela = new BrowserWindow({
    width: 1060, height: 760, show: false, backgroundColor: '#12141a',
    webPreferences: {
      preload: path.join(RAIZ, 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });

  janela.webContents.on('console-message', (_e, nivel, msg) =>
    mensagens.push(`[${['log', 'aviso', 'ERRO'][nivel] || nivel}] ${msg}`)
  );

  await janela.loadFile(path.join(RAIZ, 'src', 'index.html'));
  await new Promise((r) => setTimeout(r, 9000));

  // Espiona o setSinkId e o play pra provar que foram chamados de verdade, e
  // com qual dispositivo -- e isso que faz a voz sair no cabo.
  await janela.webContents.executeJavaScript(`(() => {
    window.__espia = { sinks: [], plays: 0, erros: [] };
    const sink = Audio.prototype.setSinkId;
    Audio.prototype.setSinkId = function (id) {
      window.__espia.sinks.push(id === '' ? '(padrao)' : id.slice(0, 12));
      return sink.call(this, id).catch((e) => {
        window.__espia.erros.push('setSinkId: ' + e.message);
        throw e;
      });
    };
    const play = Audio.prototype.play;
    Audio.prototype.play = function () {
      window.__espia.plays++;
      return play.call(this).catch((e) => {
        window.__espia.erros.push('play: ' + e.message);
        throw e;
      });
    };
    return true;
  })()`);

  // Liga o monitor tambem, pra testar o caminho dos DOIS destinos ao mesmo tempo.
  await janela.webContents.executeJavaScript(`(() => {
    document.getElementById('texto').value =
      'Teste automatizado do caminho de audio. Uma frase curta.';
    const m = document.getElementById('monitorar');
    m.checked = true;
    m.dispatchEvent(new Event('change'));
    document.getElementById('btn-falar').click();
    return true;
  })()`);

  // Espera sintetizar (rede) + tocar a frase inteira.
  await new Promise((r) => setTimeout(r, 16000));

  const resultado = await janela.webContents.executeJavaScript(`(() => ({
    estado: document.getElementById('estado').textContent,
    classePonto: document.getElementById('ponto-estado').className,
    espia: window.__espia,
    itensHistorico: [...document.querySelectorAll('#lista-historico li')]
      .map((li) => li.className + ':' + li.textContent.slice(0, 40)),
    botaoFalarLiberado: !document.getElementById('btn-falar').disabled,
  }))()`);

  console.log('=== CONSOLE DA PAGINA ===');
  console.log(mensagens.length ? mensagens.join('\n') : '(nada)');
  console.log('\n=== RESULTADO ===');
  console.log(JSON.stringify(resultado, null, 2));

  fs.writeFileSync(
    path.join(__dirname, 'tela-depois.png'),
    (await janela.webContents.capturePage()).toPNG()
  );

  app.quit();
});

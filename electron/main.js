'use strict';

const { app, BrowserWindow, session, shell, globalShortcut } = require('electron');
const path = require('path');

// Fixa o nome antes de perguntar qualquer caminho. Sem isso o Electron chama o
// app de "Electron" quando iniciado por arquivo em vez de por pasta, e os
// modelos vao parar numa pasta diferente da que o app depois procura.
app.setName('voz-tts');

const motores = require('./tts');
const modelosVoz = require('./voz/modelos');
const ipc = require('./ipc');

const pastaDados = app.getPath('userData');
const pastaMotores = path.join(pastaDados, 'motores');
motores.piper.definirRaiz(pastaMotores);
modelosVoz.definirRaiz(pastaMotores);

const ehDev = process.argv.includes('--dev');
let janela = null;
let sessaoVoz = null;

function criarJanela() {
  janela = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 760,
    minHeight: 600,
    backgroundColor: '#12141a',
    title: 'Voz TTS',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  janela.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  if (ehDev) janela.webContents.openDevTools({ mode: 'detach' });

  // Links externos abrem no navegador de verdade, nunca dentro do app.
  janela.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  janela.on('closed', () => {
    janela = null;
    // O reconhecedor segura centenas de MB; sem soltar aqui, fechar a janela
    // no macOS (onde o app continua vivo) deixaria a memoria presa.
    if (sessaoVoz) sessaoVoz.parar();
  });
}

app.whenReady().then(() => {
  // Sem isso o Chromium esconde os nomes dos dispositivos de audio, e as listas
  // viram "Dispositivo 1, Dispositivo 2" -- inutil pra escolher o cabo.
  session.defaultSession.setPermissionRequestHandler((_conteudo, permissao, permitir) => {
    permitir(permissao === 'media' || permissao === 'audioCapture');
  });

  ({ sessaoVoz } = ipc.registrar({ pastaDados }));

  criarJanela();

  // No modo Digitar fala o que estiver na caixa; no Ao vivo liga/desliga o
  // microfone. Funciona com o app atras do jogo.
  const registrou = globalShortcut.register('CommandOrControl+Shift+Space', () => {
    if (janela) janela.webContents.send('atalho:falar');
  });
  if (!registrou) console.warn('nao consegui registrar o atalho global');

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) criarJanela();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (sessaoVoz) sessaoVoz.parar();
  // Os processos do Piper ficam vivos entre as falas; sem isso sobrariam
  // piper.exe orfaos depois de fechar o app.
  motores.piper.encerrarTudo();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

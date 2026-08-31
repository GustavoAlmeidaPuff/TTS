'use strict';

/**
 * Base dos arranjos de teste.
 *
 * Sobe a tela real, com o preload real e os handlers de IPC reais (os mesmos
 * que o app usa -- ver electron/ipc.js). Nada aqui e imitacao: se o teste passa,
 * o app funciona; se o app quebra, o teste quebra junto.
 */

const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const fs = require('fs');

const RAIZ = path.join(__dirname, '..');

app.setName('voz-tts');

/**
 * Prepara o app e devolve a janela pronta, com o console ja sendo gravado.
 * @param {{esperaMs?: number}} [opcoes]
 */
async function abrirApp(opcoes = {}) {
  const motores = require(path.join(RAIZ, 'electron', 'tts'));
  const modelosVoz = require(path.join(RAIZ, 'electron', 'voz', 'modelos'));
  const ipc = require(path.join(RAIZ, 'electron', 'ipc'));

  await app.whenReady();

  const pastaDados = app.getPath('userData');
  const pastaMotores = path.join(pastaDados, 'motores');
  motores.piper.definirRaiz(pastaMotores);
  modelosVoz.definirRaiz(pastaMotores);

  session.defaultSession.setPermissionRequestHandler((_c, permissao, permitir) =>
    permitir(permissao === 'media' || permissao === 'audioCapture')
  );

  const { sessaoVoz } = ipc.registrar({ pastaDados });

  const janela = new BrowserWindow({
    width: 1100,
    height: 800,
    show: false,
    backgroundColor: '#12141a',
    webPreferences: {
      preload: path.join(RAIZ, 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const mensagens = [];
  janela.webContents.on('console-message', (_e, nivel, msg) =>
    mensagens.push(`[${['log', 'aviso', 'ERRO'][nivel] || nivel}] ${msg}`)
  );

  await janela.loadFile(path.join(RAIZ, 'src', 'index.html'));
  await esperar(opcoes.esperaMs ?? 9000);

  return { janela, mensagens, sessaoVoz, pastaMotores };
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/** Grava a tela num PNG dentro de testes/. */
async function fotografar(janela, nome) {
  const destino = path.join(__dirname, nome);
  fs.writeFileSync(destino, (await janela.webContents.capturePage()).toPNG());
  return destino;
}

function relatar(titulo, mensagens, dados) {
  console.log('=== CONSOLE DA PAGINA ===');
  console.log(mensagens.length ? mensagens.join('\n') : '(nada)');
  console.log(`\n=== ${titulo} ===`);
  console.log(JSON.stringify(dados, null, 2));
}

module.exports = { abrirApp, esperar, fotografar, relatar, RAIZ };

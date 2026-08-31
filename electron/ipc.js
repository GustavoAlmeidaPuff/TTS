'use strict';

/**
 * Todos os canais entre a interface e o processo principal, num lugar so.
 *
 * Fica separado do main.js de proposito: os arranjos de teste em `testes/`
 * precisam exatamente destes handlers, e antes eles reimplementavam cada um.
 * Cada canal novo virava duas implementacoes que iam divergindo em silencio --
 * e um teste que exercita uma imitacao do app nao testa o app.
 */

const { ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const motores = require('./tts');
const { Sessao } = require('./voz');
const modelosVoz = require('./voz/modelos');

/** Sites que o app tem permissao de abrir no navegador de verdade. */
const LINKS_PERMITIDOS = ['https://vb-audio.com/Cable/', 'https://github.com/rhasspy/piper'];

/**
 * @param {{pastaDados: string, sessaoVoz?: Sessao}} opcoes
 * @returns {{sessaoVoz: Sessao}}
 */
function registrar({ pastaDados, sessaoVoz = new Sessao() }) {
  const arquivoConfig = () => path.join(pastaDados, 'config.json');

  const lerConfig = () => {
    try {
      return JSON.parse(fs.readFileSync(arquivoConfig(), 'utf8'));
    } catch (_) {
      return {};
    }
  };

  const salvarConfig = (config) => {
    try {
      fs.mkdirSync(path.dirname(arquivoConfig()), { recursive: true });
      fs.writeFileSync(arquivoConfig(), JSON.stringify(config, null, 2), 'utf8');
      return true;
    } catch (e) {
      console.error('nao consegui salvar config:', e.message);
      return false;
    }
  };

  // ------------------------------------------------------------- texto -> voz

  ipcMain.handle('tts:motores', async () => motores.listarMotores());

  ipcMain.handle('tts:vozes', async (_evento, motor) => {
    try {
      return { ok: true, vozes: await motores.listarVozes(motor) };
    } catch (e) {
      return { ok: false, erro: e.message };
    }
  });

  ipcMain.handle('tts:falar', async (_evento, pedido) => {
    try {
      const { audio, mime } = await motores.sintetizar(pedido);
      // Buffer vira Uint8Array na travessia; o outro lado remonta o Blob.
      return { ok: true, audio: new Uint8Array(audio), mime };
    } catch (e) {
      return { ok: false, erro: e.message };
    }
  });

  ipcMain.handle('piper:status', async () => motores.piper.status());

  ipcMain.handle('piper:instalar', async (evento, idVoz) => {
    try {
      await motores.piper.instalar(idVoz, (p) => evento.sender.send('piper:progresso', p));
      return { ok: true };
    } catch (e) {
      return { ok: false, erro: e.message };
    }
  });

  // -------------------------------------------------------------- voz ao vivo

  ipcMain.handle('voz:modelos', async () => modelosVoz.status());

  ipcMain.handle('voz:instalarModelo', async (evento, id) => {
    try {
      await modelosVoz.instalar(id, (p) => evento.sender.send('voz:progresso', p));
      return { ok: true };
    } catch (e) {
      return { ok: false, erro: e.message };
    }
  });

  ipcMain.handle('voz:iniciar', async (evento, opcoes) => {
    try {
      sessaoVoz.removeAllListeners();
      const paraTela = (canal) => (dados) => {
        if (!evento.sender.isDestroyed()) evento.sender.send(canal, dados);
      };
      sessaoVoz.on('trecho', paraTela('voz:trecho'));
      sessaoVoz.on('parcial', paraTela('voz:parcial'));
      sessaoVoz.on('fimDeTrecho', paraTela('voz:fimDeTrecho'));

      return { ok: true, ...sessaoVoz.iniciar(opcoes) };
    } catch (e) {
      return { ok: false, erro: e.message };
    }
  });

  ipcMain.handle('voz:parar', async () => {
    sessaoVoz.parar();
    return { ok: true };
  });

  ipcMain.handle('voz:estado', async () => sessaoVoz.estado());

  // Chega ~10 vezes por segundo com o microfone ligado, entao e `on` e nao
  // `handle`: nao ha resposta pra esperar, e cada ida e volta custaria caro.
  ipcMain.on('voz:audio', (_evento, amostras) => {
    try {
      sessaoVoz.alimentar(amostras instanceof Float32Array ? amostras : new Float32Array(amostras));
    } catch (e) {
      console.error('falha ao processar audio do microfone:', e.message);
    }
  });

  ipcMain.on('voz:encerrarTrecho', () => sessaoVoz.encerrarTrecho());

  // ------------------------------------------------------------------ ajustes

  ipcMain.handle('config:ler', async () => lerConfig());
  ipcMain.handle('config:salvar', async (_evento, config) => salvarConfig(config));

  ipcMain.handle('app:abrirLink', async (_evento, url) => {
    if (LINKS_PERMITIDOS.includes(url)) await shell.openExternal(url);
  });

  return { sessaoVoz };
}

module.exports = { registrar };

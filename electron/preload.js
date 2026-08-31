'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Ponte estreita de proposito: a interface so enxerga estas funcoes, nunca o
// Node inteiro.
contextBridge.exposeInMainWorld('api', {
  listarMotores: () => ipcRenderer.invoke('tts:motores'),
  listarVozes: (motor) => ipcRenderer.invoke('tts:vozes', motor),
  falar: (pedido) => ipcRenderer.invoke('tts:falar', pedido),

  piperStatus: () => ipcRenderer.invoke('piper:status'),
  piperInstalar: (idVoz) => ipcRenderer.invoke('piper:instalar', idVoz),
  aoProgressoPiper: (callback) => {
    const fn = (_evento, dados) => callback(dados);
    ipcRenderer.on('piper:progresso', fn);
    return () => ipcRenderer.removeListener('piper:progresso', fn);
  },

  // ------------------------------------------------------------ voz ao vivo
  vozModelos: () => ipcRenderer.invoke('voz:modelos'),
  vozInstalarModelo: (id) => ipcRenderer.invoke('voz:instalarModelo', id),
  vozIniciar: (opcoes) => ipcRenderer.invoke('voz:iniciar', opcoes),
  vozParar: () => ipcRenderer.invoke('voz:parar'),
  vozEstado: () => ipcRenderer.invoke('voz:estado'),

  /** Manda um bloco de audio do microfone. Sem resposta, de proposito. */
  vozAudio: (amostras) => ipcRenderer.send('voz:audio', amostras),
  vozEncerrarTrecho: () => ipcRenderer.send('voz:encerrarTrecho'),

  aoTrecho: (callback) => {
    const fn = (_e, dados) => callback(dados);
    ipcRenderer.on('voz:trecho', fn);
    return () => ipcRenderer.removeListener('voz:trecho', fn);
  },
  aoParcial: (callback) => {
    const fn = (_e, dados) => callback(dados);
    ipcRenderer.on('voz:parcial', fn);
    return () => ipcRenderer.removeListener('voz:parcial', fn);
  },
  aoProgressoVoz: (callback) => {
    const fn = (_e, dados) => callback(dados);
    ipcRenderer.on('voz:progresso', fn);
    return () => ipcRenderer.removeListener('voz:progresso', fn);
  },

  lerConfig: () => ipcRenderer.invoke('config:ler'),
  salvarConfig: (config) => ipcRenderer.invoke('config:salvar', config),

  abrirLink: (url) => ipcRenderer.invoke('app:abrirLink', url),

  aoAtalhoFalar: (callback) => {
    ipcRenderer.on('atalho:falar', () => callback());
  },
});

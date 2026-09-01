'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rvc', {
  pronto: () => ipcRenderer.invoke('rvc:pronto'),
  vozes: () => ipcRenderer.invoke('rvc:vozes'),
  trocarVoz: (id) => ipcRenderer.invoke('rvc:trocarVoz', id),
  converter: (amostras, opcoes) => ipcRenderer.invoke('rvc:converter', amostras, opcoes),
  vivoIniciar: (opcoes) => ipcRenderer.invoke('rvc:vivoIniciar', opcoes),
  vivoAudio: (amostras) => ipcRenderer.send('rvc:vivoAudio', amostras),
  vivoParar: () => ipcRenderer.invoke('rvc:vivoParar'),
  vivoEstado: () => ipcRenderer.invoke('rvc:vivoEstado'),
  aoBloco: (cb) => {
    const fn = (_e, d) => cb(d);
    ipcRenderer.on('rvc:bloco', fn);
    return () => ipcRenderer.removeListener('rvc:bloco', fn);
  },
  aoVivoErro: (cb) => ipcRenderer.on('rvc:vivoErro', (_e, m) => cb(m)),

  salvar: (orig, taxaOrig, conv, taxaConv) =>
    ipcRenderer.invoke('rvc:salvar', orig, taxaOrig, conv, taxaConv),
});

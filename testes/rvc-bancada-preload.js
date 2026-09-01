'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rvc', {
  pronto: () => ipcRenderer.invoke('rvc:pronto'),
  vozes: () => ipcRenderer.invoke('rvc:vozes'),
  trocarVoz: (id) => ipcRenderer.invoke('rvc:trocarVoz', id),
  converter: (amostras, opcoes) => ipcRenderer.invoke('rvc:converter', amostras, opcoes),
  salvar: (orig, taxaOrig, conv, taxaConv) =>
    ipcRenderer.invoke('rvc:salvar', orig, taxaOrig, conv, taxaConv),
});

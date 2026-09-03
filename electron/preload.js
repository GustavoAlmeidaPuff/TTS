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

  // ----------------------------------------------------- troca de timbre
  rvcStatus: () => ipcRenderer.invoke('rvc:status'),
  rvcInstalar: (idVoz) => ipcRenderer.invoke('rvc:instalar', idVoz),
  rvcCarregar: (idVoz) => ipcRenderer.invoke('rvc:carregar', idVoz),
  rvcAquecer: (blocoS) => ipcRenderer.invoke('rvc:aquecer', blocoS),
  rvcVivoIniciar: (opcoes) => ipcRenderer.invoke('rvc:vivoIniciar', opcoes),
  rvcVivoParar: () => ipcRenderer.invoke('rvc:vivoParar'),
  rvcLiberar: () => ipcRenderer.invoke('rvc:liberar'),

  /** Manda um bloco de audio do microfone. Sem resposta, de proposito. */
  rvcAudio: (amostras) => ipcRenderer.send('rvc:audio', amostras),

  aoBlocoRvc: (callback) => {
    const fn = (_e, dados) => callback(dados);
    ipcRenderer.on('rvc:bloco', fn);
    return () => ipcRenderer.removeListener('rvc:bloco', fn);
  },
  aoProgressoRvc: (callback) => {
    const fn = (_e, dados) => callback(dados);
    ipcRenderer.on('rvc:progresso', fn);
    return () => ipcRenderer.removeListener('rvc:progresso', fn);
  },
  aoErroRvc: (callback) => ipcRenderer.on('rvc:vivoErro', (_e, m) => callback(m)),

  // ------------------------------------------------------------- efeitos
  efeitosEscolherPasta: () => ipcRenderer.invoke('efeitos:escolherPasta'),
  efeitosListar: (pasta) => ipcRenderer.invoke('efeitos:listar', pasta),
  efeitosLer: (caminho) => ipcRenderer.invoke('efeitos:ler', caminho),

  lerConfig: () => ipcRenderer.invoke('config:ler'),
  salvarConfig: (config) => ipcRenderer.invoke('config:salvar', config),

  abrirLink: (url) => ipcRenderer.invoke('app:abrirLink', url),

  aoAtalhoFalar: (callback) => {
    ipcRenderer.on('atalho:falar', () => callback());
  },
});

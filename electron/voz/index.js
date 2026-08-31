'use strict';

/**
 * Sessao de voz ao vivo: recebe audio do microfone (mandado pela interface),
 * reconhece continuamente, e devolve trechos de texto prontos pra falar.
 *
 * Vive no processo principal porque o reconhecedor e um modulo nativo pesado;
 * deixar ele na interface travaria a tela a cada bloco de audio.
 */

const { EventEmitter } = require('events');
const modelos = require('./modelos');
const { Reconhecedor } = require('./reconhecedor');

class Sessao extends EventEmitter {
  constructor() {
    super();
    this.reconhecedor = null;
    this.idModelo = null;
    this.blocos = 0;
    this.amostras = 0;
  }

  get ativa() {
    return this.reconhecedor !== null;
  }

  /**
   * Liga o reconhecimento.
   * @param {{modelo?: string, pausaFinalS?: number, numThreads?: number}} opcoes
   */
  iniciar(opcoes = {}) {
    if (this.reconhecedor) this.parar();

    const idModelo = opcoes.modelo || 'multi';
    const arquivos = modelos.localizarArquivos(idModelo);
    if (!arquivos) {
      throw new Error(`o reconhecedor "${idModelo}" ainda nao foi baixado`);
    }

    const t0 = Date.now();
    this.reconhecedor = new Reconhecedor(arquivos, {
      pausaFinalS: opcoes.pausaFinalS ?? 0.8,
      numThreads: opcoes.numThreads ?? 2,
    });
    this.idModelo = idModelo;
    this.blocos = 0;
    this.amostras = 0;

    this.reconhecedor.on('trecho', (t) => this.emit('trecho', t));
    this.reconhecedor.on('parcial', (p) => this.emit('parcial', p));
    this.reconhecedor.on('fimDeTrecho', () => this.emit('fimDeTrecho'));

    return { modelo: idModelo, carregouEmMs: Date.now() - t0 };
  }

  /**
   * Entrega um bloco de audio do microfone.
   * @param {Float32Array} amostras mono, 16 kHz
   */
  alimentar(amostras) {
    if (!this.reconhecedor) return;
    this.blocos++;
    this.amostras += amostras.length;
    this.reconhecedor.alimentar(amostras);
  }

  /** Fecha a frase atual sem desligar a sessao (usado no "parar de falar"). */
  encerrarTrecho() {
    if (this.reconhecedor) this.reconhecedor.encerrarTrecho();
  }

  parar() {
    if (!this.reconhecedor) return;
    try {
      this.reconhecedor.encerrarTrecho();
    } catch (_) {
      /* se ja estava quebrado, nao adianta insistir */
    }
    this.reconhecedor.removeAllListeners();
    this.reconhecedor.liberar();
    this.reconhecedor = null;
  }

  estado() {
    return {
      ativa: this.ativa,
      modelo: this.idModelo,
      blocos: this.blocos,
      segundosDeAudio: +(this.amostras / 16000).toFixed(1),
    };
  }
}

module.exports = { Sessao, modelos };

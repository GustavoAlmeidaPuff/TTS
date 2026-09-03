'use strict';

/**
 * Sessao de troca de timbre do app: cuida do ciclo de vida do conversor.
 *
 * Existe porque carregar as tres redes leva ~4s e ocupa memoria de GPU. Fazer
 * isso a cada vez que o usuario aperta "falar" seria insuportavel, e deixar
 * carregado pra sempre seguraria a placa mesmo com o modo desligado.
 *
 * Entao: carrega na primeira vez que se usa, mantem carregado enquanto o modo
 * estiver aberto, e troca so o gerador quando muda a voz (o resto nao depende
 * dela).
 */

const { EventEmitter } = require('events');

const modelos = require('./modelos');
const { Conversor } = require('./index');
const { Streaming } = require('./streaming');

class SessaoRvc extends EventEmitter {
  constructor() {
    super();
    this.conversor = null;
    this.streaming = null;
    this.vozAtual = null;
  }

  get carregado() {
    return this.conversor !== null;
  }

  get aoVivo() {
    return this.streaming !== null;
  }

  /**
   * Garante o conversor carregado com a voz pedida.
   * @param {string} idVoz
   * @param {(p: object) => void} [aoProgresso]
   */
  async garantir(idVoz, aoProgresso) {
    const arquivos = modelos.arquivosDaVoz(idVoz);
    if (!arquivos) throw new Error(`os modelos da voz "${idVoz}" ainda nao foram baixados`);

    if (this.conversor && this.vozAtual === idVoz) return this.info();

    if (this.conversor) {
      // So o gerador muda: as duas redes pesadas continuam de pe.
      await this.conversor.trocarGerador(arquivos.gerador);
      this.vozAtual = idVoz;
      return this.info();
    }

    const conversor = new Conversor(arquivos, { cacheDispositivo: modelos.cacheGpu() });
    await conversor.carregar(aoProgresso);
    this.conversor = conversor;
    this.vozAtual = idVoz;
    return this.info();
  }

  info() {
    return {
      voz: this.vozAtual,
      semGpu: Boolean(this.conversor && this.conversor.semGpu),
      dispositivo: this.conversor ? this.conversor.dispositivo : null,
      gpusMedidas: this.conversor ? this.conversor.gpusMedidas : [],
    };
  }

  /**
   * Roda algumas conversoes de mentira pra placa compilar os grafos.
   *
   * Sem isso as duas primeiras conversoes de verdade custam o dobro, e como
   * elas chegam com o microfone ja aberto, o atraso delas fica preso na agenda
   * de reproducao pelo resto da sessao.
   */
  async aquecer(blocoS = 0.75) {
    if (!this.conversor) return;
    const n = Math.round(16000 * (blocoS + 0.43));
    const mudo = new Float32Array(n);
    // Um tom baixinho, e nao silencio: silencio nao ativa o detector de melodia,
    // e e justamente ele um dos caminhos que precisam ser compilados.
    for (let i = 0; i < n; i++) mudo[i] = 0.05 * Math.sin((2 * Math.PI * 120 * i) / 16000);
    for (let i = 0; i < 3; i++) {
      await this.conversor.converter(mudo, { tomAlvo: 220 }).catch(() => {});
    }
  }

  /** Converte um trecho fechado (usado no botao de testar). */
  async converter(amostras, opcoes) {
    if (!this.conversor) throw new Error('o conversor ainda nao foi carregado');
    return this.conversor.converter(amostras, opcoes || {});
  }

  /**
   * Liga o modo continuo. Emite 'bloco' a cada pedaco convertido.
   * @param {{blocoS?: number, tomAlvo?: number, semitons?: number}} opcoes
   */
  iniciarAoVivo(opcoes = {}) {
    if (!this.conversor) throw new Error('o conversor ainda nao foi carregado');
    this.pararAoVivo();

    this.streaming = new Streaming(this.conversor, {
      blocoS: opcoes.blocoS ?? 0.5,
      contextoS: opcoes.contextoS ?? 0.5,
    });
    this.streaming.definirOpcoes(
      opcoes.tomAlvo ? { tomAlvo: opcoes.tomAlvo } : { semitons: opcoes.semitons || 0 }
    );
    this.streaming.on('audio', (d) => this.emit('bloco', d));
    this.streaming.on('erro', (e) => this.emit('erro', e));
  }

  alimentar(amostras) {
    if (this.streaming) this.streaming.alimentar(amostras);
  }

  pararAoVivo() {
    if (!this.streaming) return;
    this.streaming.removeAllListeners();
    this.streaming.encerrar();
    this.streaming = null;
  }

  /** Solta a GPU. Chamado ao fechar o app ou ao sair do modo por muito tempo. */
  async liberar() {
    this.pararAoVivo();
    if (this.conversor) {
      await this.conversor.liberar();
      this.conversor = null;
      this.vozAtual = null;
    }
  }
}

module.exports = { SessaoRvc, modelos };

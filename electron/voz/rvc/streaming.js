'use strict';

/**
 * Conversao de voz continua: microfone entrando sem parar, voz trocada saindo
 * sem parar.
 *
 * ---------------------------------------------------------------------------
 * Por que nao basta cortar em pedacos e converter cada um
 * ---------------------------------------------------------------------------
 * As tres redes olham o audio em contexto. Um pedaco de 0,5s convertido sozinho
 * comeca "do nada": o extrator de conteudo nao sabe que som veio antes, o
 * detector de melodia idem. O resultado tem a borda inicial errada, e como isso
 * se repete a cada bloco, a voz sai com um tique ritmado.
 *
 * Entao cada conversao recebe [CONTEXTO | BLOCO NOVO] e joga fora a parte do
 * contexto na saida. Paga-se converter mais audio do que se usa -- e o preco de
 * ter borda limpa.
 *
 * Mesmo assim as emendas nao casam perfeitamente (a rede tem componente
 * aleatoria), entao as bordas ainda sao costuradas com um cruzamento suave.
 *
 *   bloco 1:  [-- contexto --][=== usa ===]
 *   bloco 2:            [-- contexto --][=== usa ===]
 *                                     ^^^ cruza aqui
 * ---------------------------------------------------------------------------
 */

const { EventEmitter } = require('events');

const TAXA_ENTRADA = 16000;

class Streaming extends EventEmitter {
  /**
   * @param {import('./index').Conversor} conversor ja carregado
   * @param {{blocoS?: number, contextoS?: number, cruzamentoS?: number}} [opcoes]
   */
  constructor(conversor, opcoes = {}) {
    super();
    this.conversor = conversor;

    /** Quanto audio novo cada conversao entrega. Define o atraso minimo. */
    this.blocoS = opcoes.blocoS ?? 0.5;
    /** Quanto de passado vai junto so pra dar contexto (e depois e descartado). */
    this.contextoS = opcoes.contextoS ?? 0.5;
    /** Trecho costurado entre um bloco e o proximo. */
    this.cruzamentoS = opcoes.cruzamentoS ?? 0.04;

    this.amostrasPorBloco = Math.round(TAXA_ENTRADA * this.blocoS);
    this.amostrasContexto = Math.round(TAXA_ENTRADA * this.contextoS);

    this._reiniciar();
  }

  _reiniciar() {
    /** Audio de entrada ainda nao convertido. */
    this.pendente = new Float32Array(0);
    /** Ultimas amostras ja convertidas, guardadas como contexto do proximo bloco. */
    this.contexto = new Float32Array(0);
    /** Cauda da saida anterior, pra costurar com o comeco da proxima. */
    this.cauda = null;
    this.ocupado = false;
    this.blocos = 0;
    this.atrasados = 0;
    this.taxaSaida = null;
  }

  /**
   * Entrega audio do microfone. Emite 'audio' quando um bloco fica pronto.
   * @param {Float32Array} amostras mono, 16 kHz
   */
  alimentar(amostras) {
    const junto = new Float32Array(this.pendente.length + amostras.length);
    junto.set(this.pendente);
    junto.set(amostras, this.pendente.length);
    this.pendente = junto;

    if (this.pendente.length >= this.amostrasPorBloco) this._processar();
  }

  async _processar() {
    // Uma conversao por vez: sao a mesma GPU e a mesma sessao.
    if (this.ocupado) return;

    const bloco = this.pendente.subarray(0, this.amostrasPorBloco);
    this.pendente = this.pendente.slice(this.amostrasPorBloco);

    this.ocupado = true;
    const t0 = Date.now();

    try {
      // [contexto | bloco novo]
      const janela = new Float32Array(this.contexto.length + bloco.length);
      janela.set(this.contexto);
      janela.set(bloco, this.contexto.length);

      const r = await this.conversor.converter(janela, this.opcoesConversao || {});
      this.taxaSaida = r.taxa;

      // Descarta a parte da saida que corresponde ao contexto.
      const escala = r.taxa / TAXA_ENTRADA;
      const inicioUtil = Math.round(this.contexto.length * escala);
      let util = r.audio.subarray(Math.min(inicioUtil, r.audio.length));

      util = this._costurar(util, Math.round(this.cruzamentoS * r.taxa));

      // O bloco de agora vira contexto do proximo.
      const novoContexto = new Float32Array(this.contexto.length + bloco.length);
      novoContexto.set(this.contexto);
      novoContexto.set(bloco, this.contexto.length);
      this.contexto = novoContexto.slice(Math.max(0, novoContexto.length - this.amostrasContexto));

      this.blocos++;
      const gasto = Date.now() - t0;
      const orcamento = this.blocoS * 1000;
      if (gasto > orcamento) this.atrasados++;

      this.emit('audio', {
        audio: util,
        taxa: r.taxa,
        gastoMs: gasto,
        folgaMs: Math.round(orcamento - gasto),
        tom: r.tom,
      });
    } catch (e) {
      this.emit('erro', e);
    } finally {
      this.ocupado = false;
      // Chegou audio enquanto convertia: vai de novo, sem esperar o proximo.
      if (this.pendente.length >= this.amostrasPorBloco) this._processar();
    }
  }

  /**
   * Costura o comeco deste bloco com a cauda do anterior.
   *
   * Sem isso ha um degrau na emenda a cada bloco, que se ouve como um clique
   * ritmado -- mais irritante que o proprio defeito que ele denuncia.
   */
  _costurar(audio, nCruz) {
    if (!nCruz || audio.length <= nCruz) {
      this.cauda = null;
      return audio;
    }

    const saida = Float32Array.from(audio);

    if (this.cauda && this.cauda.length === nCruz) {
      for (let i = 0; i < nCruz; i++) {
        // Cosseno em vez de rampa reta: mantem a energia constante na emenda,
        // entao nao se ouve um "afundado" no meio do cruzamento.
        const t = i / nCruz;
        const peso = 0.5 - 0.5 * Math.cos(Math.PI * t);
        saida[i] = this.cauda[i] * (1 - peso) + saida[i] * peso;
      }
    }

    // Guarda a cauda e nao a entrega ainda: ela sera misturada no proximo bloco.
    this.cauda = saida.slice(saida.length - nCruz);
    return saida.subarray(0, saida.length - nCruz);
  }

  /** Ajustes repassados a cada conversao (voz alvo, tom etc). */
  definirOpcoes(opcoes) {
    this.opcoesConversao = opcoes;
  }

  /** Solta o que sobrou e limpa o estado. */
  encerrar() {
    const resto = this.cauda;
    this._reiniciar();
    return resto;
  }

  estado() {
    return {
      blocos: this.blocos,
      atrasados: this.atrasados,
      pendenteMs: Math.round((this.pendente.length / TAXA_ENTRADA) * 1000),
      taxaSaida: this.taxaSaida,
    };
  }
}

module.exports = { Streaming, TAXA_ENTRADA };

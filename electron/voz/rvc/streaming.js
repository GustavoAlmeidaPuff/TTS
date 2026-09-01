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
    this.amostrasCruzamento = Math.round(TAXA_ENTRADA * this.cruzamentoS);
    // Margem de sobra na janela. O conversor devolve alguns quadros a menos do
    // que a duracao da entrada (o extrator de conteudo perde as bordas), entao
    // pedir exatamente o necessario deixa faltando -- e o que faltava virava
    // deriva: a saida encurtava 7,5% e a voz terminava antes da pessoa.
    this.amostrasMargem = Math.round(TAXA_ENTRADA * 0.08);

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

    // Espera o bloco MAIS o pedaco extra que sera cruzado com o proximo.
    if (this.pendente.length >= this.amostrasPorBloco + this.amostrasCruzamento + this.amostrasMargem) {
      this._processar();
    }
  }

  async _processar() {
    // Uma conversao por vez: sao a mesma GPU e a mesma sessao.
    if (this.ocupado) return;

    // Converte [bloco | cruzamento], mas AVANCA so o bloco. Assim o pedaco do
    // cruzamento e convertido duas vezes -- uma como cauda deste bloco, outra
    // como cabeca do proximo -- e ha material de verdade pra sobrepor.
    //
    // A primeira versao segurava a cauda sem repor: cada bloco entregava menos
    // audio do que consumia, e a saida ia encurtando 14,6%. Num minuto de fala
    // a voz terminaria 9 segundos antes da pessoa.
    const totalNovo = this.amostrasPorBloco + this.amostrasCruzamento + this.amostrasMargem;
    const novoAudio = this.pendente.subarray(0, totalNovo);
    this.pendente = this.pendente.slice(this.amostrasPorBloco);

    this.ocupado = true;
    const t0 = Date.now();

    try {
      const janela = new Float32Array(this.contexto.length + novoAudio.length);
      janela.set(this.contexto);
      janela.set(novoAudio, this.contexto.length);

      const r = await this.conversor.converter(janela, this.opcoesConversao || {});
      this.taxaSaida = r.taxa;

      const escala = r.taxa / TAXA_ENTRADA;
      const inicioUtil = Math.round(this.contexto.length * escala);
      const util = r.audio.subarray(Math.min(inicioUtil, r.audio.length));

      // O alvo vem do que se QUER entregar, e nao do que sobrou -- assim um
      // quadro a mais ou a menos na conversao nao vira deriva acumulada.
      const nCruz = Math.round(this.amostrasCruzamento * escala);
      const nBloco = Math.round(this.amostrasPorBloco * escala);
      const pronto = this._costurar(util, nBloco, nCruz);

      // O que foi consumido vira contexto do proximo -- so a parte que avancou.
      const avancou = novoAudio.subarray(0, this.amostrasPorBloco);
      const novoContexto = new Float32Array(this.contexto.length + avancou.length);
      novoContexto.set(this.contexto);
      novoContexto.set(avancou, this.contexto.length);
      this.contexto = novoContexto.slice(Math.max(0, novoContexto.length - this.amostrasContexto));

      this.blocos++;
      const gasto = Date.now() - t0;
      const orcamento = this.blocoS * 1000;
      if (gasto > orcamento) this.atrasados++;

      this.emit('audio', {
        audio: pronto,
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
      if (this.pendente.length >= totalNovo) this._processar();
    }
  }

  /**
   * Mistura a cauda do bloco anterior na cabeca deste, e entrega um bloco
   * inteiro.
   *
   * `audio` cobre [bloco | cruzamento]. O cruzamento do fim e o MESMO trecho de
   * tempo que a cabeca do proximo bloco vai cobrir -- e por isso os dois podem
   * ser misturados sem perder nem repetir nada.
   *
   * @param {Float32Array} audio saida convertida, ja sem a parte do contexto
   * @param {number} nBloco quantas amostras valem um bloco
   * @param {number} nCruz  quantas amostras se sobrepoem
   * @returns {Float32Array} exatamente nBloco amostras
   */
  _costurar(audio, nBloco, nCruz) {
    if (!nCruz || audio.length <= nCruz) {
      this.cauda = null;
      return Float32Array.from(audio);
    }

    const saida = Float32Array.from(audio.subarray(0, nBloco));

    if (this.cauda && this.cauda.length >= nCruz) {
      for (let i = 0; i < nCruz && i < saida.length; i++) {
        // Cosseno em vez de rampa reta: as duas metades somam energia constante,
        // entao nao se ouve um "afundado" no meio da emenda.
        const peso = 0.5 - 0.5 * Math.cos((Math.PI * i) / nCruz);
        saida[i] = this.cauda[i] * (1 - peso) + saida[i] * peso;
      }
    }

    // A cauda cobre o mesmo tempo que a cabeca do proximo bloco vai cobrir.
    this.cauda = Float32Array.from(audio.subarray(nBloco, nBloco + nCruz));
    return saida;
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

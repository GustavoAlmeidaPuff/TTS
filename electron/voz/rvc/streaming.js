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
 *
 * ---------------------------------------------------------------------------
 * O portao de silencio, que nao e economia: e correcao
 * ---------------------------------------------------------------------------
 * O gerador e um vocoder. Alimentado com silencio ele NAO devolve silencio --
 * ele inventa voz, porque a entrada dele inclui ruido gaussiano e a rede sempre
 * produz alguma coisa. Sem portao, o modo timbre ficava murmurando sozinho no
 * meio do jogo, com a pessoa calada.
 *
 * Entao o bloco e medido antes de converter, em quadros de 50ms:
 *
 *   - nenhum quadro com voz  -> nao converte nada (e a GPU descansa);
 *   - algum quadro com voz   -> converte o bloco inteiro e, na saida, abaixa
 *                               so os trechos que estavam calados na entrada.
 *
 * A folga de 200ms de cada lado de cada quadro com voz existe pra o portao
 * nunca comer o comeco nem o fim de uma palavra: so silencio de mais de 400ms
 * seguidos chega a ser cortado, e nenhuma consoante surda dura tanto.
 * ---------------------------------------------------------------------------
 */

const { EventEmitter } = require('events');

const TAXA_ENTRADA = 16000;

/** Tamanho do quadro em que o nivel e medido. */
const QUADRO_S = 0.05;
/**
 * RMS acima disso conta como fala e nao como ruido. Mesmo valor que o
 * reconhecedor usa (ver electron/voz/reconhecedor.js) -- e o mesmo microfone,
 * na mesma taxa, medido do mesmo jeito.
 */
const LIMIAR_FALA = 0.01;
/** Quadros preservados de cada lado de um quadro com voz. 4 = 200ms. */
const MARGEM_QUADROS = 4;

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

    this.amostrasQuadro = Math.round(TAXA_ENTRADA * QUADRO_S);
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
    /** Blocos que nem chegaram a converter porque estava tudo calado. */
    this.calados = 0;
    /** Piso de ruido do ambiente, pra o corte nao ser fixo. Ver _mapaDeVoz. */
    this.ruido = 0;
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
    // Sai de `novoAudio`, que e uma vista do buffer ANTIGO de pendente -- o
    // `slice` acima copiou, entao esta vista continua valida.
    const avancou = novoAudio.subarray(0, this.amostrasPorBloco);

    try {
      const mapa = this._mapaDeVoz(novoAudio);

      // Tudo calado: nada a converter. Guarda o contexto assim mesmo (o proximo
      // bloco precisa saber que veio silencio antes) e avisa a tela, que usa
      // isso pra nao empurrar um buraco pra dentro da agenda de reproducao.
      if (!mapa.algumaVoz) {
        this._guardarContexto(avancou);
        this.cauda = null; // nao se costura por cima de um buraco
        this.calados++;
        this.emit('audio', {
          audio: null,
          silencio: true,
          taxa: this.taxaSaida,
          gastoMs: Date.now() - t0,
          folgaMs: Math.round(this.blocoS * 1000 - (Date.now() - t0)),
          nivel: mapa.pico,
          limiar: mapa.limiar,
        });
        return;
      }

      const janela = new Float32Array(this.contexto.length + novoAudio.length);
      janela.set(this.contexto);
      janela.set(novoAudio, this.contexto.length);

      const r = await this.conversor.converter(janela, this.opcoesConversao || {});
      this.taxaSaida = r.taxa;

      const escala = r.taxa / TAXA_ENTRADA;
      const inicioUtil = Math.round(this.contexto.length * escala);
      const util = r.audio.subarray(Math.min(inicioUtil, r.audio.length));

      // O bloco tinha voz, mas nem todo ele: abaixa o que era pausa. Sem isso,
      // a pessoa fala no fim do bloco e os 600ms de espera antes viram murmuro.
      this._aplicarPortao(util, escala, mapa);

      // O alvo vem do que se QUER entregar, e nao do que sobrou -- assim um
      // quadro a mais ou a menos na conversao nao vira deriva acumulada.
      const nCruz = Math.round(this.amostrasCruzamento * escala);
      const nBloco = Math.round(this.amostrasPorBloco * escala);
      const pronto = this._costurar(util, nBloco, nCruz);

      // O que foi consumido vira contexto do proximo -- so a parte que avancou.
      this._guardarContexto(avancou);

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
        nivel: mapa.pico,
        limiar: mapa.limiar,
      });
    } catch (e) {
      this.emit('erro', e);
    } finally {
      this.ocupado = false;
      // Chegou audio enquanto convertia: vai de novo, sem esperar o proximo.
      if (this.pendente.length >= totalNovo) this._processar();
    }
  }

  /** Guarda o fim do que foi consumido pra servir de contexto do proximo. */
  _guardarContexto(avancou) {
    const junto = new Float32Array(this.contexto.length + avancou.length);
    junto.set(this.contexto);
    junto.set(avancou, this.contexto.length);
    this.contexto = junto.slice(Math.max(0, junto.length - this.amostrasContexto));
  }

  /**
   * Marca, quadro a quadro, onde havia voz na entrada.
   *
   * O corte acompanha o ambiente em vez de ser fixo: num quarto silencioso vale
   * o piso de `LIMIAR_FALA`, com um ventilador ligado sobe junto com o ruido --
   * senao o ventilador contaria como fala e o portao viveria aberto. O piso so
   * aprende em bloco calado; se aprendesse durante a fala, subiria ate a altura
   * da voz e acabaria cortando a pessoa.
   *
   * @param {Float32Array} amostras trecho de entrada, 16 kHz
   * @returns {{voz: Uint8Array, algumaVoz: boolean, pico: number, limiar: number}}
   */
  _mapaDeVoz(amostras) {
    const n = Math.max(1, Math.ceil(amostras.length / this.amostrasQuadro));
    const nivel = new Float32Array(n);
    for (let q = 0; q < n; q++) {
      const de = q * this.amostrasQuadro;
      const ate = Math.min(de + this.amostrasQuadro, amostras.length);
      let soma = 0;
      for (let i = de; i < ate; i++) soma += amostras[i] * amostras[i];
      nivel[q] = Math.sqrt(soma / Math.max(1, ate - de));
    }

    const limiar = Math.max(LIMIAR_FALA, this.ruido * 3);
    const bruto = new Uint8Array(n);
    let pico = 0;
    let algumaVoz = false;
    let energia = 0;
    for (let q = 0; q < n; q++) {
      if (nivel[q] > pico) pico = nivel[q];
      energia += nivel[q] * nivel[q];
      if (nivel[q] > limiar) {
        bruto[q] = 1;
        algumaVoz = true;
      }
    }

    if (!algumaVoz) {
      const medio = Math.sqrt(energia / n);
      this.ruido = this.ruido ? this.ruido * 0.95 + medio * 0.05 : medio;
      return { voz: bruto, algumaVoz: false, pico, limiar };
    }

    // Folga dos dois lados: o comeco de uma palavra sobe do nada e o fim morre
    // devagar, e nenhum dos dois pode ser cortado por estar abaixo do corte.
    const voz = new Uint8Array(n);
    for (let q = 0; q < n; q++) {
      if (!bruto[q]) continue;
      voz.fill(1, Math.max(0, q - MARGEM_QUADROS), Math.min(n, q + MARGEM_QUADROS + 1));
    }
    return { voz, algumaVoz: true, pico, limiar };
  }

  /**
   * Abaixa a saida nos trechos em que a entrada estava calada.
   *
   * O ganho e interpolado entre os centros dos quadros, entao cada transicao
   * leva 50ms -- ligar e desligar no corte seco estalaria.
   *
   * @param {Float32Array} util saida convertida (vista mutavel), ja sem contexto
   * @param {number} escala taxa de saida dividida pela de entrada
   * @param {{voz: Uint8Array}} mapa
   */
  _aplicarPortao(util, escala, mapa) {
    const porQuadro = this.amostrasQuadro * escala;
    const ultimo = mapa.voz.length - 1;
    const em = (i) => mapa.voz[Math.max(0, Math.min(ultimo, i))];

    for (let j = 0; j < util.length; j++) {
      const p = j / porQuadro - 0.5;
      const i0 = Math.floor(p);
      const ganho = em(i0) + (em(i0 + 1) - em(i0)) * (p - i0);
      if (ganho < 1) util[j] *= ganho;
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
      calados: this.calados,
      pendenteMs: Math.round((this.pendente.length / TAXA_ENTRADA) * 1000),
      taxaSaida: this.taxaSaida,
    };
  }
}

module.exports = { Streaming, TAXA_ENTRADA };

'use strict';

/**
 * Reconhecimento de fala continuo, com entrega por prefixo estavel.
 *
 * ---------------------------------------------------------------------------
 * O problema que este arquivo resolve
 * ---------------------------------------------------------------------------
 * Um reconhecedor streaming vai corrigindo o proprio palpite enquanto voce
 * fala. Ele pode dizer "I want", depois "I wanted", depois "I want it to".
 * Se a gente mandasse cada palpite direto pro TTS, a voz gaguejaria e repetiria
 * -- porque falar e irreversivel: o que ja saiu no cabo nao volta.
 *
 * Mas esperar a frase inteira acabar (que e o que a "deteccao de fim de fala"
 * faz) joga fora exatamente o que foi pedido: nao esperar voce terminar.
 *
 * A saida e entregar apenas o **prefixo estavel**: a parte do inicio do palpite
 * que parou de mudar ha tempo suficiente. Se "I want" continua igual por 400ms
 * enquanto o resto ainda oscila, "I want" ja pode ser falado com seguranca --
 * o reconhecedor praticamente nao volta atras num prefixo assentado.
 *
 * E assim que interprete simultaneo funciona, e e o que da pra fazer sem
 * inventar viagem no tempo.
 * ---------------------------------------------------------------------------
 */

const { EventEmitter } = require('events');

const TAXA = 16000; // o modelo so trabalha em 16 kHz

/**
 * @typedef {Object} Opcoes
 * @property {number} [janelaEstavelMs=400] quanto tempo um prefixo precisa ficar
 *   parado antes de ser falado. Menor = mais rapido e mais erro.
 * @property {number} [minPalavras=2] quantas palavras juntar antes de soltar.
 *   Soltar de uma em uma fica picotado; juntar demais atrasa.
 * @property {string} [lingua='pt-BR'] idioma fixo usado pelo reconhecedor.
 * @property {number} [numThreads=2]
 */

class Reconhecedor extends EventEmitter {
  /**
   * @param {{encoder:string, decoder:string, joiner:string, tokens:string}} arquivos
   * @param {Opcoes} [opcoes]
   */
  constructor(arquivos, opcoes = {}) {
    super();
    const sherpa = require('sherpa-onnx-node');

    this.janelaEstavelMs = opcoes.janelaEstavelMs ?? 400;
    this.minPalavras = opcoes.minPalavras ?? 2;
    this.margemFinal = opcoes.margemFinal ?? 2;
    this.aquecimentoS = opcoes.aquecimentoS ?? 0.2;
    this.lingua = opcoes.lingua || 'pt-BR';

    this.reconhecedor = new sherpa.OnlineRecognizer({
      featConfig: { sampleRate: TAXA, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: arquivos.encoder,
          decoder: arquivos.decoder,
          joiner: arquivos.joiner,
        },
        tokens: arquivos.tokens,
        numThreads: opcoes.numThreads ?? 2,
        provider: 'cpu',
        debug: 0,
      },
      decodingMethod: 'greedy_search',
      // A deteccao de fim de fala continua ligada, mas aqui ela nao e o que
      // dispara a fala -- serve so pra fechar o trecho e limpar o estado.
      enableEndpoint: true,
      rule1MinTrailingSilence: 2.4,
      rule2MinTrailingSilence: 0.8,
      rule3MinUtteranceLength: 20,
    });

    this.fluxo = this.reconhecedor.createStream();
    this._configurarLingua();
    this._zerarTrecho();
    this._aquecer();
  }

  _configurarLingua() {
    if (typeof this.fluxo.setOption !== 'function') {
      throw new Error('esta versão do reconhecimento não permite fixar o idioma');
    }
    this.fluxo.setOption('language', this.lingua);
  }

  /**
   * Entrega 200ms de silencio antes de qualquer audio de verdade.
   *
   * Sem isso a primeira palavra sai mutilada -- num teste, "Hello everyone"
   * virou "OW EVER ONE". O extrator de caracteristicas precisa de algumas
   * janelas pra encher o contexto, e sem elas ele come o comeco da fala.
   */
  _aquecer() {
    this.fluxo.acceptWaveform({ samples: new Float32Array(Math.round(TAXA * this.aquecimentoS)), sampleRate: TAXA });
  }

  _zerarTrecho() {
    /** palavras ja entregues (ja foram faladas, nao voltam atras) */
    this.entregues = [];
    /** ultimo palpite visto, em palavras */
    this.ultimoPalpite = [];
    /** palavra vista em cada posicao, pra saber quando aquela posicao mudou */
    this.porPosicao = [];
    /** instante da ultima mudanca em cada posicao */
    this.mudouEm = [];
  }

  /**
   * Entrega audio ao reconhecedor.
   * @param {Float32Array} amostras mono, 16 kHz, faixa -1..1
   */
  alimentar(amostras) {
    this.fluxo.acceptWaveform({ samples: amostras, sampleRate: TAXA });

    while (this.reconhecedor.isReady(this.fluxo)) {
      this.reconhecedor.decode(this.fluxo);
    }

    const texto = (this.reconhecedor.getResult(this.fluxo).text || '').trim();
    const palpite = texto ? texto.split(/\s+/) : [];

    this._avaliarPrefixo(palpite);

    if (this.reconhecedor.isEndpoint(this.fluxo)) {
      // Fim de fala: solta o que sobrou sem esperar estabilizar, porque nao vem
      // mais audio pra confirmar.
      this._entregar(palpite.length, palpite, true);
      this.reconhecedor.reset(this.fluxo);
      this._configurarLingua();
      this._zerarTrecho();
      this._aquecer();
      this.emit('fimDeTrecho');
    }
  }

  /**
   * Decide quanto do palpite ja assentou o bastante pra ser falado.
   *
   * A estabilidade e medida POR POSICAO, e nao pelo prefixo inteiro. Isso
   * importa: se medissemos o prefixo como um todo, cada palavra nova no fim
   * reiniciaria o cronometro e nada sairia enquanto voce estivesse falando --
   * exatamente o defeito que essa classe existe pra evitar.
   *
   * Alem disso, as ultimas palavras do palpite sao sempre as mais volateis
   * (e onde o reconhecedor ainda esta se decidindo), entao guardo uma margem
   * no fim que nunca e entregue de imediato.
   */
  _avaliarPrefixo(palpite) {
    const agora = Date.now();

    for (let i = 0; i < palpite.length; i++) {
      if (this.porPosicao[i] !== palpite[i]) {
        this.porPosicao[i] = palpite[i];
        this.mudouEm[i] = agora;
      }
    }
    // Se o palpite encurtou, o que sobrou do estado nao vale mais.
    this.porPosicao.length = palpite.length;
    this.mudouEm.length = palpite.length;

    const limite = palpite.length - this.margemFinal;
    let ate = this.entregues.length;
    while (ate < limite && agora - this.mudouEm[ate] >= this.janelaEstavelMs) ate++;

    this._entregar(ate, palpite, false);

    this.ultimoPalpite = palpite;
    this.emit('parcial', {
      texto: palpite.join(' '),
      entregue: this.entregues.join(' '),
    });
  }

  /**
   * Solta as palavras novas do prefixo, se valer a pena.
   * @param {number} ate quantas palavras do palpite ja podem sair
   * @param {string[]} palpite
   * @param {boolean} forcar ignora o minimo de palavras (usado no fim da fala)
   */
  _entregar(ate, palpite, forcar) {
    const novas = palpite.slice(this.entregues.length, ate);
    if (!novas.length) return;
    if (!forcar && novas.length < this.minPalavras) return;

    this.entregues = palpite.slice(0, ate);
    this.emit('trecho', { texto: normalizar(novas.join(' ')), fim: forcar });
  }

  /**
   * Fecha o trecho atual e solta o que estiver pendente.
   *
   * Antes de ler o resultado final, entrega meio segundo de silencio e decodifica
   * de novo: sem isso a ultima palavra sai cortada ("different" virou "diff"),
   * porque o modelo ainda nao tinha contexto suficiente pra fechar ela.
   */
  encerrarTrecho() {
    this.fluxo.acceptWaveform({ samples: new Float32Array(TAXA / 2), sampleRate: TAXA });
    while (this.reconhecedor.isReady(this.fluxo)) this.reconhecedor.decode(this.fluxo);

    const texto = (this.reconhecedor.getResult(this.fluxo).text || '').trim();
    const palpite = texto ? texto.split(/\s+/) : this.ultimoPalpite;

    this._entregar(palpite.length, palpite, true);
    this.reconhecedor.reset(this.fluxo);
    this._configurarLingua();
    this._zerarTrecho();
    this._aquecer();
  }

  liberar() {
    this.fluxo = null;
    this.reconhecedor = null;
  }
}

/**
 * Alguns modelos (os zipformer) devolvem TUDO EM CAIXA ALTA, sem pontuacao.
 * Outros (o nemotron) ja devolvem pontuado e capitalizado direito.
 *
 * Entao a correcao tem que ser condicional: baixar a caixa so quando nao ha
 * nenhuma minuscula no texto. Baixar sempre destruiria a capitalizacao boa do
 * nemotron -- e a capitalizacao e justamente o que faz o TTS ler com entonacao
 * de frase em vez de ladainha.
 */
function normalizar(texto) {
  const cru = texto.trim();
  return /[a-zà-ÿ]/.test(cru) ? cru : cru.toLowerCase();
}

module.exports = { Reconhecedor, TAXA, normalizar };

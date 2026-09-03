'use strict';

/**
 * Reconhecimento de fala continuo, com entrega por frase completa.
 *
 * ---------------------------------------------------------------------------
 * Por que a frase so sai depois que voce para de falar
 * ---------------------------------------------------------------------------
 * Um reconhecedor streaming corrige o proprio palpite enquanto voce fala: ele
 * diz "I want", depois "I wanted", depois "I want it to". Falar e irreversivel
 * -- o que ja saiu no cabo nao volta --, entao entregar no meio da frase e
 * apostar que o palpite nao vai mudar mais. Quando muda, a voz gagueja, repete
 * e troca palavras.
 *
 * Aqui a aposta e outra: espera-se a pausa. Custa o tempo de uma frase em
 * atraso, e em troca o texto sai com o contexto inteiro -- palavras corrigidas
 * pelo que veio depois, pontuacao e maiusculas no lugar. E o que faz o TTS ler
 * com entonacao de frase em vez de ladainha.
 *
 * Quem levanta a mao dizendo que voce terminou e a deteccao de fim de fala do
 * sherpa, medindo o silencio depois do audio ja reconhecido (`pausaFinalS`).
 * Mas ela sozinha erra: respirar no meio da frase parece fim de frase pra ela,
 * e "the english voice is way better" saia partido em "the english" + "way
 * better". Entao o palpite dela passa por `_adiar` antes de virar fala.
 * ---------------------------------------------------------------------------
 */

const { EventEmitter } = require('events');

const TAXA = 16000; // o modelo so trabalha em 16 kHz
/** RMS acima disso, num bloco de ~100ms, conta como fala e nao como ruido. */
const LIMIAR_FALA = 0.01;
/**
 * Silencio extra pra o encoder despejar o ultimo pedaco. Os modelos daqui
 * trabalham em janelas de 320ms ou 560ms: sem encher a janela, uma palavra
 * curta fica presa e some no reset.
 */
const CAUDA_S = 0.6;
/**
 * Quanto ainda se espera depois da pausa quando a frase parece inacabada
 * (microfone ainda com voz, ou texto que nao terminou em ponto). E tambem o
 * teto: passado ele a frase sai do jeito que esta, custe o que custar.
 */
const ESPERA_EXTRA_S = 1.0;
/** Fim de frase de verdade: ponto, exclamacao, interrogacao, reticencias. */
const FIM_DE_FRASE = /[.!?…]["”’')\]]*$/;

/**
 * @typedef {Object} Opcoes
 * @property {number} [pausaFinalS=0.8] quanto silencio encerra a frase. Menor
 *   responde antes e corta quem pensa no meio da frase; maior espera mais.
 * @property {number} [esperaExtraS=1.0] quanto se espera alem da pausa quando
 *   a frase parece inacabada (ver `_adiar`). Tambem e o teto da espera.
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

    this.pausaFinalS = opcoes.pausaFinalS ?? 0.8;
    this.esperaExtraS = opcoes.esperaExtraS ?? ESPERA_EXTRA_S;
    this.aquecimentoS = opcoes.aquecimentoS ?? 0.2;

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
      // A deteccao de fim de fala e o que dispara a fala.
      enableEndpoint: true,
      // Silencio sem nada reconhecido: nao ha frase pra fechar, entao pode
      // esperar bem mais do que a pausa entre frases.
      rule1MinTrailingSilence: 2.4,
      rule2MinTrailingSilence: this.pausaFinalS,
      // Teto de seguranca: quem fala sem pausa nenhuma nao pode virar uma
      // frase que cresce pra sempre e nunca e falada.
      rule3MinUtteranceLength: 20,
    });

    this.fluxo = this.reconhecedor.createStream();
    this.palpite = '';
    this._ouviuFala = false;
    /** Silencio acumulado desde o ultimo bloco com voz, em segundos. */
    this._silencioS = 0;
    /** Piso de ruido do ambiente, pra o limiar de voz nao ser fixo. */
    this._ruido = 0;
    /** Se ja se viu pontuacao vinda do modelo (nemotron pontua, outros nao). */
    this._modeloPontua = false;
    this._aquecer();
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

  _lerPalpite() {
    return (this.reconhecedor.getResult(this.fluxo).text || '').trim();
  }

  /**
   * Empurra silencio e decodifica de novo, pra o encoder fechar a janela
   * incompleta. Sem isso a ultima (ou unica) palavra fica presa no buffer.
   */
  _despejarCauda() {
    this.fluxo.acceptWaveform({
      samples: new Float32Array(Math.round(TAXA * CAUDA_S)),
      sampleRate: TAXA,
    });
    while (this.reconhecedor.isReady(this.fluxo)) this.reconhecedor.decode(this.fluxo);
  }

  /**
   * Entrega audio ao reconhecedor.
   * @param {Float32Array} amostras mono, 16 kHz, faixa -1..1
   */
  alimentar(amostras) {
    const duracaoS = amostras.length / TAXA;
    const falando = this._medirVoz(energia(amostras));
    if (falando) this._ouviuFala = true;
    this._silencioS = falando ? 0 : this._silencioS + duracaoS;

    this.fluxo.acceptWaveform({ samples: amostras, sampleRate: TAXA });

    while (this.reconhecedor.isReady(this.fluxo)) {
      this.reconhecedor.decode(this.fluxo);
    }

    this.palpite = this._lerPalpite();
    if (/[.!?…]/.test(this.palpite)) this._modeloPontua = true;
    // O palpite serve so pra tela: mostra que o app esta ouvindo enquanto a
    // frase ainda pode mudar. Nada dele e falado.
    this.emit('parcial', { texto: this.palpite, entregue: '' });

    if (!this.reconhecedor.isEndpoint(this.fluxo)) return;
    if (this._adiar(falando)) return;

    // Palavra curta: a pausa chega antes do decoder emitir token nenhum.
    // Sem a cauda, o reset joga fora o audio que ainda estava na janela.
    if (!this.palpite && this._ouviuFala) {
      this._despejarCauda();
      this.palpite = this._lerPalpite() || this.palpite;
    }
    this._fecharFrase();
  }

  /**
   * Decide se a pausa detectada pelo sherpa ainda nao e o fim da frase.
   *
   * O detector do sherpa mede silencio no que o decodificador cuspiu, e ele
   * cospe blanks tanto na pausa entre frases quanto na respirada no meio de
   * uma -- por isso "the english voice is way better" saia partido em "the
   * english" e "way better". Duas checagens seguram a entrega:
   *
   * 1. o microfone ainda tem voz: quem esta falando nao terminou, ponto;
   * 2. o texto nao terminou em ponto final: modelo que pontua (nemotron) so
   *    fecha a frase quando ela de fato acabou, entao "the english" sem ponto
   *    e frase pela metade. Modelo que nunca pontua nao entra nessa regra.
   *
   * O teto e `this.esperaExtraS`: passado ele a frase sai como esta, senao um
   * ruido de fundo constante ou um modelo que esqueceu o ponto prenderia a
   * frase pra sempre.
   *
   * @param {boolean} falando se o bloco recem-entregue tinha nivel de voz
   */
  _adiar(falando) {
    if (this._silencioS >= this.pausaFinalS + this.esperaExtraS) return false;
    if (falando) return true;
    return this._modeloPontua && !!this.palpite && !FIM_DE_FRASE.test(this.palpite);
  }

  /**
   * Diz se o bloco tem voz, com o limiar acompanhando o ruido do ambiente:
   * num quarto silencioso vale o piso fixo, num ventilador ligado sobe junto
   * -- senao o ruido contaria como fala e a frase nunca fecharia.
   *
   * @param {number} nivel RMS do bloco
   */
  _medirVoz(nivel) {
    const limiar = Math.max(LIMIAR_FALA, this._ruido * 3);
    if (nivel > limiar) return true;
    this._ruido = this._ruido ? this._ruido * 0.95 + nivel * 0.05 : nivel;
    return false;
  }

  /**
   * Fecha a frase atual: entrega o texto pra ser falado e zera pra proxima.
   */
  _fecharFrase() {
    const frase = this.palpite;

    if (frase) {
      // A frase aceita aparece solida na tela antes de sumir; o palpite em
      // andamento fica apagado. Assim da pra ver o que foi aceito de verdade.
      this.emit('parcial', { texto: frase, entregue: frase });
      this.emit('trecho', { texto: normalizar(frase), fim: true });
    }

    this.reconhecedor.reset(this.fluxo);
    this.palpite = '';
    this._ouviuFala = false;
    this._silencioS = 0;
    this._aquecer();
    this.emit('fimDeTrecho');
  }

  /**
   * Fecha a frase na hora, sem esperar a pausa (usado ao desligar o microfone).
   *
   * Antes de ler o resultado final, entrega silencio e decodifica de novo:
   * sem isso a ultima palavra sai cortada ("different" virou "diff"),
   * porque o modelo ainda nao tinha contexto suficiente pra fechar ela.
   */
  encerrarTrecho() {
    this._despejarCauda();
    this.palpite = this._lerPalpite() || this.palpite;
    this._fecharFrase();
  }

  liberar() {
    this.fluxo = null;
    this.reconhecedor = null;
  }
}

/**
 * Alguns modelos devolvem TUDO EM CAIXA ALTA, sem pontuacao. Os nemotron ja
 * devolvem pontuado e capitalizado direito.
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

function energia(amostras) {
  let soma = 0;
  for (let i = 0; i < amostras.length; i++) soma += amostras[i] * amostras[i];
  return Math.sqrt(soma / (amostras.length || 1));
}

module.exports = { Reconhecedor, TAXA, normalizar };

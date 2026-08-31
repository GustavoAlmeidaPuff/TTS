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
 * Quem decide que voce terminou e a deteccao de fim de fala do sherpa, medindo
 * o silencio depois do audio ja reconhecido (`pausaFinalS`).
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
 * @typedef {Object} Opcoes
 * @property {number} [pausaFinalS=0.8] quanto silencio encerra a frase. Menor
 *   responde antes e corta quem pensa no meio da frase; maior espera mais.
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
    if (energia(amostras) > LIMIAR_FALA) this._ouviuFala = true;

    this.fluxo.acceptWaveform({ samples: amostras, sampleRate: TAXA });

    while (this.reconhecedor.isReady(this.fluxo)) {
      this.reconhecedor.decode(this.fluxo);
    }

    this.palpite = this._lerPalpite();
    // O palpite serve so pra tela: mostra que o app esta ouvindo enquanto a
    // frase ainda pode mudar. Nada dele e falado.
    this.emit('parcial', { texto: this.palpite, entregue: '' });

    if (!this.reconhecedor.isEndpoint(this.fluxo)) return;

    // Palavra curta: a pausa chega antes do decoder emitir token nenhum.
    // Sem a cauda, o reset joga fora o audio que ainda estava na janela.
    if (!this.palpite && this._ouviuFala) {
      this._despejarCauda();
      this.palpite = this._lerPalpite() || this.palpite;
    }
    this._fecharFrase();
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

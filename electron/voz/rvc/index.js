'use strict';

/**
 * Conversao de voz (RVC): troca o timbre mantendo o que voce falou.
 *
 * Diferente do modo "reconhecer e reler", aqui nao ha texto em lugar nenhum. O
 * audio entra, e o timbre sai trocado -- sua entonacao, seu ritmo e sua emocao
 * ficam, porque nada disso passa por palavras.
 *
 * ---------------------------------------------------------------------------
 * As tres redes, e por que sao tres
 * ---------------------------------------------------------------------------
 *  1. ContentVec  : audio -> "o que foi dito", sem a identidade de quem disse.
 *  2. RMVPE       : audio -> a melodia (f0), que e o que carrega a entonacao.
 *  3. Gerador     : conteudo + melodia + identidade da voz alvo -> audio novo.
 *
 * Separar conteudo de identidade e o truque inteiro: o gerador recebe o QUE foi
 * dito e a MELODIA de como foi dito, e reconstroi aquilo na voz de outra pessoa.
 *
 * Medido nesta maquina, para 1s de audio: ContentVec 33ms e RMVPE 25ms na CPU,
 * gerador 454ms na GPU (DirectML). Na CPU o gerador sozinho leva 1526ms, ou seja
 * 1,5x tempo real -- por isso ele NAO roda em CPU no modo ao vivo.
 * ---------------------------------------------------------------------------
 */

const path = require('path');
const fs = require('fs');

const sinal = require('./sinal');

const TAXA_ENTRADA = 16000;
/** A U-Net do RMVPE reduz o tempo pela metade 5 vezes; sem isso ela nao roda. */
const MULTIPLO_RMVPE = 32;
/** O ContentVec anda de 320 amostras (20ms); o gerador quer 10ms. Dai o dobro. */
const FATOR_QUADROS = 2;

class Conversor {
  /**
   * @param {{contentvec: string, rmvpe: string, gerador: string}} arquivos
   * @param {{provedorGerador?: string, provedorLeve?: string}} [opcoes]
   */
  constructor(arquivos, opcoes = {}) {
    this.arquivos = arquivos;
    // O gerador e o unico que precisa de GPU; os outros dois sao leves e a CPU
    // e ate mais previsivel neles (sem custo de copia pra placa).
    this.provedorGerador = opcoes.provedorGerador || 'dml';
    this.provedorLeve = opcoes.provedorLeve || 'cpu';

    this.contentvec = null;
    this.rmvpe = null;
    this.gerador = null;
    this.taxaSaida = null;

    // Montar o banco de filtros mel custa caro e nunca muda: uma vez so.
    this.filtrosMel = sinal.bancoMel({
      taxa: TAXA_ENTRADA, nFft: 1024, nMels: 128, fMin: 30, fMax: 8000,
    });
    this.janela = sinal.janelaHann(1024);
  }

  async carregar(aoProgresso) {
    const ort = require('onnxruntime-node');
    const abrir = async (caminho, provedor, rotulo) => {
      if (aoProgresso) aoProgresso({ rotulo: `carregando ${rotulo}`, porcento: null });
      return ort.InferenceSession.create(caminho, {
        executionProviders: [provedor],
        graphOptimizationLevel: 'all',
      });
    };

    this.contentvec = await abrir(this.arquivos.contentvec, this.provedorLeve, 'o extrator de conteúdo');
    this.rmvpe = await abrir(this.arquivos.rmvpe, this.provedorLeve, 'o detector de melodia');

    try {
      this.gerador = await abrir(this.arquivos.gerador, this.provedorGerador, 'a voz na GPU');
    } catch (e) {
      // Sem GPU o app ainda converte, mas nao em tempo real -- e melhor dizer
      // isso do que fingir que esta tudo bem e travar o audio depois.
      this.provedorGerador = 'cpu';
      this.gerador = await abrir(this.arquivos.gerador, 'cpu', 'a voz (sem GPU: vai ficar lento)');
      this.semGpu = true;
    }
  }

  /** Extrai as caracteristicas de conteudo, ja no dobro de quadros. */
  async _conteudo(ort, amostras) {
    const r = await this.contentvec.run({
      source: new ort.Tensor('float32', amostras, [1, 1, amostras.length]),
    });
    const embed = r.embed;
    const [, quadros, dim] = embed.dims;
    const dados = embed.data;

    // Cada quadro vira dois (interpolacao por repeticao, como o RVC faz).
    const dobrado = new Float32Array(quadros * FATOR_QUADROS * dim);
    for (let q = 0; q < quadros; q++) {
      const origem = q * dim;
      for (let k = 0; k < FATOR_QUADROS; k++) {
        dobrado.set(dados.subarray(origem, origem + dim), (q * FATOR_QUADROS + k) * dim);
      }
    }
    return { dados: dobrado, quadros: quadros * FATOR_QUADROS, dim };
  }

  /** Extrai a melodia (f0) em Hz, um valor a cada 10ms. */
  async _melodia(ort, amostras) {
    const mel = sinal.melEspectrograma(amostras, {
      taxa: TAXA_ENTRADA, nFft: 1024, salto: 160, nMels: 128,
      filtros: this.filtrosMel, janela: this.janela,
    });

    // A rede so aceita um numero de quadros multiplo de 32; o excedente e
    // descartado depois, entao o preenchimento nao contamina o resultado.
    const alvo = Math.ceil(mel.quadros / MULTIPLO_RMVPE) * MULTIPLO_RMVPE;
    const preenchido = new Float32Array(mel.nMels * alvo);
    for (let m = 0; m < mel.nMels; m++) {
      const linha = mel.dados.subarray(m * mel.quadros, (m + 1) * mel.quadros);
      preenchido.set(linha, m * alvo);
      // Repete o ultimo quadro no lugar de zerar: zero em escala log e um
      // degrau enorme, e a rede reagiria a ele como se fosse som.
      const ultimo = linha[mel.quadros - 1] || 0;
      for (let q = mel.quadros; q < alvo; q++) preenchido[m * alvo + q] = ultimo;
    }

    const r = await this.rmvpe.run({
      input: new ort.Tensor('float32', preenchido, [1, mel.nMels, alvo]),
    });

    const [, quadrosSaida] = r.output.dims;
    const f0 = sinal.decodificarTom(r.output.data, quadrosSaida);
    return f0.subarray(0, mel.quadros); // corta o que era so preenchimento
  }

  /** Estica ou corta a melodia pra casar com o numero de quadros de conteudo. */
  static _alinhar(f0, quadros) {
    const saida = new Float32Array(quadros);
    if (!f0.length) return saida;
    for (let i = 0; i < quadros; i++) {
      const origem = Math.min(f0.length - 1, Math.round((i * f0.length) / quadros));
      saida[i] = f0[origem];
    }
    return saida;
  }

  /**
   * Converte um bloco de audio.
   * @param {Float32Array} amostras mono, 16 kHz, faixa -1..1
   * @param {{semitons?: number, locutor?: number}} [opcoes]
   * @returns {Promise<{audio: Float32Array, taxa: number, tempos: object}>}
   */
  async converter(amostras, opcoes = {}) {
    if (!this.gerador) throw new Error('o conversor ainda nao foi carregado');
    const ort = require('onnxruntime-node');

    const t0 = Date.now();
    const conteudo = await this._conteudo(ort, amostras);
    const tConteudo = Date.now() - t0;

    const t1 = Date.now();
    let f0 = await this._melodia(ort, amostras);
    const tMelodia = Date.now() - t1;

    f0 = Conversor._alinhar(f0, conteudo.quadros);

    // Transpor a voz em semitons: multiplica a frequencia, sem tocar no resto.
    const semitons = Number(opcoes.semitons || 0);
    if (semitons !== 0) {
      const fator = Math.pow(2, semitons / 12);
      for (let i = 0; i < f0.length; i++) f0[i] *= fator;
    }

    const T = conteudo.quadros;
    const rnd = new Float32Array(192 * T);
    for (let i = 0; i < rnd.length; i++) rnd[i] = Math.random() * 2 - 1;

    const t2 = Date.now();
    const r = await this.gerador.run({
      phone: new ort.Tensor('float32', conteudo.dados, [1, T, conteudo.dim]),
      phone_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(T)]), [1]),
      pitch: new ort.Tensor('int64', sinal.tomGrosso(f0), [1, T]),
      pitchf: new ort.Tensor('float32', f0, [1, T]),
      ds: new ort.Tensor('int64', BigInt64Array.from([BigInt(opcoes.locutor || 0)]), [1]),
      rnd: new ort.Tensor('float32', rnd, [1, 192, T]),
    });
    const tGerador = Date.now() - t2;

    const audio = Float32Array.from(r.audio.data);

    // A taxa de saida nao esta declarada no modelo; deduzo da razao entre o que
    // entrou e o que saiu, e memorizo (todo bloco tem a mesma razao).
    if (!this.taxaSaida) {
      const razao = audio.length / amostras.length;
      // Os modelos RVC saem em 32k, 40k ou 48k. Arredondo pro mais proximo.
      const candidatos = [32000, 40000, 48000];
      const bruta = TAXA_ENTRADA * razao;
      this.taxaSaida = candidatos.reduce(
        (a, b) => (Math.abs(b - bruta) < Math.abs(a - bruta) ? b : a)
      );
    }

    return {
      audio,
      taxa: this.taxaSaida,
      tempos: {
        conteudo: tConteudo,
        melodia: tMelodia,
        gerador: tGerador,
        total: tConteudo + tMelodia + tGerador,
        segundosDeAudio: amostras.length / TAXA_ENTRADA,
      },
    };
  }

  async liberar() {
    for (const s of [this.contentvec, this.rmvpe, this.gerador]) {
      if (s) await s.release().catch(() => {});
    }
    this.contentvec = this.rmvpe = this.gerador = null;
  }
}

module.exports = { Conversor, TAXA_ENTRADA, sinal };

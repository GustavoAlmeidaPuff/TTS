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

// Primeira coisa do arquivo, de proposito: ver electron/comum/onnx.js.
const { ort } = require('../../comum/onnx');

const path = require('path');
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
    // AS TRES na GPU, e nao so o gerador.
    //
    // A primeira versao deixava ContentVec e RMVPE na CPU, achando que sendo
    // leves nao valeria o custo de copiar pra placa. Errado, e por dois motivos:
    // eles ja sao mais rapidos la, E na CPU eles ficavam presos atras da espera
    // ativa que o DirectML mantem enquanto a GPU trabalha. Medido, bloco de 0,5s:
    //
    //              leves na CPU   leves na GPU
    //   vec           226ms          13ms
    //   rmvpe         182ms          19ms
    //   gerador        90ms          35ms
    //   fator          0,99x         0,13x
    this.provedorGerador = opcoes.provedorGerador || 'dml';
    this.provedorLeve = opcoes.provedorLeve || 'dml';
    // Ver o comentario em carregar(): mais threads deixa TUDO mais lento.
    this.threads = opcoes.threads || 4;
    // null = sem teto. Ver a nota em carregar() sobre o gerador.
    this.threadsGerador = opcoes.threadsGerador !== undefined ? opcoes.threadsGerador : null;
    // null = descobre medindo na primeira carga. Ver _escolherGpu().
    this.dispositivo = opcoes.dispositivo !== undefined ? opcoes.dispositivo : null;
    this.gpusMedidas = [];
    // Quadros de 10ms: acima disso e silencio de verdade, e tem que continuar sendo.
    this.maxBuraco = opcoes.maxBuraco ?? 5;
    // 1 = normal padrao, que e o que o gerador viu no treino.
    this.escalaRuido = opcoes.escalaRuido ?? 1;
    this.ultimosBuracosTapados = 0;

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
    const abrir = async (caminho, provedor, rotulo, teto = this.threads) => {
      if (aoProgresso) aoProgresso({ rotulo: `carregando ${rotulo}`, porcento: null });
      return ort.InferenceSession.create(caminho, {
        executionProviders: [
          provedor === 'dml' && this.dispositivo !== null
            ? { name: 'dml', deviceId: this.dispositivo }
            : provedor,
        ],
        graphOptimizationLevel: 'all',

        // ------------------------------------------------------------------
        // ESTE TETO NAO E DETALHE: e a diferenca entre caber e nao caber.
        //
        // Sem ele, cada uma das tres sessoes abre um conjunto de threads do
        // tamanho do processador (10 nucleos aqui), e o DirectML ainda segura
        // nucleos em espera ativa enquanto a GPU trabalha. As tres brigam, e
        // todas perdem. Medido, no mesmo bloco de 0,5s:
        //
        //            sem teto      com teto (4)
        //   vec        109ms          29ms
        //   rmvpe      152ms          24ms
        //   gerador    516ms         221ms
        //   fator      1,55x         0,55x   <- so o segundo cabe ao vivo
        //
        // Contraintuitivo e real: dar MENOS nucleos pra cada um deixa o
        // conjunto quase 3x mais rapido.
        // ------------------------------------------------------------------
        ...(teto ? { intraOpNumThreads: teto, interOpNumThreads: 1 } : {}),
      });
    };

    this.contentvec = await abrir(this.arquivos.contentvec, this.provedorLeve, 'o extrator de conteúdo');
    this.rmvpe = await abrir(this.arquivos.rmvpe, this.provedorLeve, 'o detector de melodia');

    try {
      if (this.provedorGerador === 'dml' && this.dispositivo === null) {
        this.dispositivo = await this._escolherGpu(aoProgresso);
      }
      this.gerador = await abrir(this.arquivos.gerador, this.provedorGerador, 'a voz na GPU', this.threadsGerador);
    } catch (e) {
      // Sem GPU o app ainda converte, mas nao em tempo real -- e melhor dizer
      // isso do que fingir que esta tudo bem e travar o audio depois.
      this.provedorGerador = 'cpu';
      this.gerador = await abrir(this.arquivos.gerador, 'cpu', 'a voz (sem GPU: vai ficar lento)', this.threads);
      this.semGpu = true;
    }
  }

  /**
   * Descobre QUAL placa de video usar, medindo em vez de supondo.
   *
   * ---------------------------------------------------------------------------
   * A armadilha que isto resolve
   * ---------------------------------------------------------------------------
   * O DirectML usa o "dispositivo 0" quando ninguem diz o contrario. Em notebook
   * com placa dedicada, o dispositivo 0 quase sempre e a INTEGRADA -- e a
   * dedicada, que e a razao de ter comprado o notebook, fica parada.
   *
   * Medido nesta maquina, o mesmo gerador no mesmo bloco:
   *
   *   dispositivo 0 (Intel integrada) : 627ms
   *   dispositivo 1 (RTX 4050)        :  82ms   <- 7,6x mais rapido
   *   dispositivo 2                   : 658ms
   *
   * A diferenca decide se a conversao ao vivo cabe ou nao cabe. E nao da pra
   * fixar "use o 1": a ordem muda de maquina pra maquina. Entao a escolha e
   * feita medindo, uma vez, no proprio modelo que vai ser usado.
   * ---------------------------------------------------------------------------
   *
   * @returns {Promise<number>} o indice do dispositivo mais rapido
   */
  async _escolherGpu(aoProgresso) {
    if (aoProgresso) aoProgresso({ rotulo: 'procurando a placa de vídeo mais rápida', porcento: null });

    const T = 50; // bloco minusculo: so pra comparar, nao pra usar
    const entradas = () => ({
      phone: new ort.Tensor('float32', new Float32Array(T * 768), [1, T, 768]),
      phone_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(T)]), [1]),
      pitch: new ort.Tensor('int64', BigInt64Array.from({ length: T }, () => 180n), [1, T]),
      pitchf: new ort.Tensor('float32', new Float32Array(T).fill(220), [1, T]),
      ds: new ort.Tensor('int64', BigInt64Array.from([0n]), [1]),
      rnd: new ort.Tensor('float32', new Float32Array(192 * T), [1, 192, T]),
    });

    let melhor = { dispositivo: 0, ms: Infinity };
    this.gpusMedidas = [];

    for (let dev = 0; dev < 4; dev++) {
      let sessao = null;
      try {
        sessao = await ort.InferenceSession.create(this.arquivos.gerador, {
          executionProviders: [{ name: 'dml', deviceId: dev }],
          graphOptimizationLevel: 'all',
        });
        await sessao.run(entradas()); // aquece: a primeira sempre mente
        const t0 = Date.now();
        await sessao.run(entradas());
        await sessao.run(entradas());
        const ms = (Date.now() - t0) / 2;

        this.gpusMedidas.push({ dispositivo: dev, ms: Math.round(ms) });
        if (ms < melhor.ms) melhor = { dispositivo: dev, ms };
      } catch (_) {
        break; // acabaram os dispositivos
      } finally {
        if (sessao) await sessao.release().catch(() => {});
      }
    }

    return melhor.dispositivo;
  }

  /**
   * Troca a voz alvo sem recarregar o resto.
   *
   * As duas redes pesadas (conteudo e melodia) nao dependem da voz: so o
   * gerador muda. Recarregar so ele leva ~2s em vez dos ~5s de tudo, e e o que
   * torna comparar vozes uma coisa rapida em vez de um reinicio.
   */
  async trocarGerador(caminho) {
    const novo = await ort.InferenceSession.create(caminho, {
      executionProviders: [
        this.provedorGerador === 'dml' && this.dispositivo !== null
          ? { name: 'dml', deviceId: this.dispositivo }
          : this.provedorGerador,
      ],
      graphOptimizationLevel: 'all',
      ...(this.threadsGerador ? { intraOpNumThreads: this.threadsGerador, interOpNumThreads: 1 } : {}),
    });
    const velho = this.gerador;
    this.gerador = novo;
    this.arquivos.gerador = caminho;
    // A taxa de saida pode ser outra nesta voz; deduz de novo na proxima conversao.
    this.taxaSaida = null;
    if (velho) await velho.release().catch(() => {});
  }

  /** Extrai as caracteristicas de conteudo, ja no dobro de quadros. */
  async _conteudo(amostras) {
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
  async _melodia(amostras) {
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
    const bruto = sinal.decodificarTom(r.output.data, quadrosSaida);
    const cortado = bruto.subarray(0, mel.quadros); // tira o que era preenchimento

    // Sem isto a voz sai com "catarro" -- ver taparBuracos() em sinal.js.
    const { f0, tapados } = sinal.taparBuracos(cortado, this.maxBuraco);
    this.ultimosBuracosTapados = tapados;
    return f0;
  }

  /**
   * A mediana das partes com voz, que e o "centro" da sua fala.
   *
   * Mediana e nao media de proposito: uma nota fora do lugar (um estalo, uma
   * oitava detectada errada) desloca a media e nao desloca a mediana. Como este
   * numero decide a transposicao, um erro aqui estraga a conversao inteira.
   *
   * @returns {number} Hz, ou 0 se nao houver voz suficiente
   */
  static tomMediano(f0) {
    const comVoz = [];
    // Fora dessa faixa nao e voz humana falando: e ruido ou erro de deteccao.
    for (let i = 0; i < f0.length; i++) {
      if (f0[i] >= 50 && f0[i] <= 600) comVoz.push(f0[i]);
    }
    if (comVoz.length < 5) return 0;
    comVoz.sort((a, b) => a - b);
    return comVoz[Math.floor(comVoz.length / 2)];
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

    const t0 = Date.now();
    const conteudo = await this._conteudo(amostras);
    const tConteudo = Date.now() - t0;

    const t1 = Date.now();
    let f0 = await this._melodia(amostras);
    const tMelodia = Date.now() - t1;

    f0 = Conversor._alinhar(f0, conteudo.quadros);

    // A mediana da SUA voz, antes de qualquer transposicao.
    const tomOriginal = Conversor.tomMediano(f0);

    /**
     * Transposicao.
     *
     * Isto nao e enfeite: e a diferenca entre a voz sair natural ou rouca.
     * Cada modelo de voz foi treinado numa faixa de frequencia. Entregando uma
     * melodia masculina (~120 Hz) a um modelo feminino (~200 Hz), o gerador
     * trabalha fora do que conhece e o resultado sai forcado e rouco -- e
     * exatamente o que se ouve quando se deixa a transposicao em zero.
     *
     * Com `tomAlvo`, a conta e feita sozinha a partir da sua voz, em vez de
     * voce ter que descobrir o numero no ouvido.
     */
    let semitons = Number(opcoes.semitons || 0);
    if (opcoes.tomAlvo && tomOriginal > 0) {
      semitons = 12 * Math.log2(opcoes.tomAlvo / tomOriginal);
      // Passar de duas oitavas nunca melhora: e sinal de deteccao errada
      // (metade ou dobro da frequencia), e o corte evita um resultado grotesco.
      semitons = Math.max(-24, Math.min(24, semitons));
    }

    if (semitons !== 0) {
      const fator = Math.pow(2, semitons / 12);
      for (let i = 0; i < f0.length; i++) f0[i] *= fator;
    }

    const T = conteudo.quadros;
    const rnd = sinal.ruidoGaussiano(192 * T, this.escalaRuido);

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
      /** Diagnostico do tom: e o que explica uma conversao rouca. */
      tom: {
        seu: Math.round(tomOriginal),
        alvo: opcoes.tomAlvo ? Math.round(opcoes.tomAlvo) : null,
        semitons: +semitons.toFixed(1),
        buracosTapados: this.ultimosBuracosTapados,
      },
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

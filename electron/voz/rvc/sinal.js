'use strict';

/**
 * Processamento de sinal para o RVC: FFT, espectrograma mel e conversoes de tom.
 *
 * Tudo aqui existe porque o modelo de tom (RMVPE) nao aceita audio cru -- ele
 * quer um espectrograma mel de 128 faixas, montado exatamente como o librosa
 * monta no Python. Qualquer diferenca de escala ou normalizacao aqui vira tom
 * errado la na frente, e tom errado no RVC soa como voz desafinada.
 *
 * As constantes nao sao escolhas minhas: sao as do RVC, e mudar qualquer uma
 * quebra a compatibilidade com os modelos ja treinados.
 */

// ------------------------------------------------------------------ FFT ----

/**
 * FFT radix-2 no lugar (Cooley-Tukey).
 * @param {Float32Array} re parte real, tamanho potencia de 2
 * @param {Float32Array} im parte imaginaria, mesmo tamanho
 */
function fft(re, im) {
  const n = re.length;

  // Reordenacao por inversao de bits.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }

  for (let tamanho = 2; tamanho <= n; tamanho <<= 1) {
    const angulo = (-2 * Math.PI) / tamanho;
    const wRe = Math.cos(angulo);
    const wImg = Math.sin(angulo);
    for (let i = 0; i < n; i += tamanho) {
      let curRe = 1;
      let curIm = 0;
      for (let j = 0; j < tamanho / 2; j++) {
        const a = i + j;
        const b = i + j + tamanho / 2;
        const tRe = re[b] * curRe - im[b] * curIm;
        const tIm = re[b] * curIm + im[b] * curRe;
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const proxRe = curRe * wRe - curIm * wImg;
        curIm = curRe * wImg + curIm * wRe;
        curRe = proxRe;
      }
    }
  }
}

// ------------------------------------------------------- escala mel -------

// Escala mel do Slaney (a que o librosa usa por padrao, htk=False).
const F_SP = 200 / 3;
const MIN_LOG_HZ = 1000;
const MIN_LOG_MEL = MIN_LOG_HZ / F_SP;
const PASSO_LOG = Math.log(6.4) / 27;

const hzParaMel = (hz) =>
  hz < MIN_LOG_HZ ? hz / F_SP : MIN_LOG_MEL + Math.log(hz / MIN_LOG_HZ) / PASSO_LOG;

const melParaHz = (mel) =>
  mel < MIN_LOG_MEL ? mel * F_SP : MIN_LOG_HZ * Math.exp(PASSO_LOG * (mel - MIN_LOG_MEL));

/**
 * Banco de filtros triangulares mel, com a normalizacao "slaney" do librosa
 * (cada filtro dividido pela sua largura em Hz, pra que faixas largas nao
 * dominem as estreitas).
 *
 * @returns {Float32Array[]} nMels filtros, cada um com nFft/2+1 pesos
 */
function bancoMel({ taxa, nFft, nMels, fMin, fMax }) {
  const nBins = Math.floor(nFft / 2) + 1;
  const freqsFft = new Float64Array(nBins);
  for (let i = 0; i < nBins; i++) freqsFft[i] = (i * taxa) / nFft;

  // nMels+2 pontos igualmente espacados em mel: cada filtro usa tres deles.
  const melMin = hzParaMel(fMin);
  const melMax = hzParaMel(fMax);
  const pontos = new Float64Array(nMels + 2);
  for (let i = 0; i < nMels + 2; i++) {
    pontos[i] = melParaHz(melMin + ((melMax - melMin) * i) / (nMels + 1));
  }

  const filtros = [];
  for (let m = 0; m < nMels; m++) {
    const esq = pontos[m];
    const centro = pontos[m + 1];
    const dir = pontos[m + 2];
    const filtro = new Float32Array(nBins);
    const escala = 2 / (dir - esq); // normalizacao slaney

    for (let k = 0; k < nBins; k++) {
      const f = freqsFft[k];
      let peso = 0;
      if (f >= esq && f <= centro && centro > esq) peso = (f - esq) / (centro - esq);
      else if (f > centro && f <= dir && dir > centro) peso = (dir - f) / (dir - centro);
      filtro[k] = peso * escala;
    }
    filtros.push(filtro);
  }
  return filtros;
}

/** Janela de Hann periodica (a que o torch.hann_window devolve por padrao). */
function janelaHann(n) {
  const j = new Float32Array(n);
  for (let i = 0; i < n; i++) j[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return j;
}

/**
 * Espectrograma mel logaritmico, no formato que o RMVPE espera.
 *
 * Detalhes que precisam bater com o Python, um a um:
 *  - preenchimento refletido de nFft/2 nas duas pontas (center=True do torch)
 *  - magnitude (nao potencia) do espectro
 *  - log com piso em 1e-5, e nao log10 nem dB
 *
 * @param {Float32Array} amostras audio mono a 16 kHz
 * @returns {{dados: Float32Array, quadros: number, nMels: number}} formato [nMels, quadros] achatado
 */
function melEspectrograma(amostras, opcoes = {}) {
  const taxa = opcoes.taxa ?? 16000;
  const nFft = opcoes.nFft ?? 1024;
  const salto = opcoes.salto ?? 160;
  const nMels = opcoes.nMels ?? 128;
  const fMin = opcoes.fMin ?? 30;
  const fMax = opcoes.fMax ?? 8000;
  const piso = opcoes.piso ?? 1e-5;

  const filtros = opcoes.filtros || bancoMel({ taxa, nFft, nMels, fMin, fMax });
  const janela = opcoes.janela || janelaHann(nFft);
  const metade = Math.floor(nFft / 2);

  // Preenchimento refletido, pra que o primeiro quadro fique centrado na
  // amostra 0 (equivale ao center=True do torch.stft).
  const total = amostras.length + nFft;
  const preenchido = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    let idx = i - metade;
    if (idx < 0) idx = -idx;
    if (idx >= amostras.length) idx = 2 * amostras.length - idx - 2;
    preenchido[i] = idx >= 0 && idx < amostras.length ? amostras[idx] : 0;
  }

  const quadros = Math.floor(amostras.length / salto) + 1;
  const nBins = metade + 1;
  const saida = new Float32Array(nMels * quadros);

  const re = new Float32Array(nFft);
  const im = new Float32Array(nFft);
  const magnitude = new Float32Array(nBins);

  for (let q = 0; q < quadros; q++) {
    const inicio = q * salto;
    for (let i = 0; i < nFft; i++) {
      re[i] = (preenchido[inicio + i] || 0) * janela[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < nBins; k++) magnitude[k] = Math.hypot(re[k], im[k]);

    for (let m = 0; m < nMels; m++) {
      const filtro = filtros[m];
      let soma = 0;
      for (let k = 0; k < nBins; k++) soma += filtro[k] * magnitude[k];
      saida[m * quadros + q] = Math.log(Math.max(soma, piso));
    }
  }

  return { dados: saida, quadros, nMels };
}

// -------------------------------------------------------- tom (f0) --------

/**
 * Traduz a saida do RMVPE (360 faixas de probabilidade) em frequencia.
 *
 * O pico sozinho daria um tom "em degraus"; a media ponderada em torno dele
 * recupera a resolucao fina. As constantes vem do RMVPE original.
 *
 * @param {Float32Array} saida achatado [quadros, 360]
 * @param {number} quadros
 * @param {number} limiar abaixo disso o quadro e considerado sem voz
 * @returns {Float32Array} f0 em Hz, 0 onde nao ha voz
 */
function decodificarTom(saida, quadros, limiar = 0.03) {
  const N = 360;
  const f0 = new Float32Array(quadros);

  for (let q = 0; q < quadros; q++) {
    const base = q * N;

    let melhor = 0;
    let pico = saida[base];
    for (let i = 1; i < N; i++) {
      if (saida[base + i] > pico) {
        pico = saida[base + i];
        melhor = i;
      }
    }
    if (pico < limiar) continue; // silencio ou ruido: sem tom

    // Media ponderada numa janela de +-4 faixas em volta do pico.
    const de = Math.max(0, melhor - 4);
    const ate = Math.min(N - 1, melhor + 4);
    let somaPeso = 0;
    let somaProduto = 0;
    for (let i = de; i <= ate; i++) {
      const p = saida[base + i];
      somaPeso += p;
      somaProduto += p * (20 * i + 1997.3794084376191); // faixa -> cents
    }
    if (somaPeso <= 0) continue;

    const cents = somaProduto / somaPeso;
    f0[q] = 10 * Math.pow(2, cents / 1200);
  }

  return f0;
}

/**
 * Tapa buracos curtos na melodia.
 *
 * ---------------------------------------------------------------------------
 * O defeito que isto conserta
 * ---------------------------------------------------------------------------
 * O detector de tom as vezes perde a voz por dois ou tres quadros (20-30ms) no
 * meio de uma vogal continua, e devolve zero ali. Medido numa frase de 5s: 7
 * buracos desses, 1,3 por segundo.
 *
 * Zero, pro gerador, nao quer dizer "nao sei" -- quer dizer "aqui nao ha voz".
 * Entao ele troca a excitacao harmonica por ruido naquele instante e volta logo
 * depois. Varias vezes por segundo, isso soa exatamente como voz com catarro.
 *
 * A saida e distinguir os dois casos:
 *  - buraco CURTO cercado de voz  -> falha de deteccao: interpola e segue.
 *  - buraco LONGO                 -> silencio ou consoante surda de verdade
 *                                    (/s/, /f/), que PRECISA ficar sem tom.
 *
 * Tapar tudo seria pior que o problema: as consoantes surdas ganhariam tom e a
 * fala ficaria com um zumbido contínuo por baixo.
 * ---------------------------------------------------------------------------
 *
 * @param {Float32Array} f0
 * @param {number} [maxBuraco=5] quadros (10ms cada) -- acima disso e silencio real
 * @returns {{f0: Float32Array, tapados: number}}
 */
function taparBuracos(f0, maxBuraco = 5) {
  const saida = Float32Array.from(f0);
  let tapados = 0;
  let i = 0;

  while (i < saida.length) {
    if (saida[i] !== 0) {
      i++;
      continue;
    }

    const inicio = i;
    while (i < saida.length && saida[i] === 0) i++;
    const fim = i; // primeiro quadro com voz depois do buraco

    const cercado = inicio > 0 && fim < saida.length;
    if (!cercado || fim - inicio > maxBuraco) continue;

    // Rampa linear entre as bordas: a melodia atravessa o buraco sem degrau.
    const antes = saida[inicio - 1];
    const depois = saida[fim];
    const passos = fim - inicio + 1;
    for (let k = inicio; k < fim; k++) {
      saida[k] = antes + ((depois - antes) * (k - inicio + 1)) / passos;
    }
    tapados++;
  }

  return { f0: saida, tapados };
}

/**
 * Ruido gaussiano (normal padrao), pelo metodo de Box-Muller.
 *
 * ---------------------------------------------------------------------------
 * Por que gaussiano, e nao `Math.random()`
 * ---------------------------------------------------------------------------
 * O gerador do RVC tem um modulo de fluxo que espera receber ruido tirado de
 * uma normal padrao -- media 0, desvio 1 -- porque foi assim que ele treinou.
 *
 * A primeira versao mandava `Math.random() * 2 - 1`, que e uniforme em [-1,1].
 * Isso erra duas coisas ao mesmo tempo: a forma da distribuicao (uniforme nao
 * tem cauda; normal tem) e a escala (desvio 0,577 em vez de 1). O gerador
 * recebe uma "textura" de ruido que nunca viu, e devolve uma voz com granulacao
 * aspera por cima.
 *
 * @param {number} n
 * @param {number} [escala=1] abaixo de 1 deixa a voz mais lisa e menos viva
 */
function ruidoGaussiano(n, escala = 1) {
  const saida = new Float32Array(n);
  for (let i = 0; i < n; i += 2) {
    // Box-Muller: dois uniformes viram dois normais independentes.
    const u1 = Math.max(1e-7, Math.random());
    const u2 = Math.random();
    const raio = Math.sqrt(-2 * Math.log(u1));
    const angulo = 2 * Math.PI * u2;
    saida[i] = raio * Math.cos(angulo) * escala;
    if (i + 1 < n) saida[i + 1] = raio * Math.sin(angulo) * escala;
  }
  return saida;
}

/**
 * Quantiza f0 em 255 degraus na escala mel, que e o que o gerador espera na
 * entrada `pitch` (a entrada `pitchf` recebe o valor continuo).
 */
function tomGrosso(f0, fMin = 50, fMax = 1100) {
  const melMin = 1127 * Math.log(1 + fMin / 700);
  const melMax = 1127 * Math.log(1 + fMax / 700);
  const grosso = new BigInt64Array(f0.length);

  for (let i = 0; i < f0.length; i++) {
    if (f0[i] <= 0) continue;
    const mel = 1127 * Math.log(1 + f0[i] / 700);
    let v = ((mel - melMin) * 254) / (melMax - melMin) + 1;
    v = Math.round(Math.min(255, Math.max(1, v)));
    grosso[i] = BigInt(v);
  }
  return grosso;
}

module.exports = {
  fft, bancoMel, janelaHann, melEspectrograma,
  decodificarTom, taparBuracos, ruidoGaussiano, tomGrosso, hzParaMel, melParaHz,
};

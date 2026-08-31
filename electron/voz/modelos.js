'use strict';

/**
 * Modelos de reconhecimento de fala (sherpa-onnx) e de deteccao de voz (Silero).
 *
 * Nao ficam no repositorio -- sao centenas de MB. O app baixa sob demanda pra
 * pasta de dados do usuario, igual ao Piper.
 */

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');

const { baixar, descompactarTarBz2, existe } = require('../comum/baixador');

const BASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models';
const URL_VAD = `${BASE}/silero_vad.onnx`;

/**
 * Reconhecedores disponiveis. Todos sao "streaming": vao devolvendo o texto
 * enquanto voce fala, em vez de esperar a frase acabar.
 *
 * O padrao e o `multi`, e a diferenca pros zipformers so-ingles e grande --
 * medido, nao chutado. Na mesma frase em ingles:
 *
 *   zipformer : "hullo ever one welcome back to the stream to day we are..."
 *   nemotron  : "Hello everyone, welcome back to the stream. Today we are..."
 *
 * Alem de acertar mais, ele detecta o idioma sozinho (40 locales, pt-BR entre
 * eles) e ja devolve pontuacao e maiusculas -- o que faz o TTS ler com entonacao
 * bem melhor do que um texto corrido em caixa alta.
 */
const CATALOGO = [
  {
    id: 'multi',
    nome: 'Multi-idioma (recomendado)',
    lingua: 'auto',
    descricao:
      'Português e inglês no mesmo modelo, trocando de um pro outro sozinho. ' +
      'Devolve pontuação e maiúsculas. É o mais certeiro.',
    pasta: 'sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-320ms-int8-2026-06-11',
    mb: 453,
    padrao: true,
  },
  {
    id: 'multi-rapido',
    nome: 'Multi-idioma, atraso menor',
    lingua: 'auto',
    descricao: 'O mesmo modelo com blocos de 160ms em vez de 320ms: responde antes, gasta mais CPU.',
    pasta: 'sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-160ms-int8-2026-06-11',
    mb: 453,
  },
  {
    id: 'en-leve',
    nome: 'Só inglês, bem leve',
    lingua: 'en',
    descricao: 'Para máquina fraca: 122 MB e carrega em 1s. Erra bem mais, e não entende português.',
    pasta: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17',
    mb: 122,
  },
];

let raiz = path.join(os.homedir(), '.voz-tts');
function definirRaiz(novaRaiz) {
  raiz = novaRaiz;
}

const pastaModelos = () => path.join(raiz, 'reconhecimento');
const caminhoVad = () => path.join(pastaModelos(), 'silero_vad.onnx');
const pastaDe = (id) => {
  const m = CATALOGO.find((c) => c.id === id);
  return m ? path.join(pastaModelos(), m.pasta) : null;
};

/**
 * Acha os arquivos do modelo pelo padrao do nome, em vez de fixar o nome exato.
 * Cada modelo do sherpa nomeia o encoder de um jeito ("encoder-epoch-99-avg-1"
 * num, "encoder-epoch-12-avg-2-chunk-16-left-128" noutro), entao fixar o nome
 * quebra na primeira troca de modelo.
 */
function localizarArquivos(id) {
  const pasta = pastaDe(id);
  if (!pasta || !existe(pasta)) return null;

  const arquivos = fs.readdirSync(pasta);
  // Prefere as versoes int8 quando existem: sao bem mais rapidas e a perda de
  // precisao e pequena -- e atraso e o que mais importa aqui.
  const acha = (prefixo) => {
    const candidatos = arquivos.filter((a) => a.startsWith(prefixo) && a.endsWith('.onnx'));
    if (!candidatos.length) return null;
    const int8 = candidatos.find((a) => a.includes('int8'));
    return path.join(pasta, int8 || candidatos[0]);
  };

  const encoder = acha('encoder');
  const decoder = acha('decoder');
  const joiner = acha('joiner');
  const tokens = arquivos.includes('tokens.txt') ? path.join(pasta, 'tokens.txt') : null;

  if (!encoder || !decoder || !joiner || !tokens) return null;
  return { encoder, decoder, joiner, tokens };
}

/** O que ja esta baixado. */
function status() {
  return {
    vadInstalado: existe(caminhoVad()),
    modelosBaixados: CATALOGO.filter((m) => localizarArquivos(m.id) !== null).map((m) => m.id),
    catalogo: CATALOGO,
    pasta: pastaModelos(),
  };
}

/** Baixa o detector de voz e o reconhecedor pedido. */
async function instalar(idModelo, aoProgresso) {
  const modelo = CATALOGO.find((m) => m.id === idModelo);
  if (!modelo) throw new Error(`reconhecedor desconhecido: ${idModelo}`);

  await fsp.mkdir(pastaModelos(), { recursive: true });

  if (!existe(caminhoVad())) {
    await baixar(URL_VAD, caminhoVad(), aoProgresso, 'detector de voz');
  }

  if (!localizarArquivos(idModelo)) {
    const tar = path.join(pastaModelos(), `${modelo.pasta}.tar.bz2`);
    if (!existe(tar)) {
      await baixar(`${BASE}/${modelo.pasta}.tar.bz2`, tar, aoProgresso, modelo.nome);
    }
    if (aoProgresso) aoProgresso({ rotulo: 'descompactando o reconhecedor', porcento: null });
    await descompactarTarBz2(tar, pastaModelos());
    await fsp.rm(tar, { force: true });

    if (!localizarArquivos(idModelo)) {
      throw new Error(
        `o pacote de ${modelo.nome} nao trouxe encoder/decoder/joiner/tokens onde eu esperava`
      );
    }
  }
}

module.exports = { CATALOGO, status, instalar, localizarArquivos, caminhoVad, definirRaiz, pastaModelos };

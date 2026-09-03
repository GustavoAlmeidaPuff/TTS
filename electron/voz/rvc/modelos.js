'use strict';

/**
 * Modelos da troca de timbre: o que existe, o que falta, e como baixar.
 *
 * Sao tres coisas diferentes:
 *  - as duas redes FIXAS (conteudo e melodia), iguais pra qualquer voz;
 *  - as VOZES ALVO, uma por timbre.
 *
 * Somando, a primeira instalacao passa de 800 MB. Por isso nada disso vem no
 * repositorio: baixa sob demanda, uma vez.
 */

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');

const { baixar, existe } = require('../../comum/baixador');

const BASE = 'https://huggingface.co/ozada/onnx_rvc/resolve/main';

/** As duas redes que nao dependem da voz escolhida. */
const FIXOS = [
  { arquivo: 'vec-768-layer-12.onnx', nome: 'extrator de conteúdo', mb: 360 },
  { arquivo: 'rmvpe.onnx', nome: 'detector de melodia', mb: 345 },
];

/**
 * Vozes alvo.
 *
 * De proposito so as genericas. O mesmo repositorio tem modelos de PESSOAS
 * REAIS (cantores, politicos) -- num app que injeta audio como microfone, usar
 * a voz de alguem real e personificacao, entao elas nao entram no catalogo.
 */
const VOZES = [
  {
    id: 'woman_3',
    nome: 'Feminina 3',
    descricao: 'A mais encorpada. Sai em 48 kHz.',
    mb: 106,
    tomSugerido: 220,
    padrao: true,
  },
  { id: 'woman_1', nome: 'Feminina 1', descricao: 'Mais leve e clara.', mb: 106, tomSugerido: 200 },
  { id: 'woman_2', nome: 'Feminina 2', descricao: 'Intermediária.', mb: 106, tomSugerido: 205 },
];

let raiz = path.join(os.homedir(), '.voz-tts');
function definirRaiz(novaRaiz) {
  raiz = novaRaiz;
}

const pasta = () => path.join(raiz, 'rvc');
const caminhoDe = (arquivo) => path.join(pasta(), arquivo);

/** Caminhos das tres redes de uma voz, ou null se faltar alguma. */
function arquivosDaVoz(idVoz) {
  const contentvec = caminhoDe('vec-768-layer-12.onnx');
  const rmvpe = caminhoDe('rmvpe.onnx');
  const gerador = caminhoDe(`${idVoz}.onnx`);
  if (!existe(contentvec) || !existe(rmvpe) || !existe(gerador)) return null;
  return { contentvec, rmvpe, gerador };
}

/** O que ja esta baixado. A interface decide o que oferecer a partir disto. */
function status() {
  const fixosBaixados = FIXOS.every((f) => existe(caminhoDe(f.arquivo)));
  const vozesBaixadas = VOZES.filter((v) => existe(caminhoDe(`${v.id}.onnx`))).map((v) => v.id);

  const faltamMb =
    FIXOS.filter((f) => !existe(caminhoDe(f.arquivo))).reduce((a, f) => a + f.mb, 0) +
    (vozesBaixadas.length ? 0 : (VOZES.find((v) => v.padrao) || VOZES[0]).mb);

  return {
    pronto: fixosBaixados && vozesBaixadas.length > 0,
    fixosBaixados,
    vozesBaixadas,
    catalogo: VOZES,
    faltamMb,
    pasta: pasta(),
  };
}

/**
 * Baixa o que falta pra usar a voz pedida.
 * As redes fixas so sao baixadas na primeira vez; trocar de voz depois custa
 * so os ~106 MB do gerador.
 */
async function instalar(idVoz, aoProgresso) {
  const voz = VOZES.find((v) => v.id === idVoz);
  if (!voz) throw new Error(`voz desconhecida: ${idVoz}`);

  await fsp.mkdir(pasta(), { recursive: true });

  for (const fixo of FIXOS) {
    if (!existe(caminhoDe(fixo.arquivo))) {
      await baixar(`${BASE}/${fixo.arquivo}`, caminhoDe(fixo.arquivo), aoProgresso, fixo.nome);
    }
  }

  const gerador = caminhoDe(`${voz.id}.onnx`);
  if (!existe(gerador)) {
    await baixar(`${BASE}/${voz.id}.onnx`, gerador, aoProgresso, `voz ${voz.nome}`);
  }
}

/** Onde fica guardada a escolha de GPU, pra sondar uma vez na vida. */
const cacheGpu = () => path.join(raiz, 'gpu-escolhida.json');

module.exports = { VOZES, FIXOS, status, instalar, arquivosDaVoz, definirRaiz, pasta, cacheGpu };

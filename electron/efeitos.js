'use strict';

/**
 * Pasta de efeitos sonoros.
 *
 * O app nao copia nem converte nada: aponta pra uma pasta sua e le os arquivos
 * de la. Trocar a pasta e trocar o conjunto inteiro de efeitos -- que e como
 * quem usa isso pensa ("hoje vou usar os efeitos da live", "agora os do jogo").
 *
 * Os arquivos sobem pela ponte como bytes crus. Ler o disco direto da interface
 * exigiria abrir o `file://` no CSP, e ai qualquer coisa na pagina poderia ler
 * qualquer arquivo da maquina. Aqui a interface so consegue ler o que esta
 * dentro da pasta que a pessoa escolheu, e o teste disso e feito aqui embaixo.
 */

const fs = require('fs');
const path = require('path');

/** Formatos que o Chromium decodifica sem ajuda. */
const EXTENSOES = new Set(['.mp3', '.wav', '.ogg', '.opus', '.m4a', '.aac', '.flac', '.webm']);

/** Um efeito nao e uma trilha: passando disso quase certamente e engano. */
const TAMANHO_MAXIMO = 64 * 1024 * 1024;

/** "risada-do-chaves_02.mp3" -> "risada do chaves 02" */
function apelidar(arquivo) {
  return path
    .basename(arquivo, path.extname(arquivo))
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Lista os audios de uma pasta, em ordem alfabetica e sem entrar em subpastas.
 *
 * Sem recursao de proposito: os botoes sao uma grade unica e chapada, e uma
 * arvore de pastas viraria navegacao -- exatamente o que atrapalha na hora de
 * apertar o efeito certo no meio de uma conversa.
 *
 * @param {string} pasta
 * @returns {{ok: boolean, erro?: string, pasta?: string, efeitos?: Array<{nome: string, arquivo: string, caminho: string, bytes: number}>}}
 */
function listar(pasta) {
  if (!pasta) return { ok: false, erro: 'nenhuma pasta escolhida' };
  let entradas;
  try {
    entradas = fs.readdirSync(pasta, { withFileTypes: true });
  } catch (e) {
    return { ok: false, erro: `não consegui ler a pasta: ${e.message}` };
  }

  const efeitos = [];
  for (const entrada of entradas) {
    if (!entrada.isFile()) continue;
    if (!EXTENSOES.has(path.extname(entrada.name).toLowerCase())) continue;
    const caminho = path.join(pasta, entrada.name);
    let bytes = 0;
    try {
      bytes = fs.statSync(caminho).size;
    } catch (_) {
      continue;
    }
    if (bytes === 0 || bytes > TAMANHO_MAXIMO) continue;
    efeitos.push({ nome: apelidar(entrada.name), arquivo: entrada.name, caminho, bytes });
  }

  efeitos.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  return { ok: true, pasta, efeitos };
}

/**
 * Le um efeito, mas so se ele estiver mesmo dentro da pasta escolhida.
 *
 * A checagem e por caminho resolvido, nao pelo texto do pedido: sem isso um
 * "../../.ssh/id_rsa" passaria, porque como texto ele comeca com a pasta certa.
 *
 * @param {string} pasta pasta escolhida no momento
 * @param {string} caminho arquivo pedido pela interface
 */
function ler(pasta, caminho) {
  if (!pasta) return { ok: false, erro: 'nenhuma pasta escolhida' };

  const raiz = path.resolve(pasta);
  const alvo = path.resolve(caminho);
  const dentro = alvo === raiz ? false : !path.relative(raiz, alvo).startsWith('..');
  if (!dentro || path.dirname(alvo) !== raiz) {
    return { ok: false, erro: 'esse arquivo não está na pasta de efeitos' };
  }
  if (!EXTENSOES.has(path.extname(alvo).toLowerCase())) {
    return { ok: false, erro: 'formato de áudio não suportado' };
  }

  try {
    const { size } = fs.statSync(alvo);
    if (size > TAMANHO_MAXIMO) return { ok: false, erro: 'arquivo grande demais para um efeito' };
    // Uint8Array porque Buffer nao sobrevive a travessia: chegaria do outro
    // lado como um objeto com um campo `data`, e nao como bytes.
    return { ok: true, audio: new Uint8Array(fs.readFileSync(alvo)) };
  } catch (e) {
    return { ok: false, erro: e.message };
  }
}

module.exports = { listar, ler, apelidar, EXTENSOES };

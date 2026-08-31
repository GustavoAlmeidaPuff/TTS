'use strict';

/**
 * Motor Piper: sintese de voz 100% offline, rodando na CPU.
 *
 * Diferente do motor Edge, aqui nao tem servidor, nao tem token e nao tem nada
 * pra quebrar quando a Microsoft mudar de ideia. A voz e um pouco menos natural,
 * mas e a rede de seguranca do app -- e e o caminho pro modo de baixa latencia
 * mais adiante, porque nao paga ida e volta de internet.
 *
 * O binario e os modelos nao vem no repositorio (sao ~21MB + ~60MB cada voz):
 * o app baixa sob demanda pra pasta de dados do usuario.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const crypto = require('crypto');

const { baixar, descompactarZip, existe } = require('../comum/baixador');

const URL_BINARIO =
  'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip';
const BASE_VOZES = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';

/** Catalogo enxuto. Cada voz sao dois arquivos: o modelo e o json de config. */
const CATALOGO = [
  {
    id: 'pt_BR-faber-medium',
    nome: 'Faber',
    lingua: 'pt-BR',
    genero: 'Masculina',
    qualidade: 'media',
    caminho: 'pt/pt_BR/faber/medium/pt_BR-faber-medium',
  },
  {
    id: 'pt_BR-edresson-low',
    nome: 'Edresson',
    lingua: 'pt-BR',
    genero: 'Masculina',
    qualidade: 'baixa',
    caminho: 'pt/pt_BR/edresson/low/pt_BR-edresson-low',
  },
  {
    id: 'en_US-amy-medium',
    nome: 'Amy',
    lingua: 'en-US',
    genero: 'Feminina',
    qualidade: 'media',
    caminho: 'en/en_US/amy/medium/en_US-amy-medium',
  },
];

// A pasta de dados e injetada pelo index.js pra este modulo nao depender do
// Electron (assim da pra testar ele com node puro).
let raiz = path.join(os.homedir(), '.voz-tts');
function definirRaiz(novaRaiz) {
  raiz = novaRaiz;
}

const pastaBinario = () => path.join(raiz, 'piper');
const pastaVozes = () => path.join(raiz, 'vozes');
const caminhoExe = () => path.join(pastaBinario(), 'piper', 'piper.exe');
const caminhoModelo = (id) => path.join(pastaVozes(), `${id}.onnx`);

/** O que ja esta baixado. A interface usa isso pra decidir o que oferecer. */
function status() {
  const vozesBaixadas = CATALOGO.filter(
    (v) => existe(caminhoModelo(v.id)) && existe(`${caminhoModelo(v.id)}.json`)
  ).map((v) => v.id);

  return {
    binarioInstalado: existe(caminhoExe()),
    vozesBaixadas,
    catalogo: CATALOGO,
    pasta: raiz,
  };
}

/** Instala o binario (se faltar) e a voz pedida. */
async function instalar(idVoz, aoProgresso) {
  const voz = CATALOGO.find((v) => v.id === idVoz);
  if (!voz) throw new Error(`voz desconhecida: ${idVoz}`);

  if (!existe(caminhoExe())) {
    const zip = path.join(raiz, 'piper.zip');
    await baixar(URL_BINARIO, zip, aoProgresso, 'motor Piper');
    if (aoProgresso) aoProgresso({ rotulo: 'descompactando o motor', porcento: null });
    await fsp.mkdir(pastaBinario(), { recursive: true });
    await descompactarZip(zip, pastaBinario());
    await fsp.rm(zip, { force: true });
    if (!existe(caminhoExe())) throw new Error('o zip do Piper nao trouxe piper.exe onde eu esperava');
  }

  const modelo = caminhoModelo(voz.id);
  if (!existe(modelo)) {
    await baixar(`${BASE_VOZES}/${voz.caminho}.onnx`, modelo, aoProgresso, `voz ${voz.nome}`);
  }
  if (!existe(`${modelo}.json`)) {
    await baixar(
      `${BASE_VOZES}/${voz.caminho}.onnx.json`,
      `${modelo}.json`,
      aoProgresso,
      `ajustes da voz ${voz.nome}`
    );
  }
}

/** Vozes prontas pra uso agora (so as ja baixadas). */
async function listarVozes() {
  const { vozesBaixadas } = status();
  return CATALOGO.filter((v) => vozesBaixadas.includes(v.id)).map((v) => ({
    id: v.id,
    nome: v.nome,
    lingua: v.lingua,
    genero: v.genero,
    personalidade: [],
    motor: 'piper',
  }));
}

/**
 * Sintetiza pra WAV.
 * O Piper controla velocidade por "length_scale": maior = mais lento. Converto
 * a escala de porcentagem da interface (-50..+50) pra esse fator.
 */
function sintetizar({ texto, voz, velocidade = 0 }) {
  return new Promise((resolve, reject) => {
    if (!existe(caminhoExe())) return reject(new Error('o motor Piper ainda nao foi baixado'));
    const modelo = caminhoModelo(voz);
    if (!existe(modelo)) return reject(new Error(`a voz ${voz} ainda nao foi baixada`));

    const escala = Math.min(2.5, Math.max(0.4, 1 / (1 + Number(velocidade) / 100)));
    const saida = path.join(os.tmpdir(), `voz-tts-${crypto.randomBytes(6).toString('hex')}.wav`);

    const proc = spawn(
      caminhoExe(),
      ['--model', modelo, '--output_file', saida, '--length_scale', String(escala)],
      { cwd: path.dirname(caminhoExe()), windowsHide: true }
    );

    let erro = '';
    proc.stderr.on('data', (d) => (erro += d));
    proc.on('error', (e) => reject(new Error(`nao consegui rodar o Piper: ${e.message}`)));

    proc.on('close', async (codigo) => {
      try {
        if (codigo !== 0) throw new Error(`Piper saiu com codigo ${codigo}: ${erro.slice(-300)}`);
        const audio = await fsp.readFile(saida);
        resolve(audio);
      } catch (e) {
        reject(e);
      } finally {
        fsp.rm(saida, { force: true }).catch(() => {});
      }
    });

    proc.stdin.write(texto);
    proc.stdin.end();
  });
}

module.exports = { status, instalar, listarVozes, sintetizar, definirRaiz, CATALOGO };

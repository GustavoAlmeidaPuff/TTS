'use strict';

/**
 * Registro de motores de voz. A interface fala so com este arquivo, entao
 * acrescentar um motor novo (Piper, XTTS, o que for) nao mexe em mais nada.
 */

const edge = require('./edge');
const piper = require('./piper');

// De proposito este arquivo NAO decide sozinho onde ficam os modelos do Piper.
// Quem manda e o main.js, via piper.definirRaiz(), depois de fixar o nome do
// app -- senao a pasta muda conforme o jeito de iniciar o Electron, e o app
// perde de vista o que ja baixou.

const MOTORES = {
  edge: {
    id: 'edge',
    nome: 'Edge (online)',
    descricao: 'Vozes neurais da Microsoft. As mais naturais, mas precisam de internet.',
    online: true,
    listarVozes: edge.listarVozes,
    sintetizar: edge.sintetizar,
    mime: 'audio/mpeg',
  },
  piper: {
    id: 'piper',
    nome: 'Piper (offline)',
    descricao: 'Roda na sua maquina, sem internet. Voz um pouco menos natural.',
    online: false,
    listarVozes: piper.listarVozes,
    sintetizar: piper.sintetizar,
    mime: 'audio/wav',
  },
};

function listarMotores() {
  return Object.values(MOTORES).map(({ id, nome, descricao, online }) => ({
    id,
    nome,
    descricao,
    online,
  }));
}

function pegar(id) {
  const motor = MOTORES[id];
  if (!motor) throw new Error(`motor desconhecido: ${id}`);
  return motor;
}

async function listarVozes(idMotor) {
  return pegar(idMotor).listarVozes();
}

/**
 * @returns {Promise<{audio: Buffer, mime: string}>}
 */
async function sintetizar(pedido) {
  const motor = pegar(pedido.motor);
  const audio = await motor.sintetizar(pedido);
  return { audio, mime: motor.mime };
}

module.exports = { listarMotores, listarVozes, sintetizar, piper };

'use strict';

/**
 * O runtime ONNX do app, e a ORDEM em que ele tem que ser carregado.
 *
 * ---------------------------------------------------------------------------
 * LEIA ANTES DE MEXER
 * ---------------------------------------------------------------------------
 * Duas bibliotecas do projeto trazem cada uma a SUA copia do ONNX Runtime:
 *
 *   sherpa-onnx-node  -> onnxruntime.dll 1.27.1  (17 MB) -- reconhecimento
 *   onnxruntime-node  -> onnxruntime.dll 1.29.0  (28 MB) -- conversao de voz
 *
 * As duas nao convivem em qualquer ordem. Carregando o sherpa primeiro, o
 * `onnxruntime-node` morre com "error: 182" (ordinal invalido) -- o Windows ja
 * tem uma onnxruntime.dll carregada e os simbolos nao batem.
 *
 * Ao contrario funciona: carregando o `onnxruntime-node` PRIMEIRO, os dois
 * sobem. Por isso este arquivo existe e por isso ele e importado na primeira
 * linha do main.js, antes de qualquer coisa que possa puxar o sherpa.
 *
 * Se um dia aparecer "error: 182", a causa e essa: alguem carregou o sherpa
 * antes. Nao adianta reinstalar nada.
 * ---------------------------------------------------------------------------
 */

const ort = require('onnxruntime-node');

/** Chame no inicio do processo, antes de qualquer require de sherpa-onnx. */
function garantirOrdem() {
  return ort;
}

module.exports = { ort, garantirOrdem };

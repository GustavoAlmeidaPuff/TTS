/**
 * Coletor de audio do microfone, rodando na thread de audio.
 *
 * Fica aqui, e nao na thread principal, porque a thread de audio nunca e
 * bloqueada por repintura de tela -- e um engasgo aqui viraria um buraco no
 * audio, nao um quadro perdido.
 *
 * Junta os blocos de 128 amostras que o navegador entrega ate formar um pedaco
 * do tamanho pedido, e manda pra fora junto com o nivel de volume (pro
 * medidor da interface).
 */
class ColetorDeVoz extends AudioWorkletProcessor {
  constructor(opcoes) {
    super();
    const { amostrasPorPedaco = 1600 } = (opcoes && opcoes.processorOptions) || {};
    this.tamanho = amostrasPorPedaco;
    this.acumulado = new Float32Array(this.tamanho);
    this.usado = 0;
  }

  process(entradas) {
    const canal = entradas[0] && entradas[0][0];
    // Sem entrada (microfone mudo ou desconectado): mantem o processador vivo.
    if (!canal) return true;

    for (let i = 0; i < canal.length; i++) {
      this.acumulado[this.usado++] = canal[i];

      if (this.usado === this.tamanho) {
        let soma = 0;
        for (let j = 0; j < this.tamanho; j++) soma += this.acumulado[j] * this.acumulado[j];

        // Copia antes de mandar: o buffer local continua sendo reescrito.
        this.port.postMessage({
          amostras: this.acumulado.slice(),
          nivel: Math.sqrt(soma / this.tamanho),
        });
        this.usado = 0;
      }
    }

    return true;
  }
}

registerProcessor('coletor-de-voz', ColetorDeVoz);

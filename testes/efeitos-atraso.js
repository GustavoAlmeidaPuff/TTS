// Mede DE ONDE vem o atraso entre apertar o botão e ouvir o efeito.
//
// São quatro suspeitos e eles se somam:
//   1. silêncio no começo do próprio arquivo (rip de YouTube quase sempre tem)
//   2. o caminho JS até `fonte.start()` (awaits, decodificação, resume)
//   3. a latência do AudioContext (baseLatency + outputLatency)
//   4. o `resume()` de um contexto que nasceu suspenso
//
//   npx electron testes/efeitos-atraso.js [pasta]
const { app } = require('electron');
const path = require('path');
const { abrirApp, esperar, relatar } = require('./comum');

const PASTA = process.argv[2] || path.join(require('os').homedir(), 'Music', 'sound efects');

(async () => {
  const { janela, mensagens } = await abrirApp();

  await janela.webContents.executeJavaScript(`document.getElementById('aba-efeitos').click(); true`);
  await esperar(600);

  const medida = await janela.webContents.executeJavaScript(`(async () => {
    const t0 = performance.now();
    await window.efeitos.usarPasta(${JSON.stringify(PASTA)});
    const msListar = performance.now() - t0;

    // Espera o aquecimento terminar pra medir o caso BOM (tudo decodificado).
    const alvo = window.__efeitos.lista.length;
    for (let i = 0; i < 100 && window.__efeitos.buffers.size < alvo; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }

    /** Primeira amostra acima do limiar, em ms desde o começo do arquivo. */
    const silencioInicial = (buffer, limiar) => {
      const dados = buffer.getChannelData(0);
      for (let i = 0; i < dados.length; i++) {
        if (Math.abs(dados[i]) > limiar) return (i / buffer.sampleRate) * 1000;
      }
      return (buffer.duration * 1000);
    };

    const arquivos = window.__efeitos.lista.map((efeito) => {
      const b = window.__efeitos.buffers.get(efeito.caminho);
      if (!b) return { nome: efeito.nome, erro: 'não decodificou' };
      return {
        nome: efeito.nome,
        duracaoS: +b.duration.toFixed(2),
        taxa: b.sampleRate,
        // Três limiares: -60 dB é "qualquer coisa", -40 dB é audível,
        // -26 dB já é o corpo do som.
        silencioAte_60dB: +silencioInicial(b, 0.001).toFixed(1),
        silencioAte_40dB: +silencioInicial(b, 0.01).toFixed(1),
        silencioAte_26dB: +silencioInicial(b, 0.05).toFixed(1),
      };
    });

    const ctxs = (window.__efeitos.saidas || []).map((s) => ({
      dispositivo: s.rotulo,
      estado: s.ctx.state,
      taxa: s.ctx.sampleRate,
      baseLatencyMs: +(s.ctx.baseLatency * 1000).toFixed(1),
      outputLatencyMs: +((s.ctx.outputLatency || 0) * 1000).toFixed(1),
    }));

    const cortes = window.__efeitos.lista.map((i) => ({
      nome: i.nome.slice(0, 28),
      cortadoMs: Math.round((window.__efeitos.inicios.get(i.caminho) || 0) * 1000),
    }));

    return { msListar: +msListar.toFixed(1), arquivos, cortes, ctxs };
  })()`);

  // ---------------------------------------------------- caminho do aperto
  // Cronometra o trecho JS entre o pointerdown e o fonte.start() de verdade,
  // instrumentando o AudioContext por fora.
  const caminhoDoAperto = await janela.webContents.executeJavaScript(`(async () => {
    const medir = async () => {
      const ctx = window.__efeitos.saidas[0].ctx;
      const criarOriginal = ctx.createBufferSource.bind(ctx);
      let marcaStart = null;
      ctx.createBufferSource = () => {
        const fonte = criarOriginal();
        const startOriginal = fonte.start.bind(fonte);
        fonte.start = (...a) => { if (marcaStart === null) marcaStart = performance.now(); return startOriginal(...a); };
        return fonte;
      };

      const b = document.querySelector('#grade-efeitos .efeito');
      const t = performance.now();
      b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1 }));
      for (let i = 0; i < 200 && marcaStart === null; i++) await new Promise((r) => setTimeout(r, 5));
      const jsMs = marcaStart === null ? -1 : marcaStart - t;
      b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1 }));
      ctx.createBufferSource = criarOriginal;
      await new Promise((r) => setTimeout(r, 200));
      return +jsMs.toFixed(1);
    };

    const primeiro = await medir();   // pode incluir o resume() do contexto
    const segundo = await medir();    // contexto já rodando
    const terceiro = await medir();
    return { primeiroApertoMs: primeiro, depoisMs: [segundo, terceiro] };
  })()`);

  relatar('DE ONDE VEM O ATRASO', mensagens, { ...medida, caminhoDoAperto });
  app.exit(0);
})().catch((e) => {
  console.error('FALHOU:', e.message);
  console.error(e.stack);
  app.exit(1);
});

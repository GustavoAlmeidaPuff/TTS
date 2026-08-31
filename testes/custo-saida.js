// Quanto custa cada etapa de tocar um trecho? A suspeita e que o setSinkId
// repetido (mesmo com o dispositivo inalterado) esteja pagando reconfiguracao
// de placa de audio a cada trecho -- tempo morto que a fila nao recupera.
const { app } = require('electron');
const { abrirApp } = require('./comum');

(async () => {
  const { janela } = await abrirApp();

  const medida = await janela.webContents.executeJavaScript(`(async () => {
    const r = await window.api.falar({
      motor: 'piper', texto: 'back to', voz: 'en_US-amy-medium', velocidade: 0, tom: 0,
    });
    if (!r.ok) return { erro: r.erro };
    const blob = new Blob([r.audio], { type: r.mime });

    const saida = document.getElementById('saida').value;
    const audio = new Audio();
    const resultados = { comSink: [], semSink: [], duracaoAudio: null };

    const tocar = async (usarSink) => {
      const url = URL.createObjectURL(blob);
      const t0 = performance.now();
      audio.src = url;
      let tSink = t0;
      if (usarSink) { await audio.setSinkId(saida); tSink = performance.now(); }
      const tPlay = performance.now();
      await new Promise((res, rej) => {
        audio.onended = res;
        audio.onerror = rej;
        audio.play().then(() => {}, rej);
      });
      const fim = performance.now();
      URL.revokeObjectURL(url);
      resultados.duracaoAudio = audio.duration * 1000;
      return { sinkMs: tSink - t0, ateTocar: tPlay - t0, total: fim - t0 };
    };

    // Aquece (a primeira sempre custa mais).
    await tocar(true);

    for (let i = 0; i < 4; i++) resultados.comSink.push(await tocar(true));
    for (let i = 0; i < 4; i++) resultados.semSink.push(await tocar(false));
    return resultados;
  })()`);

  if (medida.erro) {
    console.error('FALHOU: ' + medida.erro);
    return app.exit(1);
  }

  const media = (lista, campo) =>
    (lista.reduce((a, b) => a + b[campo], 0) / lista.length).toFixed(1);

  console.log('duracao real do audio: ' + medida.duracaoAudio.toFixed(0) + 'ms\n');
  console.log('COM setSinkId a cada trecho:');
  console.log('  setSinkId levou : ' + media(medida.comSink, 'sinkMs') + 'ms');
  console.log('  ate comecar     : ' + media(medida.comSink, 'ateTocar') + 'ms');
  console.log('  total por trecho: ' + media(medida.comSink, 'total') + 'ms');
  console.log('\nSEM setSinkId (dispositivo ja configurado):');
  console.log('  ate comecar     : ' + media(medida.semSink, 'ateTocar') + 'ms');
  console.log('  total por trecho: ' + media(medida.semSink, 'total') + 'ms');

  const economia = media(medida.comSink, 'total') - media(medida.semSink, 'total');
  console.log('\nECONOMIA por trecho: ' + economia.toFixed(1) + 'ms');
  console.log('(com ~7 trechos numa frase de 7s, isso e ' + (economia * 7 / 1000).toFixed(2) + 's)');

  app.quit();
})().catch((e) => {
  console.error('FALHOU:', e.message, e.stack);
  app.exit(1);
});

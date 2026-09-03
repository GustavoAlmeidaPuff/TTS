// Confere que a aba "Trocar timbre" sobe, acha os modelos e liga os controles.
//   npx electron testes/timbre.js
const { app } = require('electron');
const { abrirApp, esperar, fotografar, relatar } = require('./comum');

(async () => {
  const { janela, mensagens } = await abrirApp();

  await janela.webContents.executeJavaScript(`document.getElementById('aba-timbre').click(); true`);
  await esperar(2500);

  const estado = await janela.webContents.executeJavaScript(`(() => {
    const v = (id) => { const e = document.getElementById(id); return e ? e.value : null; };
    const vis = (id) => { const e = document.getElementById(id); return e ? !e.classList.contains('oculto') : null; };
    const ops = (id) => {
      const e = document.getElementById(id);
      return e ? [...e.options].map((o) => o.textContent) : [];
    };
    return {
      abaAtiva: document.querySelector('.aba.ativa').textContent.trim(),
      painelTimbreVisivel: vis('modo-timbre'),
      painelDigitarVisivel: vis('modo-digitar'),
      painelVivoVisivel: vis('modo-vivo'),
      ajustesTimbreVisiveis: vis('grupo-timbre'),
      historicoVisivel: vis('bloco-historico'),
      precisaBaixar: vis('timbre-instalar'),
      prontoVisivel: vis('timbre-pronto'),
      vozes: ops('voz-timbre'),
      vozEscolhida: v('voz-timbre'),
      alvoHz: v('alvo-hz'),
      microfones: ops('microfone-timbre'),
      microfoneEscolhido: document.getElementById('microfone-timbre').selectedOptions[0]
        ? document.getElementById('microfone-timbre').selectedOptions[0].textContent : null,
      botaoLiberado: !document.getElementById('btn-timbre').disabled,
      temModuloTimbre: typeof window.timbre === 'object',
      larguraBody: document.body.scrollWidth,
    };
  })()`);

  await fotografar(janela, 'tela-timbre.png');

  // Volta pra Digitar: os dois modos antigos precisam continuar inteiros.
  await janela.webContents.executeJavaScript(`document.getElementById('aba-digitar').click(); true`);
  await esperar(600);
  const voltou = await janela.webContents.executeJavaScript(`(() => ({
    abaAtiva: document.querySelector('.aba.ativa').textContent.trim(),
    digitarVisivel: !document.getElementById('modo-digitar').classList.contains('oculto'),
    timbreVisivel: !document.getElementById('modo-timbre').classList.contains('oculto'),
    historicoVisivel: !document.getElementById('bloco-historico').classList.contains('oculto'),
  }))()`);

  relatar('ABA TIMBRE', mensagens, estado);
  console.log('\n=== VOLTOU PRA DIGITAR ===');
  console.log(JSON.stringify(voltou, null, 2));

  app.quit();
})().catch((e) => {
  console.error('FALHOU:', e.message);
  console.error(e.stack);
  app.exit(1);
});

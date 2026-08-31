// Sobe a tela real, confere o estado dos controles e tira uma foto de cada modo.
//   npx electron testes/tela.js
const { app } = require('electron');
const { abrirApp, esperar, fotografar, relatar } = require('./comum');

(async () => {
  const { janela, mensagens } = await abrirApp();

  const lerEstado = () =>
    janela.webContents.executeJavaScript(`(() => {
      const v = (id) => { const e = document.getElementById(id); return e ? e.value : null; };
      const opcoes = (id) => {
        const e = document.getElementById(id);
        return e ? [...e.options].map((o) => o.textContent) : [];
      };
      const visivel = (id) => {
        const e = document.getElementById(id);
        return e ? !e.classList.contains('oculto') : null;
      };
      return {
        estado: document.getElementById('estado').textContent,
        classePonto: document.getElementById('ponto-estado').className,
        abaAtiva: document.querySelector('.aba.ativa').textContent.trim(),
        modoDigitarVisivel: visivel('modo-digitar'),
        modoVivoVisivel: visivel('modo-vivo'),
        motor: v('motor'),
        voz: v('voz'),
        vozes: opcoes('voz').length,
        saidaEscolhida: document.getElementById('saida').selectedOptions[0]
          ? document.getElementById('saida').selectedOptions[0].textContent : null,
        microfones: opcoes('microfone'),
        microfoneEscolhido: document.getElementById('microfone').selectedOptions[0]
          ? document.getElementById('microfone').selectedOptions[0].textContent : null,
        reconhecedores: opcoes('modelo-voz'),
        reconhecedorEscolhido: v('modelo-voz'),
        precisaBaixarReconhecedor: visivel('vivo-instalar'),
        botaoMicrofoneLiberado: !document.getElementById('btn-microfone').disabled,
        avisoCaboVisivel: visivel('aviso-cabo'),
        temSetSinkId: typeof (new Audio()).setSinkId === 'function',
        larguraBody: document.body.scrollWidth,
      };
    })()`);

  const digitar = await lerEstado();
  await fotografar(janela, 'tela-digitar.png');

  // Troca pro modo ao vivo e confere de novo.
  await janela.webContents.executeJavaScript(
    `document.getElementById('aba-vivo').click(); true`
  );
  await esperar(1200);
  const vivo = await lerEstado();
  await fotografar(janela, 'tela-vivo.png');

  relatar('MODO DIGITAR', mensagens, digitar);
  console.log('\n=== MODO AO VIVO ===');
  console.log(JSON.stringify(vivo, null, 2));

  app.quit();
})().catch((e) => {
  console.error('FALHOU:', e.message);
  console.error(e.stack);
  app.exit(1);
});

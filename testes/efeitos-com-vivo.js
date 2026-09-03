// Prova que efeito e fala ao vivo rodam JUNTOS, e que os dois saem pelo mesmo
// dispositivo (o cabo virtual = seu microfone lá no Discord).
//
// A regressão que este teste tranca: sair da aba Ao vivo desligava o microfone,
// então ir buscar um efeito matava a fala. Agora só um modo que TAMBÉM captura
// (Trocar timbre) tem esse direito.
//
//   npx electron testes/efeitos-com-vivo.js [pasta]
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { abrirApp, esperar, relatar } = require('./comum');

function gerarWav(destino, segundos, hz, taxa = 44100) {
  const amostras = Math.round(segundos * taxa);
  const dados = Buffer.alloc(amostras * 2);
  for (let i = 0; i < amostras; i++) {
    dados.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / taxa) * 12000), i * 2);
  }
  const c = Buffer.alloc(44);
  c.write('RIFF', 0); c.writeUInt32LE(36 + dados.length, 4); c.write('WAVEfmt ', 8);
  c.writeUInt32LE(16, 16); c.writeUInt16LE(1, 20); c.writeUInt16LE(1, 22);
  c.writeUInt32LE(taxa, 24); c.writeUInt32LE(taxa * 2, 28); c.writeUInt16LE(2, 32);
  c.writeUInt16LE(16, 34); c.write('data', 36); c.writeUInt32LE(dados.length, 40);
  fs.writeFileSync(destino, Buffer.concat([c, dados]));
}

(async () => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'efeitos-vivo-'));
  // Longo de propósito: precisa sobreviver à troca de aba pra provar o ponto.
  gerarWav(path.join(pasta, 'efeito longo.wav'), 8, 440);

  const { janela, mensagens } = await abrirApp();

  // Carrega os efeitos sem sair da aba de origem.
  await janela.webContents.executeJavaScript(
    `window.efeitos.usarPasta(${JSON.stringify(pasta)})`
  );
  await esperar(1200);

  // ------------------------------------------------------- liga o ao vivo
  await janela.webContents.executeJavaScript(
    `document.getElementById('aba-vivo').click(); true`
  );
  await esperar(800);
  await janela.webContents.executeJavaScript(
    `document.getElementById('btn-microfone').click(); true`
  );
  await esperar(2500);

  const vivoLigado = await janela.webContents.executeJavaScript(`({
    ligado: microfone.ligado,
    aba: document.querySelector('.aba.ativa').textContent.trim(),
  })`);

  // ------------------- vai buscar um efeito: o microfone tem que continuar
  await janela.webContents.executeJavaScript(
    `document.getElementById('aba-efeitos').click(); true`
  );
  await esperar(800);

  const naAbaEfeitos = await janela.webContents.executeJavaScript(`({
    micAindaLigado: microfone.ligado,
    aba: document.querySelector('.aba.ativa').textContent.trim(),
  })`);

  // ------------------------------- dispara o efeito com o microfone no ar
  const juntos = await janela.webContents.executeJavaScript(`(async () => {
    // "até o fim" pra o som sobreviver à volta ao Ao vivo.
    document.querySelector('#disparo-efeitos [data-disparo="inteiro"]').click();
    const b = document.querySelector('#grade-efeitos .efeito');
    b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1 }));
    b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1 }));
    await new Promise((r) => setTimeout(r, 400));

    const saidaDoApp = document.getElementById('saida').value;
    return {
      efeitoSoando: window.__efeitos.tocando.size,
      micAindaLigado: microfone.ligado,
      contextos: window.__efeitos.saidas.map((s) => ({
        rotulo: s.rotulo,
        estado: s.ctx.state,
        // O efeito tem que sair pelo MESMO destino que a voz.
        mesmoDestinoDaVoz: s.rotulo !== 'saída principal' || s.dispositivo === saidaDoApp,
      })),
    };
  })()`);

  // -------------------- volta pro Ao vivo: o efeito não pode morrer no meio
  await janela.webContents.executeJavaScript(
    `document.getElementById('aba-vivo').click(); true`
  );
  await esperar(700);

  const devolta = await janela.webContents.executeJavaScript(`({
    efeitoAindaSoando: window.__efeitos.tocando.size,
    micAindaLigado: microfone.ligado,
    contextosVivos: window.__efeitos.saidas
      ? window.__efeitos.saidas.filter((s) => s.ctx.state === 'running').length : 0,
  })`);

  // ------ e Trocar timbre, que TAMBÉM captura, continua derrubando o ao vivo
  await janela.webContents.executeJavaScript(
    `document.getElementById('aba-timbre').click(); true`
  );
  await esperar(900);
  const noTimbre = await janela.webContents.executeJavaScript(
    `microfone.ligado`
  );

  relatar('EFEITOS + AO VIVO', mensagens, {
    vivoLigado, naAbaEfeitos, juntos, devolta, micNoTimbre: noTimbre,
  });

  const ok =
    vivoLigado.ligado === true &&
    naAbaEfeitos.micAindaLigado === true &&
    juntos.efeitoSoando === 1 &&
    juntos.micAindaLigado === true &&
    juntos.contextos.every((c) => c.estado === 'running' && c.mesmoDestinoDaVoz) &&
    devolta.efeitoAindaSoando === 1 &&
    devolta.micAindaLigado === true &&
    devolta.contextosVivos > 0 &&
    // A exclusividade que AINDA precisa valer: dois capturadores, não.
    noTimbre === false;

  console.log(ok ? '\nOK: efeito e ao vivo juntos, pelo mesmo cabo' : '\nFALHOU: ver o relatório');

  fs.rmSync(pasta, { recursive: true, force: true });
  app.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('FALHOU:', e.message);
  console.error(e.stack);
  app.exit(1);
});

// Sobe a tela real, aponta os efeitos pra uma pasta de teste e prova o que
// define o modo: o CUE só soa enquanto o botão está apertado, "até o fim"
// continua depois de soltar, o silêncio gravado na frente do arquivo é pulado,
// e a leitura não sai da pasta escolhida.
//   npx electron testes/efeitos.js
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { abrirApp, esperar, fotografar, relatar } = require('./comum');

/**
 * WAV mono 16 bits: `silencioS` segundos de nada e depois uma senoide.
 *
 * O silêncio na frente não é enfeite: é exatamente o que os efeitos baixados da
 * internet têm (os dois arquivos reais do usuário tinham 453 ms e 589 ms), e é
 * o que o corte do começo precisa achar.
 */
function gerarWav(destino, segundos = 2, hz = 440, silencioS = 0, taxa = 44100) {
  const mudas = Math.round(silencioS * taxa);
  const amostras = Math.round(segundos * taxa) + mudas;
  const dados = Buffer.alloc(amostras * 2);
  for (let i = mudas; i < amostras; i++) {
    dados.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * (i - mudas)) / taxa) * 12000), i * 2);
  }
  const cabecalho = Buffer.alloc(44);
  cabecalho.write('RIFF', 0);
  cabecalho.writeUInt32LE(36 + dados.length, 4);
  cabecalho.write('WAVEfmt ', 8);
  cabecalho.writeUInt32LE(16, 16);
  cabecalho.writeUInt16LE(1, 20); // PCM
  cabecalho.writeUInt16LE(1, 22); // mono
  cabecalho.writeUInt32LE(taxa, 24);
  cabecalho.writeUInt32LE(taxa * 2, 28);
  cabecalho.writeUInt16LE(2, 32);
  cabecalho.writeUInt16LE(16, 34);
  cabecalho.write('data', 36);
  cabecalho.writeUInt32LE(dados.length, 40);
  fs.writeFileSync(destino, Buffer.concat([cabecalho, dados]));
}

(async () => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'efeitos-'));
  gerarWav(path.join(pasta, 'risada-do-chaves.wav'), 2, 440, 0.5);
  gerarWav(path.join(pasta, 'tambor_grave.wav'), 2, 110, 0);
  gerarWav(path.join(pasta, 'apito agudo.wav'), 2, 1200, 0.5);
  // Ruído no meio: nem tudo numa pasta de efeitos é áudio.
  fs.writeFileSync(path.join(pasta, 'anotacoes.txt'), 'nao sou audio');

  const { janela, mensagens } = await abrirApp();

  await janela.webContents.executeJavaScript(`document.getElementById('aba-efeitos').click(); true`);
  await esperar(600);

  const carregou = await janela.webContents.executeJavaScript(`(async () => {
    await window.efeitos.usarPasta(${JSON.stringify(pasta)});
    return {
      pasta: window.__efeitos.pasta,
      lista: window.__efeitos.lista.map((i) => i.nome),
      botoes: [...document.querySelectorAll('#grade-efeitos .efeito')].map((b) => b.textContent),
      alturaDoBotao: document.querySelector('#grade-efeitos .efeito').getBoundingClientRect().height,
      saidas: window.__efeitos.saidas ? window.__efeitos.saidas.length : 0,
    };
  })()`);

  // Espera o aquecimento (decodificação em segundo plano) terminar.
  await esperar(1500);
  const aquecido = await janela.webContents.executeJavaScript(
    `window.__efeitos.buffers.size`
  );

  // O corte do começo: meio segundo de silêncio gravado não pode virar meio
  // segundo de espera depois do aperto.
  const cortes = await janela.webContents.executeJavaScript(`
    window.__efeitos.lista.map((i) => ({
      nome: i.nome,
      inicioMs: Math.round((window.__efeitos.inicios.get(i.caminho) || 0) * 1000),
    }))`);

  await fotografar(janela, 'tela-efeitos.png');

  // ------------------------------------------------ segurar e soltar
  const apertar = (tipo) => `(() => {
    const b = document.querySelector('#grade-efeitos .efeito');
    b.dispatchEvent(new PointerEvent(${JSON.stringify(tipo)}, {
      bubbles: true, button: 0, pointerId: 1, pointerType: 'mouse',
    }));
    return true;
  })()`;

  await janela.webContents.executeJavaScript(apertar('pointerdown'));
  await esperar(400);
  const segurando = await janela.webContents.executeJavaScript(`({
    soando: window.__efeitos.tocando.size,
    apertados: window.__efeitos.apertados.size,
    classe: document.querySelector('#grade-efeitos .efeito').className,
  })`);

  await janela.webContents.executeJavaScript(apertar('pointerup'));
  await esperar(400);
  const soltou = await janela.webContents.executeJavaScript(`({
    soando: window.__efeitos.tocando.size,
    apertados: window.__efeitos.apertados.size,
    classe: document.querySelector('#grade-efeitos .efeito').className,
  })`);

  // ------------------------------------------------ tocar até o fim
  await janela.webContents.executeJavaScript(
    `document.querySelector('#disparo-efeitos [data-disparo="inteiro"]').click(); true`
  );
  await esperar(200);
  await janela.webContents.executeJavaScript(apertar('pointerdown'));
  await janela.webContents.executeJavaScript(apertar('pointerup'));
  await esperar(500);
  // Soltou o botão faz tempo e o som tem que continuar.
  const inteiro = await janela.webContents.executeJavaScript(`({
    soandoDepoisDeSoltar: window.__efeitos.tocando.size,
    pararTudoVisivel: !document.getElementById('btn-parar-efeitos').classList.contains('oculto'),
  })`);

  // Apertar de novo é o jeito de cortar nesse modo.
  await janela.webContents.executeJavaScript(apertar('pointerdown'));
  await janela.webContents.executeJavaScript(apertar('pointerup'));
  await esperar(300);
  const cortouNoSegundoAperto = await janela.webContents.executeJavaScript(
    `window.__efeitos.tocando.size`
  );

  // Voltar pro CUE cala o que estiver correndo.
  await janela.webContents.executeJavaScript(
    `document.querySelector('#disparo-efeitos [data-disparo="segurar"]').click(); true`
  );
  await esperar(200);

  // ------------------------------------------- organizar: ordem, ★ e emoji
  const organizado = await janela.webContents.executeJavaScript(`(async () => {
    const arquivos = () => [...document.querySelectorAll('#grade-efeitos .efeito')]
      .map((b) => b.dataset.arquivo);
    const antes = arquivos();

    document.getElementById('btn-organizar-efeitos').click();

    // Reordena pelo teclado (Ctrl+seta), que é o mesmo caminho do arrasto: os
    // dois terminam em ordemDaTela(). O arrasto de verdade depende do gestor
    // de arrastar do sistema e não dá pra sintetizar aqui.
    const primeiro = document.querySelector('#grade-efeitos .efeito');
    primeiro.focus();
    primeiro.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowRight', ctrlKey: true, bubbles: true,
    }));
    const depoisDeMover = arquivos();

    // Favorita o que agora está em primeiro, pela estrela.
    const alvo = document.querySelector('#grade-efeitos .efeito');
    const favoritado = alvo.dataset.arquivo;
    alvo.querySelector('.efeito-estrela').dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 3 })
    );

    // Abre a paleta e escolhe um emoji.
    alvo.querySelector('.efeito-trocar-emoji').dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 4 })
    );
    const paletaAberta = !document.querySelector('.paleta').classList.contains('oculto');
    document.querySelector('.paleta-grade [data-emoji="🔥"]').click();

    // Organizando, apertar não pode tocar nada.
    const b = document.querySelector('#grade-efeitos .efeito');
    b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 5 }));
    await new Promise((r) => setTimeout(r, 250));
    const soouNoOrganizar = window.__efeitos.tocando.size;
    b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 5 }));

    document.getElementById('btn-organizar-efeitos').click();

    // O filtro de favoritos deixa só o que foi marcado.
    document.getElementById('btn-favoritos-efeitos').click();
    const soFavoritos = arquivos();
    document.getElementById('btn-favoritos-efeitos').click();

    return {
      antes,
      depoisDeMover,
      favoritado,
      paletaAberta,
      emojiNaTela: document.querySelector('#grade-efeitos .efeito-emoji')
        ? document.querySelector('#grade-efeitos .efeito-emoji').textContent : null,
      soouNoOrganizar,
      soFavoritos,
      guardado: window.efeitos.estado().arranjos[window.__efeitos.pasta],
    };
  })()`);

  // Sai e volta pra pasta: o arranjo tem que ser reencontrado, não recomeçado.
  const reencontrou = await janela.webContents.executeJavaScript(`(async () => {
    await window.efeitos.usarPasta("C:\\Users\\gualm\\AppData\\Local\\Temp");
    await window.efeitos.usarPasta(${JSON.stringify(pasta)});
    return {
      ordem: [...document.querySelectorAll('#grade-efeitos .efeito')].map((b) => b.dataset.arquivo),
      favoritos: [...document.querySelectorAll('#grade-efeitos .efeito.favorito')]
        .map((b) => b.dataset.arquivo),
      emoji: document.querySelector('#grade-efeitos .efeito-emoji')
        ? document.querySelector('#grade-efeitos .efeito-emoji').textContent : null,
    };
  })()`);

  // ------------------------------------------------ a cerca da pasta
  const forasteiro = path.join(pasta, '..', path.basename(pasta), '..', 'nao-e-daqui.txt');
  const cerca = await janela.webContents.executeJavaScript(`(async () => ({
    subindoUmNivel: await window.api.efeitosLer(${JSON.stringify(forasteiro)}),
    outroFormato: await window.api.efeitosLer(${JSON.stringify(path.join(pasta, 'anotacoes.txt'))}),
    deDentro: (await window.api.efeitosLer(${JSON.stringify(path.join(pasta, 'tambor_grave.wav'))})).ok,
  }))()`);

  relatar('EFEITOS', mensagens, {
    carregou, aquecido, cortes, segurando, soltou, inteiro, cortouNoSegundoAperto,
    organizado, reencontrou, cerca,
  });

  // Checagens nomeadas, e não um `&&` gigante: quando uma falha, o que importa
  // é saber QUAL -- um booleano só diz que algo deu errado em algum lugar.
  const achado = (lista, nome) => lista.find((c) => c.nome === nome) || {};
  const checagens = [
    ['lista tem os 3 áudios (o .txt ficou de fora)', carregou.lista.length === 3],
    ['um botão por áudio', carregou.botoes.length === 3],
    ['ordem alfabética e "_" virou espaço', carregou.lista[0] === 'apito agudo'],
    ['botão grande', carregou.alturaDoBotao >= 100],
    ['os 3 decodificaram no aquecimento', aquecido === 3],
    ['silêncio de 500 ms cortado (com folga de ataque)',
      achado(cortes, 'apito agudo').inicioMs >= 480 && achado(cortes, 'apito agudo').inicioMs <= 500],
    ['arquivo sem silêncio não é cortado', achado(cortes, 'tambor grave').inicioMs === 0],
    ['CUE: segurando, soa', segurando.soando === 1],
    ['CUE: segurando, botão aceso', segurando.classe.includes('apertado')],
    ['CUE: soltou, calou', soltou.soando === 0 && soltou.apertados === 0],
    ['CUE: soltou, botão apagado', !soltou.classe.includes('apertado')],
    ['até o fim: continua depois de soltar', inteiro.soandoDepoisDeSoltar === 1],
    ['até o fim: aparece o Parar tudo', inteiro.pararTudoVisivel === true],
    ['até o fim: segundo aperto corta', cortouNoSegundoAperto === 0],
    ['Ctrl+→ trocou os dois primeiros',
      organizado.depoisDeMover[0] === organizado.antes[1] &&
      organizado.depoisDeMover[1] === organizado.antes[0]],
    ['Ctrl+→ não mexeu no resto', organizado.depoisDeMover[2] === organizado.antes[2]],
    ['paleta de emoji abriu', organizado.paletaAberta === true],
    ['emoji escolhido aparece no botão', organizado.emojiNaTela === '🔥'],
    ['organizando não toca', organizado.soouNoOrganizar === 0],
    ['filtro ★ mostra só o favorito',
      organizado.soFavoritos.length === 1 && organizado.soFavoritos[0] === organizado.favoritado],
    ['arranjo guardado tem o favorito', organizado.guardado.favoritos.length === 1],
    ['voltando à pasta, a ordem é a mesma',
      reencontrou.ordem.join('|') === organizado.depoisDeMover.join('|')],
    ['voltando à pasta, o favorito continua',
      reencontrou.favoritos.join('|') === organizado.favoritado],
    ['voltando à pasta, o emoji continua', reencontrou.emoji === '🔥'],
    ['não lê fora da pasta', cerca.subindoUmNivel.ok === false],
    ['não lê o que não é áudio', cerca.outroFormato.ok === false],
    ['lê o que é de dentro', cerca.deDentro === true],
  ];

  const falhas = checagens.filter(([, passou]) => !passou).map(([nome]) => nome);
  const ok = falhas.length === 0;
  if (!ok) console.log(['', 'falhou:', ...falhas.map((f) => '  - ' + f)].join('\n'));
  console.log(ok ? '\nOK: efeitos funcionando' : '\nFALHOU: ver o relatório acima');

  fs.rmSync(pasta, { recursive: true, force: true });
  app.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('FALHOU:', e.message);
  console.error(e.stack);
  app.exit(1);
});

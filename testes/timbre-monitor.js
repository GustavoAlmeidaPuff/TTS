// "Ouvir tambem no meu fone" nao funcionava no modo Trocar timbre.
//
// A caixa fica no painel "Para onde vai a voz", que aparece em todos os modos --
// mas so o Digitar e os Efeitos olhavam pra ela. O timbre montava UM
// AudioContext, apontado pro cabo, e um contexto toca num dispositivo por vez:
// marcar pra se escutar nao mudava nada, porque nao havia ninguem tocando no
// fone. No jogo isso aparece como "marquei pra me escutar e nao me escuto".
//
// Este teste roda o caminho de verdade (fala do Piper no lugar do microfone ->
// conversor -> agendador) e conta em QUANTOS destinos cada bloco convertido foi
// agendado, com a caixa marcada e depois desmarcada no meio da sessao.
//
//   npx electron testes/timbre-monitor.js
const { app } = require('electron');
const { abrirApp, esperar, esperarNaTela, fotografar } = require('./comum');

const FRASE =
  'Teste do retorno no fone: a mesma voz precisa sair no cabo e no meu ouvido ao mesmo tempo.';

(async () => {
  const { janela, mensagens } = await abrirApp();

  await janela.webContents.executeJavaScript(`document.getElementById('aba-timbre').click(); true`);
  await esperar(2500);

  const pronto = await janela.webContents.executeJavaScript(
    `!document.getElementById('timbre-pronto').classList.contains('oculto')`
  );
  if (!pronto) {
    console.error('FALHOU: os modelos do RVC nao estao baixados nesta maquina');
    return app.exit(1);
  }

  // 1. Fala falsa no lugar do microfone, em laco, pra ter audio nas duas fases.
  //    E as sondas: uma no setSinkId (pra saber QUAL destino e qual) e outra no
  //    agendador (pra saber quantos blocos cada destino recebeu).
  const montagem = await janela.webContents.executeJavaScript(`(async () => {
    const r = await window.api.falar({
      motor: 'piper', texto: ${JSON.stringify(FRASE)},
      voz: 'pt_BR-faber-medium', velocidade: 0, tom: 0,
    });
    if (!r.ok) return { erro: r.erro };

    const ctx = new AudioContext();
    const buffer = await ctx.decodeAudioData(r.audio.buffer.slice(0));
    const destino = ctx.createMediaStreamDestination();
    const fonte = ctx.createBufferSource();
    fonte.buffer = buffer;
    fonte.loop = true;
    fonte.connect(destino);

    window.__falaFalsa = { ctx, fonte };
    navigator.mediaDevices.getUserMedia = async () => destino.stream;

    // Cada contexto ganha um numero proprio: assim os destinos se distinguem
    // mesmo numa maquina onde o cabo e o fone sejam o mesmo dispositivo.
    window.__espia = { proximoId: 0, destinos: {} };
    const marcar = (ctx) => {
      if (!ctx.__id) {
        ctx.__id = ++window.__espia.proximoId;
        window.__espia.destinos[ctx.__id] = { sink: '(padrao)', blocos: 0 };
      }
      return window.__espia.destinos[ctx.__id];
    };

    const porSink = AudioContext.prototype.setSinkId;
    if (porSink) {
      AudioContext.prototype.setSinkId = function (id) {
        marcar(this).sink = String(id).slice(0, 12) || '(padrao)';
        return porSink.call(this, id);
      };
    }

    const criar = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function () {
      const f = criar.call(this);
      const ctx = this;
      const start = f.start.bind(f);
      f.start = (...a) => {
        // So os blocos convertidos; o buffer da fala falsa e enorme e nao conta.
        if (f.buffer && f.buffer.length > 1000 && f.buffer.duration < 2) marcar(ctx).blocos++;
        return start(...a);
      };
      return f;
    };

    return { segundos: +buffer.duration.toFixed(2) };
  })()`);

  if (montagem.erro) {
    console.error('FALHOU ao gerar a fala: ' + montagem.erro);
    return app.exit(1);
  }

  // 2. Marca "Ouvir tambem no meu fone" e, se der, escolhe um aparelho
  //    diferente do cabo -- que e exatamente o que a pessoa faz no jogo.
  const escolha = await janela.webContents.executeJavaScript(`(() => {
    const saida = document.getElementById('saida');
    const monitorar = document.getElementById('monitorar');
    const monitor = document.getElementById('monitor');

    monitorar.checked = true;
    monitorar.dispatchEvent(new Event('change'));

    const outro = [...monitor.options].find((o) => o.value && o.value !== saida.value);
    if (outro) monitor.value = outro.value;
    monitor.dispatchEvent(new Event('change'));

    const nome = (s) => (s.selectedOptions[0] ? s.selectedOptions[0].textContent : '(nenhum)');
    return {
      saida: nome(saida),
      monitor: nome(monitor),
      separados: monitor.value !== saida.value,
      microfoneMarcadoPerigo: document.getElementById('microfone-timbre').classList.contains('perigo'),
    };
  })()`);

  console.log('saida principal : ' + escolha.saida);
  console.log('monitor (fone)  : ' + escolha.monitor);
  if (!escolha.separados) {
    console.log('  (esta maquina so tem uma saida; o teste conta os destinos, nao os aparelhos)');
  }
  console.log('');

  // 3. Liga (carrega o modelo na GPU, o que pode levar de 4s a 20s) e so
  //    depois solta a fala.
  await janela.webContents.executeJavaScript(`document.getElementById('btn-timbre').click(); true`);
  const ligou = await esperarNaTela(
    janela,
    `document.getElementById('btn-timbre').textContent.trim() === 'Parar'`
  );
  if (!ligou) {
    console.error('FALHOU: a troca de timbre nao subiu');
    return app.exit(1);
  }
  await janela.webContents.executeJavaScript(`window.__falaFalsa.fonte.start(); true`);
  await esperar(7000);

  const comFone = await janela.webContents.executeJavaScript(
    `JSON.parse(JSON.stringify(window.__espia.destinos))`
  );
  await fotografar(janela, 'tela-timbre-monitor.png');

  // 4. Desmarca no meio da sessao: o fone tem que parar SEM derrubar o cabo.
  await janela.webContents.executeJavaScript(`(() => {
    const m = document.getElementById('monitorar');
    m.checked = false;
    m.dispatchEvent(new Event('change'));
    return true;
  })()`);
  await esperar(5000);

  const semFone = await janela.webContents.executeJavaScript(
    `JSON.parse(JSON.stringify(window.__espia.destinos))`
  );
  const estado = await janela.webContents.executeJavaScript(
    `document.getElementById('estado').textContent`
  );

  await janela.webContents.executeJavaScript(`document.getElementById('btn-timbre').click(); true`);
  await esperar(1500);

  // ------------------------------------------------------------------ balanco

  // A fala falsa e o proprio decodificador do teste tambem criam contextos;
  // os destinos do timbre sao os que receberam blocos convertidos.
  const tocaram = (mapa) => Object.entries(mapa).filter(([, d]) => d.blocos > 0);
  const fase1 = tocaram(comFone);
  const crescimento = Object.entries(semFone)
    .map(([id, d]) => [id, d.blocos - (comFone[id] ? comFone[id].blocos : 0)])
    .filter(([, n]) => n > 0);

  console.log('=== COM A CAIXA MARCADA ===');
  for (const [id, d] of fase1) console.log(`  destino ${id} (sink ${d.sink}): ${d.blocos} blocos`);
  console.log('\n=== DEPOIS DE DESMARCAR ===');
  for (const [id, n] of crescimento) console.log(`  destino ${id}: +${n} blocos`);
  if (!crescimento.length) console.log('  (nenhum)');
  console.log('\nestado na tela: ' + estado);

  const falhas = [];
  if (fase1.length < 2) {
    falhas.push(`marcado, a voz saiu em ${fase1.length} destino(s) -- era pra sair em 2`);
  }
  // Os dois destinos recebem o MESMO bloco: as contagens tem que bater.
  if (fase1.length >= 2) {
    const n = fase1.map(([, d]) => d.blocos);
    if (Math.max(...n) - Math.min(...n) > 2) {
      falhas.push('os destinos receberam contagens muito diferentes: ' + n.join(' vs '));
    }
  }
  if (crescimento.length !== 1) {
    falhas.push(
      `desmarcado, a voz continuou em ${crescimento.length} destino(s) -- era pra sobrar so o cabo`
    );
  }

  console.log('\n' + (falhas.length ? '=> FALHOU:\n   - ' + falhas.join('\n   - ') : '=> FUNCIONA: a voz sai no cabo e no fone juntos, e desmarcar so tira o fone'));

  if (mensagens.length) {
    console.log('\n=== CONSOLE DA PAGINA ===');
    console.log(mensagens.join('\n'));
  }

  app.exit(falhas.length ? 1 : 0);
})().catch((e) => {
  console.error('FALHOU:', e.message);
  console.error(e.stack);
  app.exit(1);
});

// Teste do modo ao vivo, de ponta a ponta e sem ninguem falando.
//
// O truque: o app gera a fala com o proprio Piper, e essa fala e injetada no
// lugar do microfone. Ou seja, o app escuta a si mesmo. Com isso o teste
// percorre o caminho inteiro de verdade -- worklet -> IPC -> reconhecedor ->
// prefixo estavel -> fila -> sintese -> setSinkId -> play.
//
//   npx electron testes/ao-vivo.js [en|pt]
const { app } = require('electron');
const { abrirApp, esperar, fotografar } = require('./comum');

const LINGUA = process.argv[2] === 'pt' ? 'pt' : 'en';

const CASOS = {
  en: {
    voz: 'en_US-amy-medium',
    texto: 'Hello everyone, welcome back to the stream. Today we are going to try something completely different.',
  },
  pt: {
    voz: 'pt_BR-faber-medium',
    texto: 'Olá pessoal, sejam bem-vindos de volta. Hoje nós vamos tentar uma coisa completamente diferente.',
  },
};

(async () => {
  const { janela, mensagens } = await abrirApp();
  const caso = CASOS[LINGUA];

  // 1. Modo ao vivo, motor Piper (local; o Edge atrasaria demais), microfone
  //    que nao seja o cabo.
  const preparo = await janela.webContents.executeJavaScript(`(async () => {
    document.getElementById('aba-vivo').click();

    const motor = document.getElementById('motor');
    motor.value = 'piper';
    motor.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 2500));

    const idioma = document.getElementById('idioma');
    const alvo = ${JSON.stringify(LINGUA === 'pt' ? 'pt-BR' : 'en-US')};
    if ([...idioma.options].some((o) => o.value === alvo)) {
      idioma.value = alvo;
      idioma.dispatchEvent(new Event('change'));
    }

    const mic = document.getElementById('microfone');
    const real = [...mic.options].find((o) => !/cable|vb-audio|virtual/i.test(o.textContent));
    if (real) { mic.value = real.value; mic.dispatchEvent(new Event('change')); }

    return {
      motor: motor.value,
      idioma: idioma.value,
      voz: document.getElementById('voz').value,
      microfone: mic.selectedOptions[0] ? mic.selectedOptions[0].textContent : null,
      reconhecedor: document.getElementById('modelo-voz').value,
    };
  })()`);
  console.log('=== PREPARO ===');
  console.log(JSON.stringify(preparo, null, 2));

  if (!preparo.voz) {
    console.error('\nFALHOU: nenhuma voz do Piper disponivel para ' + LINGUA);
    return app.exit(1);
  }

  // 2. Gera a fala e troca o microfone por ela.
  const montagem = await janela.webContents.executeJavaScript(`(async () => {
    const r = await window.api.falar({
      motor: 'piper',
      texto: ${JSON.stringify(caso.texto)},
      voz: ${JSON.stringify(caso.voz)},
      velocidade: 0, tom: 0,
    });
    if (!r.ok) return { erro: r.erro };

    const ctx = new AudioContext();
    const buffer = await ctx.decodeAudioData(r.audio.buffer.slice(0));

    // Um pouco de silencio na frente imita o inicio real de uma fala.
    const comSilencio = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.4) + buffer.length, ctx.sampleRate);
    comSilencio.getChannelData(0).set(buffer.getChannelData(0), Math.round(ctx.sampleRate * 0.4));

    const destino = ctx.createMediaStreamDestination();
    const fonte = ctx.createBufferSource();
    fonte.buffer = comSilencio;
    fonte.connect(destino);

    // Substitui o microfone: daqui pra frente o app "ouve" este audio.
    window.__falaFalsa = { ctx, fonte, stream: destino.stream };
    navigator.mediaDevices.getUserMedia = async () => destino.stream;

    return { segundos: +(comSilencio.duration.toFixed(2)), taxa: ctx.sampleRate };
  })()`);

  if (montagem.erro) {
    console.error('\nFALHOU ao gerar a fala de teste: ' + montagem.erro);
    return app.exit(1);
  }
  console.log('\n=== FALA INJETADA ===');
  console.log('  ' + montagem.segundos + 's a ' + montagem.taxa + ' Hz');
  console.log('  texto falado: "' + caso.texto + '"');

  // 3. Liga a escuta e solta o audio.
  await janela.webContents.executeJavaScript(`(async () => {
    document.getElementById('btn-microfone').click();
    return true;
  })()`);
  await esperar(7000); // o reconhecedor multi leva ~3s pra carregar

  await janela.webContents.executeJavaScript(`window.__falaFalsa.fonte.start(); true`);
  console.log('\n=== ESCUTANDO (tempo real) ===');

  // 4. Espera a fala inteira + a fila terminar de falar de volta.
  const limite = Math.ceil(montagem.segundos * 1000) + 14000;
  await esperar(limite);

  const resultado = await janela.webContents.executeJavaScript(`(() => ({
    estado: document.getElementById('estado').textContent,
    parcialFirme: document.getElementById('parcial-firme').textContent,
    parcialSolto: document.getElementById('parcial-solto').textContent,
    trechos: [...document.querySelectorAll('#lista-trechos li')]
      .filter((li) => !li.classList.contains('vazio'))
      .map((li) => li.firstChild.textContent + ' | esperou ' + li.querySelector('.tempo').textContent)
      .reverse(),
    botaoMicrofone: document.getElementById('btn-microfone').textContent.trim(),
    filaTamanho: window.__fila ? window.__fila.itens.length : 'sem sonda',
    filaItens: window.__fila ? window.__fila.itens.map((i) => i.texto + (i.falhou ? ' [FALHOU]' : i.blob ? ' [pronto]' : ' [pendente]')) : [],
    sintetizando: window.__fila ? window.__fila.sintetizando : null,
    tocando: window.__fila ? window.__fila.tocando : null,
    descartados: window.__fila ? window.__fila.descartados : null,
    gravando: document.getElementById('btn-microfone').classList.contains('gravando'),
  }))()`);

  await fotografar(janela, 'tela-ao-vivo.png');

  console.log('\n=== TRECHOS FALADOS DE VOLTA ===');
  resultado.trechos.forEach((t) => console.log('  ' + t));

  const reconhecido = resultado.trechos.map((t) => t.split(' | ')[0]).join(' ');
  console.log('\ntexto original    : "' + caso.texto + '"');
  console.log('texto reconhecido : "' + reconhecido + '"');

  const limpa = (s) => s.toLowerCase().replace(/[^a-z0-9à-ÿ]/gi, '');
  const a = limpa(caso.texto), b = limpa(reconhecido);
  let iguais = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] === b[i]) iguais++;
  console.log(
    '\nsemelhanca bruta: ' + Math.round((iguais / Math.max(a.length, b.length)) * 100) + '%' +
    '  |  trechos: ' + resultado.trechos.length +
    '  |  estado: "' + resultado.estado + '"' +
    '  |  ainda gravando: ' + resultado.gravando
  );

  if (mensagens.length) {
    console.log('\n=== CONSOLE DA PAGINA ===');
    console.log(mensagens.join('\n'));
  }

  app.quit();
})().catch((e) => {
  console.error('FALHOU:', e.message);
  console.error(e.stack);
  app.exit(1);
});

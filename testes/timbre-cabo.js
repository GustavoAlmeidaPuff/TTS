// O detector de retroalimentacao acusava dispositivos legitimos.
//
// "Virtual Desktop Audio" e o microfone do app de VR; "NVIDIA Virtual Audio"
// idem. Recusar o microfone do usuario porque o nome tem "virtual" e pior que
// nao checar nada -- ele fica sem conseguir usar o app e sem entender por que.
//
// O criterio certo: o microfone e a OUTRA PONTA do mesmo cabo que vai receber
// a voz?
//
//   npx electron testes/timbre-cabo.js
const { app } = require('electron');
const { abrirApp, relatar } = require('./comum');

const CASOS = [
  // [microfone, saida, deve recusar?, por que]
  ['Microfone (Virtual Desktop Audio)', 'CABLE Input (VB-Audio Virtual Cable)', false,
   'microfone do app de VR: so tem "virtual" no nome'],
  ['Microfone (NVIDIA Virtual Audio Device)', 'CABLE Input (VB-Audio Virtual Cable)', false,
   'dispositivo da NVIDIA, nao e cabo de retorno'],
  ['Microfone (Realtek(R) Audio)', 'CABLE Input (VB-Audio Virtual Cable)', false,
   'microfone comum'],
  ['CABLE Output (VB-Audio Virtual Cable)', 'CABLE Input (VB-Audio Virtual Cable)', true,
   'ESTE e o laco: as duas pontas do mesmo cabo'],
  ['CABLE Output (VB-Audio Virtual Cable)', 'Fones de ouvido (Redmi Buds 6 Play)', false,
   'a voz vai pro fone, entao o cabo nao volta pra ele'],
  ['VoiceMeeter Output (VB-Audio VoiceMeeter VAIO)', 'VoiceMeeter Input (VB-Audio VoiceMeeter VAIO)', true,
   'mesmo laco, outro fabricante'],
];

(async () => {
  const { janela, mensagens } = await abrirApp();
  await janela.webContents.executeJavaScript(`document.getElementById('aba-timbre').click(); true`);

  // Le a funcao de dentro do modulo pelo mesmo caminho que a interface usa:
  // monta as opcoes de verdade nos seletores e pergunta se marcou perigo.
  const resultados = await janela.webContents.executeJavaScript(`(() => {
    const casos = ${JSON.stringify(CASOS)};
    const mic = document.getElementById('microfone-timbre');
    const saida = document.getElementById('saida');
    const guardaMic = mic.innerHTML;
    const guardaSaida = saida.innerHTML;
    const saida0 = saida.value;

    const fora = [];
    for (const [nomeMic, nomeSaida, deveRecusar, porque] of casos) {
      mic.innerHTML = '';
      const om = document.createElement('option');
      om.value = 'mic'; om.textContent = nomeMic; mic.appendChild(om);
      mic.value = 'mic';

      saida.innerHTML = '';
      const os_ = document.createElement('option');
      os_.value = 'saida'; os_.textContent = nomeSaida; saida.appendChild(os_);
      saida.value = 'saida';

      mic.dispatchEvent(new Event('change'));
      const recusou = mic.classList.contains('perigo');
      fora.push({ nomeMic, nomeSaida, esperado: deveRecusar, obtido: recusou, ok: recusou === deveRecusar, porque });
    }

    mic.innerHTML = guardaMic;
    saida.innerHTML = guardaSaida;
    saida.value = saida0;
    return fora;
  })()`);

  console.log('=== DETECÇÃO DE RETROALIMENTAÇÃO ===\n');
  let falhas = 0;
  for (const r of resultados) {
    const marca = r.ok ? 'ok  ' : 'FALHOU';
    if (!r.ok) falhas++;
    console.log(
      `${marca} ${r.esperado ? 'recusa' : 'aceita'}  mic="${r.nomeMic}"\n` +
      `        saída="${r.nomeSaida}"\n` +
      `        ${r.porque}` + (r.ok ? '' : `\n        >>> esperava ${r.esperado}, deu ${r.obtido}`)
    );
  }
  console.log('\n' + (falhas ? `${falhas} de ${resultados.length} FALHARAM` : `todos os ${resultados.length} casos passaram`));

  if (mensagens.length) relatar('CONSOLE', mensagens, {});
  app.exit(falhas ? 1 : 0);
})().catch((e) => {
  console.error('FALHOU:', e.message);
  app.exit(1);
});

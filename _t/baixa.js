const modelos = require('../electron/voz/modelos');
const path = require('path');
modelos.definirRaiz(path.join(process.env.APPDATA, 'voz-tts', 'motores'));
(async () => {
  console.log('antes:', JSON.stringify(modelos.status(), (k,v) => k==='catalogo'?undefined:v));
  let ultimo = -1;
  await modelos.instalar('en-preciso', (p) => {
    if (p.porcento === null || p.porcento === undefined) { console.log('  ' + p.rotulo); return; }
    if (p.porcento >= ultimo + 25 || p.porcento === 100) { ultimo = p.porcento; console.log('  ' + p.rotulo + ' ' + p.porcento + '%'); }
  });
  console.log('depois:', JSON.stringify(modelos.status(), (k,v) => k==='catalogo'?undefined:v));
  const a = modelos.localizarArquivos('en-preciso');
  console.log('arquivos achados:');
  for (const [k, v] of Object.entries(a)) console.log('  ' + k + ': ' + path.basename(v));
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });

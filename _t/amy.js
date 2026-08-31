const piper = require('../electron/tts/piper');
const path = require('path');
piper.definirRaiz(path.join(process.env.APPDATA, 'voz-tts', 'motores'));
(async () => {
  let u = -1;
  await piper.instalar('en_US-amy-medium', (p) => {
    if (p.porcento == null) return console.log('  ' + p.rotulo);
    if (p.porcento >= u + 50 || p.porcento === 100) { u = p.porcento; console.log('  ' + p.rotulo + ' ' + p.porcento + '%'); }
  });
  console.log('vozes agora:', (await piper.listarVozes()).map(v => v.id).join(', '));
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });

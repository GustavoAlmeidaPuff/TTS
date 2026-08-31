// Prova de vida do Edge TTS: lista vozes pt-BR e sintetiza um arquivo.
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const fs = require('fs');
const path = require('path');

const SAIDA = process.argv[2] || path.join(__dirname, 'amostra');

async function main() {
  const tts = new MsEdgeTTS();

  console.log('== buscando lista de vozes ==');
  const vozes = await tts.getVoices();
  console.log('total de vozes:', vozes.length);

  const ptbr = vozes.filter((v) => (v.Locale || '').toLowerCase().startsWith('pt-br'));
  console.log('\n== vozes pt-BR ==');
  for (const v of ptbr) {
    console.log(
      ' -',
      v.ShortName,
      '|',
      v.Gender,
      '|',
      (v.VoiceTag && v.VoiceTag.ContentCategories ? v.VoiceTag.ContentCategories.join(',') : ''),
      '|',
      (v.VoiceTag && v.VoiceTag.VoicePersonalities ? v.VoiceTag.VoicePersonalities.join(',') : '')
    );
  }

  const escolhida = ptbr.find((v) => /Francisca/i.test(v.ShortName)) || ptbr[0];
  if (!escolhida) throw new Error('nenhuma voz pt-BR encontrada');

  console.log('\n== sintetizando com', escolhida.ShortName, '==');
  const t0 = Date.now();
  await tts.setMetadata(escolhida.ShortName, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const r = await tts.toFile(SAIDA, 'Olá! Esta é uma prova de voz em português do Brasil. Se você está ouvindo isso, o motor de fala está funcionando.');
  console.log('demorou', Date.now() - t0, 'ms');
  console.log('arquivo:', r.audioFilePath, fs.statSync(r.audioFilePath).size, 'bytes');
}

main().catch((e) => {
  console.error('FALHOU:', e && e.message ? e.message : e);
  if (e && e.stack) console.error(e.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});

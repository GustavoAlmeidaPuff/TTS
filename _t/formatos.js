const edge = require('../electron/tts/edge');
const fmts = {
  mp3: 'audio-24khz-48kbitrate-mono-mp3',
  mp3alta: 'audio-24khz-96kbitrate-mono-mp3',
  pcm24: 'raw-24khz-16bit-mono-pcm',
  pcm16: 'raw-16khz-16bit-mono-pcm',
  opus: 'webm-24khz-16bit-mono-opus',
};
(async () => {
  for (const [nome, valor] of Object.entries(fmts)) {
    edge.FORMATOS.__teste = valor;
    try {
      const a = await edge.sintetizar({ texto: 'Testing one two three.', voz: 'en-US-AriaNeural', formato: '__teste' });
      console.log('OK   ' + nome.padEnd(8) + ' ' + valor.padEnd(34) + ' ' + a.length + ' bytes');
    } catch (e) {
      console.log('FALHA ' + nome.padEnd(7) + ' ' + valor.padEnd(34) + ' ' + e.message.slice(0, 60));
    }
  }
})();

const fs = require('fs');
const path = require('path');
const edge = require('../electron/tts/edge');

async function main() {
  console.log('token gerado:', edge.gerarToken().slice(0, 16) + '...');

  const vozes = await edge.listarVozes();
  const ptbr = vozes.filter((v) => v.lingua.toLowerCase().startsWith('pt-br'));
  console.log('\nvozes pt-BR:');
  ptbr.forEach((v) => console.log(' -', v.id, '|', v.nome, '|', v.genero, '|', v.personalidade.join(',')));

  for (const voz of ptbr) {
    const t0 = Date.now();
    try {
      const audio = await edge.sintetizar({
        texto: 'Olá! Esta é uma prova de voz em português do Brasil. Se você está ouvindo isso, o motor de fala está funcionando direito.',
        voz: voz.id,
      });
      const destino = path.join(__dirname, `amostra-${voz.id}.mp3`);
      fs.writeFileSync(destino, audio);
      console.log(`\nOK  ${voz.id}: ${audio.length} bytes em ${Date.now() - t0}ms -> ${path.basename(destino)}`);
    } catch (e) {
      console.log(`\nERRO ${voz.id}: ${e.message}`);
    }
  }
}

main().catch((e) => {
  console.error('FALHOU:', e.message);
  process.exit(1);
});

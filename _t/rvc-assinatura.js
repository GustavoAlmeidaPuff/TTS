// Le a assinatura real de cada modelo ONNX do RVC (nomes, tipos e formatos de
// entrada e saida) e mede CPU contra DirectML (a GPU, via DX12).
//
// Escrever a canalizacao a partir da assinatura de verdade evita a armadilha
// classica: presumir os nomes pelo que a documentacao diz e descobrir no fim
// que o modelo exportado usa outros.
const ort = require('onnxruntime-node');
const path = require('path');
const fs = require('fs');

const DIR = path.join(process.env.APPDATA, 'voz-tts', 'motores', 'rvc');

function descrever(md) {
  return Object.entries(md || {})
    .map(([nome, info]) => {
      const dims = (info.dims || info.shape || []).join('x') || '?';
      return `${nome} [${info.type || '?'}] (${dims})`;
    })
    .join('\n      ');
}

(async () => {
  const arquivos = fs.readdirSync(DIR).filter((a) => a.endsWith('.onnx'));
  console.log('modelos na pasta: ' + arquivos.join(', ') + '\n');

  for (const arq of arquivos) {
    const caminho = path.join(DIR, arq);
    const mb = Math.round(fs.statSync(caminho).size / 1048576);
    console.log('=== ' + arq + '  (' + mb + ' MB) ===');

    for (const ep of ['cpu', 'dml']) {
      try {
        const t0 = Date.now();
        const sessao = await ort.InferenceSession.create(caminho, {
          executionProviders: [ep],
          graphOptimizationLevel: 'all',
        });
        const ms = Date.now() - t0;
        console.log('  [' + ep.toUpperCase() + '] carregou em ' + ms + 'ms');

        if (ep === 'cpu') {
          console.log('    entradas:');
          console.log('      ' + descrever(sessao.inputMetadata) || '(?)');
          console.log('    saidas:');
          console.log('      ' + descrever(sessao.outputMetadata) || '(?)');
          // Alguns builds expoem so os nomes.
          if (!sessao.inputMetadata) {
            console.log('    inputNames : ' + (sessao.inputNames || []).join(', '));
            console.log('    outputNames: ' + (sessao.outputNames || []).join(', '));
          }
        }
        await sessao.release();
      } catch (e) {
        console.log('  [' + ep.toUpperCase() + '] FALHOU: ' + e.message.split('\n')[0].slice(0, 140));
      }
    }
    console.log('');
  }
})().catch((e) => {
  console.error('FALHOU:', e.message);
  process.exit(1);
});

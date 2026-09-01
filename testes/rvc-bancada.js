// Bancada do RVC: grave a SUA voz, ouça ela convertida, veja os tempos.
//
//   npx electron testes/rvc-bancada.js
//
// Existe porque o RVC ainda nao esta ligado no app: isto testa o conversor
// sozinho, com voz humana de verdade (ate agora so testei com voz sintetica).
require('../electron/comum/onnx'); // ordem obrigatoria -- ver o arquivo

const { app, BrowserWindow, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const { Conversor } = require('../electron/voz/rvc');

app.setName('voz-tts');

const VOZ = process.argv[2] || 'woman_1';
// Mediana tipica de fala feminina. E o centro da faixa em que a woman_1 foi
// treinada -- entregar uma melodia longe disso e o que deixa a voz rouca.
const TOM_ALVO = Number(process.argv[3]) || 200;
let conversor = null;

function pastaModelos() {
  return path.join(app.getPath('userData'), 'motores', 'rvc');
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_c, p, permitir) =>
    permitir(p === 'media' || p === 'audioCapture')
  );

  const dir = pastaModelos();
  const faltando = ['vec-768-layer-12.onnx', 'rmvpe.onnx', `${VOZ}.onnx`].filter(
    (f) => !fs.existsSync(path.join(dir, f))
  );
  if (faltando.length) {
    console.error('FALTAM MODELOS em ' + dir + ':\n  ' + faltando.join('\n  '));
    return app.exit(1);
  }

  console.log('carregando os modelos (uns 3s)...');
  conversor = new Conversor({
    contentvec: path.join(dir, 'vec-768-layer-12.onnx'),
    rmvpe: path.join(dir, 'rmvpe.onnx'),
    gerador: path.join(dir, `${VOZ}.onnx`),
  });
  await conversor.carregar();
  console.log('pronto. gerador em: ' + conversor.provedorGerador);

  ipcMain.handle('rvc:vozes', async () => {
    // Tudo que e .onnx e nao e uma das duas redes fixas e uma voz alvo.
    const fixos = ['vec-768-layer-12.onnx', 'rmvpe.onnx'];
    return fs.readdirSync(dir)
      .filter((a) => a.endsWith('.onnx') && !fixos.includes(a))
      .map((a) => a.replace(/.onnx$/, ''));
  });

  ipcMain.handle('rvc:trocarVoz', async (_e, id) => {
    const caminho = path.join(dir, id + '.onnx');
    if (!fs.existsSync(caminho)) return { ok: false, erro: 'voz nao encontrada: ' + id };
    try {
      await conversor.trocarGerador(caminho);
      return { ok: true };
    } catch (e) {
      return { ok: false, erro: e.message };
    }
  });

  ipcMain.handle('rvc:pronto', async () => ({
    semGpu: Boolean(conversor.semGpu),
    voz: VOZ,
    tomAlvoPadrao: TOM_ALVO,
  }));

  ipcMain.handle('rvc:converter', async (_e, amostras, opcoes) => {
    try {
      const entrada = amostras instanceof Float32Array ? amostras : new Float32Array(amostras);
      const r = await conversor.converter(entrada, opcoes || {});
      return { ok: true, audio: r.audio, taxa: r.taxa, tempos: r.tempos, tom: r.tom };
    } catch (e) {
      console.error(e);
      return { ok: false, erro: e.message };
    }
  });

  ipcMain.handle('rvc:salvar', async (_e, orig, taxaOrig, conv, taxaConv) => {
    try {
      const destino = path.join(__dirname, 'gravacoes');
      fs.mkdirSync(destino, { recursive: true });
      const carimbo = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      escreverWav(new Float32Array(orig), taxaOrig, path.join(destino, carimbo + '-minha-voz.wav'));
      escreverWav(new Float32Array(conv), taxaConv, path.join(destino, carimbo + '-convertida.wav'));
      return { ok: true, pasta: destino };
    } catch (e) {
      return { ok: false, erro: e.message };
    }
  });

  const janela = new BrowserWindow({
    width: 800,
    height: 900,
    backgroundColor: '#12141a',
    title: 'Bancada do RVC',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'rvc-bancada-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  janela.loadFile(path.join(__dirname, 'rvc-bancada.html'));
  janela.webContents.on('console-message', (_e, _n, m) => console.log('[tela] ' + m));
});

app.on('window-all-closed', () => {
  if (conversor) conversor.liberar();
  app.quit();
});

function escreverWav(amostras, taxa, destino) {
  const pcm = Buffer.alloc(amostras.length * 2);
  for (let i = 0; i < amostras.length; i++) {
    const v = Math.max(-1, Math.min(1, amostras[i]));
    pcm.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const c = Buffer.alloc(44);
  c.write('RIFF', 0); c.writeUInt32LE(36 + pcm.length, 4); c.write('WAVE', 8);
  c.write('fmt ', 12); c.writeUInt32LE(16, 16); c.writeUInt16LE(1, 20); c.writeUInt16LE(1, 22);
  c.writeUInt32LE(taxa, 24); c.writeUInt32LE(taxa * 2, 28);
  c.writeUInt16LE(2, 32); c.writeUInt16LE(16, 34);
  c.write('data', 36); c.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(destino, Buffer.concat([c, pcm]));
}

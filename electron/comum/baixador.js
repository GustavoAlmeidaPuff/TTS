'use strict';

/**
 * Download com progresso e descompactacao, compartilhado pelo Piper e pelos
 * modelos de reconhecimento de voz.
 *
 * A regra que importa aqui: escreve num arquivo temporario e so renomeia no
 * fim. Download interrompido nunca vira um modelo pela metade que o app depois
 * acha que existe -- esse tipo de bug custa horas pra achar, porque o sintoma
 * aparece longe da causa.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');

function existe(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Baixa uma URL pra um arquivo, avisando o progresso.
 * @param {string} url
 * @param {string} destino
 * @param {(p: {rotulo: string, baixado: number, total: number, porcento: number|null}) => void} [aoProgresso]
 * @param {string} rotulo texto mostrado na interface
 */
async function baixar(url, destino, aoProgresso, rotulo) {
  const resp = await fetch(url, { redirect: 'follow' });
  if (!resp.ok) throw new Error(`download de ${rotulo} falhou: HTTP ${resp.status}`);

  const total = Number(resp.headers.get('content-length')) || 0;
  await fsp.mkdir(path.dirname(destino), { recursive: true });

  const temporario = `${destino}.${crypto.randomBytes(4).toString('hex')}.parcial`;
  const saida = fs.createWriteStream(temporario);
  let baixado = 0;
  let ultimoAviso = 0;

  try {
    for await (const pedaco of resp.body) {
      baixado += pedaco.length;
      if (!saida.write(pedaco)) await new Promise((r) => saida.once('drain', r));
      const agora = Date.now();
      if (aoProgresso && agora - ultimoAviso > 200) {
        ultimoAviso = agora;
        aoProgresso({
          rotulo,
          baixado,
          total,
          porcento: total ? Math.round((baixado / total) * 100) : null,
        });
      }
    }
    await new Promise((r, j) => saida.end((e) => (e ? j(e) : r())));
    await fsp.rename(temporario, destino);
  } catch (e) {
    saida.destroy();
    await fsp.rm(temporario, { force: true }).catch(() => {});
    throw e;
  }

  if (aoProgresso) aoProgresso({ rotulo, baixado, total, porcento: 100 });
}

/** Roda um comando do PowerShell e resolve/rejeita pelo codigo de saida. */
function powershell(comando, oQueFalhou) {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', comando], {
      windowsHide: true,
    });
    let erro = '';
    ps.stderr.on('data', (d) => (erro += d));
    ps.on('error', reject);
    ps.on('close', (codigo) =>
      codigo === 0 ? resolve() : reject(new Error(`${oQueFalhou}: ${erro.slice(0, 300)}`))
    );
  });
}

/** Descompacta .zip usando o PowerShell, sem depender de biblioteca. */
function descompactarZip(zip, destino) {
  return powershell(
    `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${destino}' -Force`,
    'descompactar zip falhou'
  );
}

/**
 * Descompacta .tar.bz2 (formato dos modelos do sherpa-onnx).
 *
 * Duas armadilhas aprendidas na marra, e por isso este codigo e do jeito que e:
 *
 * 1. Chamar `tar` pelo nome pega o GNU tar do Git Bash se ele estiver antes no
 *    PATH, e o GNU tar le "C:\..." como "host C, caminho ...", tentando abrir
 *    conexao de rede. Por isso o caminho absoluto pro tar do proprio Windows.
 * 2. Mesmo com o tar certo, caminho com letra de unidade confunde. Por isso o
 *    processo roda JA dentro da pasta de destino e recebe so o nome do arquivo.
 */
function descompactarTarBz2(arquivo, destino) {
  const tarDoWindows = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'tar.exe'
  );
  const executavel = existe(tarDoWindows) ? tarDoWindows : 'tar';

  return new Promise((resolve, reject) => {
    const proc = spawn(executavel, ['-xjf', path.basename(arquivo)], {
      cwd: destino,
      windowsHide: true,
    });
    let erro = '';
    proc.stderr.on('data', (d) => (erro += d));
    proc.on('error', (e) => reject(new Error(`nao consegui rodar o tar: ${e.message}`)));
    proc.on('close', (codigo) =>
      codigo === 0
        ? resolve()
        : reject(new Error(`descompactar tar.bz2 falhou (codigo ${codigo}): ${erro.slice(0, 300)}`))
    );
  });
}

module.exports = { baixar, descompactarZip, descompactarTarBz2, existe };

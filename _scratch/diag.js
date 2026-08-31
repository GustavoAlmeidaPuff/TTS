// Mede desvio de relogio contra o servidor da Microsoft e testa o handshake
// do websocket com variacoes de parametro, pra isolar a causa do 403.
const crypto = require('crypto');
const WebSocket = require('ws');

const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';
const EPOCA = 11644473600;

function token(offsetSegundos = 0) {
  let t = Math.floor(Date.now() / 1000) + offsetSegundos + EPOCA;
  t -= t % 300;
  t *= 10000000;
  return crypto.createHash('sha256').update(t + TOKEN, 'ascii').digest('hex').toUpperCase();
}

async function medirRelogio() {
  const r = await fetch('https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=' + TOKEN, {
    headers: { 'User-Agent': UA },
  });
  const dataServidor = r.headers.get('date');
  if (!dataServidor) return console.log('servidor nao mandou header Date');
  const desvio = (Date.parse(dataServidor) - Date.now()) / 1000;
  console.log('hora local   :', new Date().toISOString());
  console.log('hora servidor:', new Date(Date.parse(dataServidor)).toISOString());
  console.log('desvio       :', desvio.toFixed(1), 'segundos');
  return desvio;
}

function tentar(rotulo, url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, {
      headers: {
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
        Origin: 'chrome-extension://jdiccldimpahbcfhkgcpaliehnbmgkfa',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': UA,
      },
    });
    const fim = setTimeout(() => { try { ws.close(); } catch (_) {} resolve(`${rotulo}: TIMEOUT`); }, 12000);
    ws.on('open', () => { clearTimeout(fim); try { ws.close(); } catch (_) {} resolve(`${rotulo}: CONECTOU`); });
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(fim);
      let corpo = '';
      res.on('data', (c) => (corpo += c));
      res.on('end', () => resolve(`${rotulo}: HTTP ${res.statusCode} | ${corpo.slice(0, 200).replace(/\s+/g, ' ')}`));
    });
    ws.on('error', (e) => { clearTimeout(fim); resolve(`${rotulo}: ERRO ${e.message}`); });
  });
}

async function main() {
  const desvio = (await medirRelogio()) || 0;
  const base = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';

  const casos = [
    ['sem token nenhum', `${base}?TrustedClientToken=${TOKEN}`],
    ['token + versao 130', `${base}?TrustedClientToken=${TOKEN}&Sec-MS-GEC=${token()}&Sec-MS-GEC-Version=1-130.0.2849.68`],
    ['token + versao 131', `${base}?TrustedClientToken=${TOKEN}&Sec-MS-GEC=${token()}&Sec-MS-GEC-Version=1-131.0.2903.63`],
    ['token + versao 133', `${base}?TrustedClientToken=${TOKEN}&Sec-MS-GEC=${token()}&Sec-MS-GEC-Version=1-133.0.3065.39`],
    ['token corrigido p/ desvio', `${base}?TrustedClientToken=${TOKEN}&Sec-MS-GEC=${token(Math.round(desvio))}&Sec-MS-GEC-Version=1-130.0.2849.68`],
  ];

  console.log('\n== handshakes ==');
  for (const [rotulo, url] of casos) {
    console.log(await tentar(rotulo, url));
  }
}

main().catch((e) => console.error(e));

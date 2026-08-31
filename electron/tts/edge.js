'use strict';

/**
 * Cliente do Edge TTS (a voz do "Ler em voz alta" do navegador Edge).
 *
 * Gratuito e sem cadastro, mas exige um token anti-abuso (Sec-MS-GEC) que a
 * Microsoft passou a cobrar em 2024 -- por isso os pacotes antigos do npm nao
 * funcionam mais. O token e um SHA-256 do relogio arredondado pra baixo em
 * blocos de 5 minutos, concatenado com uma constante publica do cliente.
 *
 * Requer internet. Pro modo offline, ver ./piper.js.
 */

const crypto = require('crypto');
const WebSocket = require('ws');

const TOKEN_CLIENTE = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';

// ATENCAO -- e daqui que vem o 403 quando um dia parar de funcionar.
// A Microsoft recusa o handshake se essa versao ficar velha demais. Quando o
// motor "edge" comecar a dar 403, atualize as duas linhas abaixo pra versao
// atual do Edge estavel (veja em edge://version, ou copie de
// https://github.com/rany2/edge-tts/blob/master/src/edge_tts/constants.py).
// O motor "piper" e offline e nao sofre disso -- use ele se quiser paz.
const VERSAO_CHROMIUM = '143.0.3650.75';
const VERSAO_MAIOR = '143';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  `Chrome/${VERSAO_MAIOR}.0.0.0 Safari/537.36 Edg/${VERSAO_MAIOR}.0.0.0`;
const ORIGEM = 'chrome-extension://jdiccldimpahbcfhkgcpaliehnbmgkfa';

// Segundos entre 1601-01-01 (epoca do Windows) e 1970-01-01 (epoca Unix).
const EPOCA_WINDOWS = 11644473600;

/** Gera o token Sec-MS-GEC pro instante atual. */
function gerarToken() {
  let ticks = Math.floor(Date.now() / 1000) + EPOCA_WINDOWS;
  ticks -= ticks % 300; // arredonda pra baixo em blocos de 5 min
  ticks *= 10000000; // segundos -> intervalos de 100 nanossegundos
  return crypto.createHash('sha256').update(ticks + TOKEN_CLIENTE, 'ascii').digest('hex').toUpperCase();
}

function carimboDeTempo() {
  return new Date().toString().replace(/GMT.*$/, 'GMT+0000 (Coordinated Universal Time)');
}

function escaparXml(texto) {
  return String(texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Normaliza "10" | "+10" | "+10%" para o formato "+10%" que o SSML espera. */
function comSinal(valor, unidade) {
  const n = Number(valor) || 0;
  return `${n >= 0 ? '+' : ''}${n}${unidade}`;
}

function montarSsml({ texto, voz, velocidade = 0, tom = 0, volume = 0 }) {
  const lingua = (voz.match(/^([a-z]{2}-[A-Z]{2})/) || [])[1] || 'pt-BR';
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lingua}'>` +
    `<voice name='${voz}'>` +
    `<prosody rate='${comSinal(velocidade, '%')}' pitch='${comSinal(tom, 'Hz')}' volume='${comSinal(volume, '%')}'>` +
    escaparXml(texto) +
    `</prosody></voice></speak>`
  );
}

/**
 * Formatos de saida.
 *
 * So estes tres funcionam -- testados um por um. Os formatos `raw-*-pcm` da
 * documentacao da Azure NAO valem aqui: o endpoint do "ler em voz alta" fecha
 * a conexao com codigo 1007 quando voce pede PCM cru. Quem precisa de PCM (o
 * caminho de baixa latencia) usa o Piper, que ja entrega WAV.
 */
const FORMATOS = {
  mp3: 'audio-24khz-48kbitrate-mono-mp3',
  mp3Alta: 'audio-24khz-96kbitrate-mono-mp3',
  opus: 'webm-24khz-16bit-mono-opus',
};

/**
 * Lista as vozes disponiveis. Chamada HTTP simples, nao usa websocket.
 * @returns {Promise<Array>} vozes cruas da API
 */
async function listarVozes() {
  const url =
    `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list` +
    `?trustedclienttoken=${TOKEN_CLIENTE}&Sec-MS-GEC=${gerarToken()}` +
    `&Sec-MS-GEC-Version=1-${VERSAO_CHROMIUM}`;

  const resp = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'en-US,en;q=0.9',
      Origin: ORIGEM,
    },
  });
  if (!resp.ok) throw new Error(`lista de vozes falhou: HTTP ${resp.status}`);

  const brutas = await resp.json();
  return brutas.map((v) => ({
    id: v.ShortName,
    nome: (v.FriendlyName || v.ShortName).replace(/^Microsoft\s+/, '').replace(/\s+Online.*$/, ''),
    lingua: v.Locale,
    genero: v.Gender === 'Female' ? 'Feminina' : 'Masculina',
    personalidade: (v.VoiceTag && v.VoiceTag.VoicePersonalities) || [],
    motor: 'edge',
  }));
}

/**
 * Sintetiza texto em audio.
 * @returns {Promise<Buffer>} o audio no formato pedido
 */
function sintetizar({ texto, voz, velocidade = 0, tom = 0, volume = 0, formato = 'mp3' }) {
  return new Promise((resolve, reject) => {
    if (!texto || !texto.trim()) return reject(new Error('texto vazio'));

    const saida = FORMATOS[formato] || FORMATOS.mp3;
    const url =
      `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1` +
      `?TrustedClientToken=${TOKEN_CLIENTE}&Sec-MS-GEC=${gerarToken()}` +
      `&Sec-MS-GEC-Version=1-${VERSAO_CHROMIUM}`;

    const ws = new WebSocket(url, {
      headers: {
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
        Origin: ORIGEM,
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': USER_AGENT,
      },
    });

    const pedacos = [];
    let terminou = false;

    const limite = setTimeout(() => {
      if (!terminou) {
        terminou = true;
        try { ws.close(); } catch (_) {}
        reject(new Error('o servidor de voz nao respondeu em 20s'));
      }
    }, 20000);

    const encerrar = (erro, dados) => {
      if (terminou) return;
      terminou = true;
      clearTimeout(limite);
      try { ws.close(); } catch (_) {}
      erro ? reject(erro) : resolve(dados);
    };

    ws.on('open', () => {
      ws.send(
        `X-Timestamp:${carimboDeTempo()}\r\n` +
          `Content-Type:application/json; charset=utf-8\r\n` +
          `Path:speech.config\r\n\r\n` +
          JSON.stringify({
            context: {
              synthesis: {
                audio: {
                  metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
                  outputFormat: saida,
                },
              },
            },
          })
      );

      const idPedido = crypto.randomUUID().replace(/-/g, '');
      ws.send(
        `X-RequestId:${idPedido}\r\n` +
          `Content-Type:application/ssml+xml\r\n` +
          `X-Timestamp:${carimboDeTempo()}Z\r\n` +
          `Path:ssml\r\n\r\n` +
          montarSsml({ texto, voz, velocidade, tom, volume })
      );
    });

    ws.on('message', (dado, ehBinario) => {
      if (ehBinario) {
        // Quadro binario: 2 bytes big-endian com o tamanho do cabecalho,
        // o cabecalho em texto, e o resto e audio.
        const buf = Buffer.isBuffer(dado) ? dado : Buffer.from(dado);
        if (buf.length < 2) return;
        const tamCabecalho = buf.readUInt16BE(0);
        const cabecalho = buf.subarray(2, 2 + tamCabecalho).toString('utf8');
        if (cabecalho.includes('Path:audio')) {
          pedacos.push(buf.subarray(2 + tamCabecalho));
        }
        return;
      }

      const texto = dado.toString('utf8');
      if (texto.includes('Path:turn.end')) {
        if (!pedacos.length) return encerrar(new Error('o servidor nao devolveu audio'));
        encerrar(null, Buffer.concat(pedacos));
      }
    });

    ws.on('unexpected-response', (_req, res) => {
      if (res.statusCode === 403) {
        return encerrar(
          new Error(
            'O servidor da Microsoft recusou a conexao (403). Quase sempre isso quer dizer ' +
              `que a versao do Edge embutida no app (${VERSAO_CHROMIUM}) ficou velha. ` +
              'Atualize VERSAO_CHROMIUM em electron/tts/edge.js, ou use o motor Piper (offline).'
          )
        );
      }
      encerrar(new Error(`servidor de voz respondeu HTTP ${res.statusCode}`));
    });

    ws.on('error', (e) => {
      encerrar(new Error(`conexao com o servidor de voz falhou: ${e.message}`));
    });

    ws.on('close', (codigo) => {
      if (terminou) return;
      if (pedacos.length) return encerrar(null, Buffer.concat(pedacos));
      // 1007 costuma ser token recusado; os outros sao rede/bloqueio.
      encerrar(new Error(`conexao fechada pelo servidor (codigo ${codigo}) antes de mandar audio`));
    });
  });
}

module.exports = { listarVozes, sintetizar, FORMATOS, gerarToken };

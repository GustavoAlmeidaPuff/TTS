'use strict';

/**
 * Motor Piper: sintese de voz 100% offline, rodando na CPU.
 *
 * Diferente do motor Edge, aqui nao tem servidor, nao tem token e nao tem nada
 * pra quebrar quando a Microsoft mudar de ideia. E, por nao pagar ida e volta
 * de rede, e o unico dos dois que serve pro modo ao vivo.
 *
 * ---------------------------------------------------------------------------
 * Por que o processo fica vivo
 * ---------------------------------------------------------------------------
 * A versao anterior lancava um piper.exe por frase. Medindo o modo ao vivo,
 * cada trecho custava ~750ms fixos -- e a frase INTEIRA levava 1146ms. Ou seja:
 * quase todo o custo era carregar o modelo ONNX de novo, e nao sintetizar.
 *
 * Com um processo vivo por voz, isso vira: carrega uma vez (~1.4s) e depois
 * cada trecho custa ~160-330ms. No modo ao vivo a diferenca decide se a fila
 * acompanha voce ou vai ficando minutos pra tras.
 * ---------------------------------------------------------------------------
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');

const { baixar, descompactarZip, existe } = require('../comum/baixador');

const URL_BINARIO =
  'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip';
const BASE_VOZES = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';
const BASE_OVOS = 'https://huggingface.co/OpenVoiceOS';

function ovos(personagem, lingua, nome, genero) {
  return {
    id: `${lingua.replace('-', '_')}-${personagem}`,
    nome,
    lingua,
    genero,
    url: `${BASE_OVOS}/pipertts_${lingua}_${personagem}/resolve/main/${personagem}_${lingua}`,
  };
}

function oficial(id, nome, lingua, genero, caminho) {
  return { id, nome, lingua, genero, caminho };
}

/**
 * Catalogo curado: qualidade media, os dois idiomas do app, e as poucas
 * femininas que existem em portugues (o Piper oficial so tem masculinas).
 */
const CATALOGO = [
  ovos('dii', 'pt-BR', 'Dii', 'Feminina'),
  ovos('dii', 'pt-PT', 'Dii (Portugal)', 'Feminina'),
  oficial('pt_BR-faber-medium', 'Faber', 'pt-BR', 'Masculina', 'pt/pt_BR/faber/medium/pt_BR-faber-medium'),
  oficial('pt_BR-cadu-medium', 'Cadu', 'pt-BR', 'Masculina', 'pt/pt_BR/cadu/medium/pt_BR-cadu-medium'),
  oficial('pt_BR-jeff-medium', 'Jeff', 'pt-BR', 'Masculina', 'pt/pt_BR/jeff/medium/pt_BR-jeff-medium'),
  ovos('miro', 'pt-BR', 'Miro', 'Masculina'),

  oficial('en_US-amy-medium', 'Amy', 'en-US', 'Feminina', 'en/en_US/amy/medium/en_US-amy-medium'),
  oficial('en_US-lessac-medium', 'Lessac', 'en-US', 'Feminina', 'en/en_US/lessac/medium/en_US-lessac-medium'),
  oficial('en_US-kristin-medium', 'Kristin', 'en-US', 'Feminina', 'en/en_US/kristin/medium/en_US-kristin-medium'),
  oficial('en_US-hfc_female-medium', 'HFC', 'en-US', 'Feminina', 'en/en_US/hfc_female/medium/en_US-hfc_female-medium'),
  oficial('en_US-ryan-medium', 'Ryan', 'en-US', 'Masculina', 'en/en_US/ryan/medium/en_US-ryan-medium'),
  oficial('en_US-joe-medium', 'Joe', 'en-US', 'Masculina', 'en/en_US/joe/medium/en_US-joe-medium'),
  oficial('en_US-john-medium', 'John', 'en-US', 'Masculina', 'en/en_US/john/medium/en_US-john-medium'),
  oficial('en_US-hfc_male-medium', 'HFC', 'en-US', 'Masculina', 'en/en_US/hfc_male/medium/en_US-hfc_male-medium'),
];

let raiz = path.join(os.homedir(), '.voz-tts');
function definirRaiz(novaRaiz) {
  raiz = novaRaiz;
}

const pastaBinario = () => path.join(raiz, 'piper');
const pastaVozes = () => path.join(raiz, 'vozes');
const caminhoExe = () => path.join(pastaBinario(), 'piper', 'piper.exe');
const caminhoModelo = (id) => path.join(pastaVozes(), `${id}.onnx`);

/** O que ja esta baixado. A interface usa isso pra decidir o que oferecer. */
function status() {
  const vozesBaixadas = CATALOGO.filter(
    (v) => existe(caminhoModelo(v.id)) && existe(`${caminhoModelo(v.id)}.json`)
  ).map((v) => v.id);

  return {
    binarioInstalado: existe(caminhoExe()),
    vozesBaixadas,
    catalogo: CATALOGO,
    pasta: raiz,
  };
}

/** Instala o binario (se faltar) e a voz pedida. */
async function instalar(idVoz, aoProgresso) {
  const voz = CATALOGO.find((v) => v.id === idVoz);
  if (!voz) throw new Error(`voz desconhecida: ${idVoz}`);

  if (!existe(caminhoExe())) {
    const zip = path.join(raiz, 'piper.zip');
    await baixar(URL_BINARIO, zip, aoProgresso, 'motor Piper');
    if (aoProgresso) aoProgresso({ rotulo: 'descompactando o motor', porcento: null });
    await fsp.mkdir(pastaBinario(), { recursive: true });
    await descompactarZip(zip, pastaBinario());
    await fsp.rm(zip, { force: true });
    if (!existe(caminhoExe())) {
      throw new Error('o zip do Piper nao trouxe piper.exe onde eu esperava');
    }
  }

  const modelo = caminhoModelo(voz.id);
  const origem = voz.url || `${BASE_VOZES}/${voz.caminho}`;
  if (!existe(modelo)) {
    await baixar(`${origem}.onnx`, modelo, aoProgresso, `voz ${voz.nome}`);
  }
  if (!existe(`${modelo}.json`)) {
    await baixar(`${origem}.onnx.json`, `${modelo}.json`, aoProgresso, `ajustes da voz ${voz.nome}`);
  }
}

/** Todas as vozes do catalogo. As que ainda nao foram baixadas vem com baixada: false. */
async function listarVozes() {
  const { vozesBaixadas } = status();
  return CATALOGO.map((v) => ({
    id: v.id,
    nome: v.nome,
    lingua: v.lingua,
    genero: v.genero,
    personalidade: [],
    motor: 'piper',
    baixada: vozesBaixadas.includes(v.id),
  }));
}

// ================================================== processos vivos por voz ==

/** @type {Map<string, {proc: object, taxa: number, fila: Promise, ocioso: NodeJS.Timeout}>} */
const vivos = new Map();

/** Depois disso sem uso, o processo morre e devolve a memoria. */
const OCIOSIDADE_MS = 3 * 60 * 1000;

/** Pasta onde o Piper deixa os WAVs antes da gente ler e apagar. */
const pastaSaida = () => path.join(os.tmpdir(), 'voz-tts-piper');

/**
 * Contador GLOBAL, e nao por processo.
 *
 * A primeira versao contava por processo. Trocar de velocidade mata o processo
 * e abre outro, o contador voltava a zero, e o pedido novo reusava o nome de um
 * arquivo do processo anterior -- entao ele olhava um arquivo velho, que a
 * limpeza do pedido antigo apagava embaixo dele ("o WAV sumiu no meio do
 * caminho"). Nome de arquivo nao pode vir de estado que reinicia.
 */
let sequencia = 0;

function abrirProcesso(idVoz, velocidade) {
  const escala = escalaDeComprimento(velocidade);
  fs.mkdirSync(pastaSaida(), { recursive: true });

  // Restos de uma execucao que morreu no meio so ocupam disco. Mas apagar tudo
  // seria pior que o problema: outra voz pode ter um pedido EM VOO agora, e o
  // arquivo dele sumiria embaixo dele. Por isso so o que ja esta velho o
  // bastante pra nao pertencer a ninguem.
  const VELHO_MS = 60 * 1000;
  try {
    for (const arq of fs.readdirSync(pastaSaida())) {
      const alvo = path.join(pastaSaida(), arq);
      try {
        if (Date.now() - fs.statSync(alvo).mtimeMs > VELHO_MS) fs.rmSync(alvo, { force: true });
      } catch (_) { /* sumiu sozinho ou esta em uso */ }
    }
  } catch (_) { /* pasta nem existe ainda */ }

  const proc = spawn(
    caminhoExe(),
    [
      '--model', caminhoModelo(idVoz),
      // Com --json-input cada linha carrega o nome do arquivo de saida. Isso da
      // um fim de trecho DETERMINISTICO: o arquivo apareceu, acabou.
      //
      // A primeira versao usava --output_raw e adivinhava o fim pelo cano ficar
      // quieto. Funcionava com trechos curtos e cortava frases longas ao meio,
      // porque o Piper faz uma pausa entre frases enquanto gera -- e a pausa era
      // lida como "terminou". Palpite sobre borda de dado nao se conserta
      // aumentando o limiar; se troca por um delimitador de verdade.
      '--json-input',
      // Sem isso o Piper cola 0.2s de silencio no fim de cada frase. Numa frase
      // longa nao se nota; no modo ao vivo, com trechos de duas palavras, vira
      // 1/5 do tempo de fala em silencio.
      '--sentence_silence', '0',
      '--length_scale', String(escala),
      '--quiet',
    ],
    { cwd: path.dirname(caminhoExe()), windowsHide: true }
  );

  proc.stderr.resume(); // sem isso o buffer enche e o processo trava
  proc.stdout.resume();
  proc.on('error', () => vivos.delete(idVoz));
  proc.on('exit', () => vivos.delete(idVoz));

  return { proc, escala, fila: Promise.resolve(), ocioso: null };
}

/** O Piper mede velocidade ao contrario: maior = mais lento. */
function escalaDeComprimento(velocidade) {
  return Math.min(2.5, Math.max(0.4, 1 / (1 + Number(velocidade || 0) / 100)));
}

function agendarMorte(idVoz) {
  const vivo = vivos.get(idVoz);
  if (!vivo) return;
  clearTimeout(vivo.ocioso);
  vivo.ocioso = setTimeout(() => encerrarVoz(idVoz), OCIOSIDADE_MS);
  vivo.ocioso.unref?.();
}

function encerrarVoz(idVoz) {
  const vivo = vivos.get(idVoz);
  if (!vivo) return;
  clearTimeout(vivo.ocioso);
  vivos.delete(idVoz);
  try {
    vivo.proc.stdin.end();
    vivo.proc.kill();
  } catch (_) {
    /* ja morreu */
  }
}

/** Derruba todos os processos. Chamado quando o app fecha. */
function encerrarTudo() {
  for (const id of [...vivos.keys()]) encerrarVoz(id);
}

/**
 * Manda um pedido ao processo vivo e espera o WAV aparecer.
 *
 * O arquivo aparece no disco antes de estar completo, entao nao basta ele
 * existir: espera-se o tamanho parar de crescer entre duas olhadas.
 */
function pedirAoProcesso(vivo, texto, limiteMs = 15000) {
  const saida = path.join(pastaSaida(), `t${process.pid}-${sequencia++}-${Math.random().toString(36).slice(2, 8)}.wav`);

  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let terminou = false;

    const desistir = (mensagem) => {
      if (terminou) return;
      terminou = true;
      vivo.proc.off('exit', aoMorrer);
      fsp.rm(saida, { force: true }).catch(() => {});
      reject(new Error(mensagem));
    };

    const aoMorrer = () => desistir('o processo do Piper morreu no meio da sintese');
    vivo.proc.once('exit', aoMorrer);

    const olhar = () => {
      if (terminou) return;
      if (Date.now() - t0 > limiteMs) return desistir('o Piper nao respondeu a tempo');

      let tamanho;
      try {
        tamanho = fs.statSync(saida).size;
      } catch (_) {
        return setTimeout(olhar, 15); // ainda nao apareceu
      }

      // 44 bytes e so o cabecalho do WAV: ainda nao ha audio nenhum.
      if (tamanho <= 44) return setTimeout(olhar, 15);

      setTimeout(() => {
        if (terminou) return;
        let agora;
        try {
          agora = fs.statSync(saida).size;
        } catch (_) {
          return desistir('o WAV do Piper sumiu no meio do caminho');
        }
        if (agora !== tamanho) return olhar(); // ainda escrevendo

        terminou = true;
        vivo.proc.off('exit', aoMorrer);
        fsp
          .readFile(saida)
          .then((wav) => {
            fsp.rm(saida, { force: true }).catch(() => {});
            resolve(wav);
          })
          .catch((e) => reject(e));
      }, 30);
    };

    vivo.proc.stdin.write(
      JSON.stringify({ text: texto.replace(/[\r\n]+/g, ' '), output_file: saida }) + '\n'
    );
    olhar();
  });
}

/**
 * Sintetiza um texto em WAV.
 *
 * As chamadas para a mesma voz sao enfileiradas: um processo, um cano de
 * stdout, entao dois pedidos ao mesmo tempo misturariam o audio dos dois.
 */
async function sintetizar({ texto, voz, velocidade = 0 }) {
  if (!existe(caminhoExe())) throw new Error('o motor Piper ainda nao foi baixado');
  if (!existe(caminhoModelo(voz))) throw new Error(`a voz ${voz} ainda nao foi baixada`);
  if (!texto || !texto.trim()) throw new Error('texto vazio');

  let vivo = vivos.get(voz);

  // A velocidade e argumento de linha de comando, entao mudar de velocidade
  // exige um processo novo.
  if (vivo && vivo.escala !== escalaDeComprimento(velocidade)) {
    encerrarVoz(voz);
    vivo = null;
  }
  if (!vivo) {
    vivo = abrirProcesso(voz, velocidade);
    vivos.set(voz, vivo);
  }

  const pedido = vivo.fila.then(
    () => pedirAoProcesso(vivo, texto),
    () => pedirAoProcesso(vivo, texto)
  );
  // A fila nao pode quebrar quando um pedido falha, senao os proximos morrem junto.
  vivo.fila = pedido.catch(() => {});

  const wav = await pedido;
  agendarMorte(voz);
  return wav;
}

module.exports = {
  status, instalar, listarVozes, sintetizar,
  definirRaiz, encerrarTudo, CATALOGO,
};

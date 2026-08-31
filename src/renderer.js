'use strict';

/**
 * Interface do Voz TTS.
 *
 * Dois modos, mesmo caminho de saida:
 *   - Digitar : voce escreve, ele fala.
 *   - Ao vivo : voce fala, ele reconhece e refala com a voz escolhida.
 *
 * O truque central esta em `tocarBlob()`: o audio vai pra um dispositivo
 * especifico via `setSinkId`. Apontando pro "CABLE Input" de um cabo virtual,
 * qualquer programa que escute o "CABLE Output" ouve como se fosse microfone.
 */

const $ = (id) => document.getElementById(id);

const el = {
  ponto: $('ponto-estado'), estado: $('estado'),
  abaDigitar: $('aba-digitar'), abaVivo: $('aba-vivo'),
  modoDigitar: $('modo-digitar'), modoVivo: $('modo-vivo'),
  blocoHistorico: $('bloco-historico'), grupoVivo: $('grupo-vivo'),

  texto: $('texto'), btnFalar: $('btn-falar'), btnParar: $('btn-parar'),
  btnTestar: $('btn-testar'), btnRestaurar: $('btn-restaurar'),

  saida: $('saida'), monitorar: $('monitorar'), monitor: $('monitor'),
  avisoCabo: $('aviso-cabo'), btnBaixarCabo: $('btn-baixar-cabo'),

  motor: $('motor'), descricaoMotor: $('descricao-motor'),
  idioma: $('idioma'), voz: $('voz'),
  piperInstalar: $('piper-instalar'), btnInstalarPiper: $('btn-instalar-piper'),
  barraPiper: $('barra-piper'), barraPiperPreenchida: $('barra-piper-preenchida'),
  textoProgressoPiper: $('texto-progresso-piper'),

  velocidade: $('velocidade'), tom: $('tom'), volume: $('volume'),
  valorVelocidade: $('valor-velocidade'), valorTom: $('valor-tom'), valorVolume: $('valor-volume'),

  listaHistorico: $('lista-historico'), btnLimparHistorico: $('btn-limpar-historico'),

  // ao vivo
  vivoInstalar: $('vivo-instalar'), vivoInstalarTexto: $('vivo-instalar-texto'),
  btnInstalarVoz: $('btn-instalar-voz'), barraVoz: $('barra-voz'),
  barraVozPreenchida: $('barra-voz-preenchida'), textoProgressoVoz: $('texto-progresso-voz'),
  btnMicrofone: $('btn-microfone'), microfone: $('microfone'),
  medidorPreenchido: $('medidor-preenchido'), dicaVivo: $('dica-vivo'),
  parcialFirme: $('parcial-firme'), parcialSolto: $('parcial-solto'),
  contadorAtraso: $('contador-atraso'),
  listaTrechos: $('lista-trechos'), btnLimparTrechos: $('btn-limpar-trechos'),
  pausa: $('pausa'), valorPausa: $('valor-pausa'),
  vivoInstalarTitulo: $('vivo-instalar-titulo'),
};

const audioPrincipal = new Audio();
const audioMonitor = new Audio();

let vozes = [];
let historico = [];
let urlAtual = null;
let falando = false;
let modo = 'digitar';
/** Ultimo retrato do que ja foi baixado, pra decidir o que oferecer. */
let statusVoz = { catalogo: [], modelosBaixados: [] };

const PADROES = { velocidade: 0, tom: 0, volume: 100 };
/** O app esta montado pro ingles: e esta a voz que ele baixa e usa. */
const VOZ_INGLES = 'en_US-amy-medium';
const PADRAO_CABO = /(cable input|vb-audio|virtual cable|voicemeeter|virtual audio|vac\b)/i;

/** Os dois unicos idiomas: cada um puxa o reconhecedor e as vozes juntos. */
const IDIOMAS = [
  { id: 'pt', nome: 'Português', modelo: 'multi' },
  { id: 'en', nome: 'Inglês', modelo: 'en' },
];

function normalizarIdioma(valor) {
  const v = String(valor || '').toLowerCase();
  if (v.startsWith('pt') || v === 'multi') return 'pt';
  return 'en';
}

function metaDoIdioma(id = idiomaAtual()) {
  return IDIOMAS.find((i) => i.id === id) || IDIOMAS[1];
}

function idiomaAtual() {
  const ativa = el.idioma.querySelector('.escolha-opcao.ativa');
  return ativa ? ativa.dataset.idioma : 'en';
}

function marcarIdioma(id) {
  const alvo = normalizarIdioma(id);
  for (const botao of el.idioma.querySelectorAll('.escolha-opcao')) {
    botao.classList.toggle('ativa', botao.dataset.idioma === alvo);
  }
}

function modeloDoIdioma() {
  return metaDoIdioma().modelo;
}

function vozesDoIdioma(id = idiomaAtual()) {
  return vozes.filter((v) => (v.lingua || '').toLowerCase().startsWith(id));
}

function avisar(mensagem, tipo = '') {
  el.estado.textContent = mensagem;
  el.estado.classList.toggle('erro', tipo === 'erro');
  el.ponto.className = 'ponto' + (tipo ? ` ${tipo}` : ' pronto');
}

// ============================================================== reproducao ===

/**
 * Toca um blob nos destinos escolhidos e resolve quando terminar.
 * @param {Blob} blob
 * @param {number} [ritmo=1] velocidade de reproducao (o Chromium preserva o tom)
 */
async function tocarBlob(blob, ritmo = 1) {
  if (urlAtual) URL.revokeObjectURL(urlAtual);
  urlAtual = URL.createObjectURL(blob);

  const ganho = Number(el.volume.value) / 100;
  const destinos = [{ audio: audioPrincipal, dispositivo: el.saida.value, rotulo: 'saída principal' }];

  audioPrincipal.src = urlAtual;
  audioPrincipal.volume = ganho;
  audioPrincipal.playbackRate = ritmo;

  if (el.monitorar.checked && el.monitor.value) {
    audioMonitor.src = urlAtual;
    audioMonitor.volume = ganho;
    audioMonitor.playbackRate = ritmo;
    destinos.push({ audio: audioMonitor, dispositivo: el.monitor.value, rotulo: 'monitor' });
  }

  for (const d of destinos) {
    if (d.audio.setSinkId && d.dispositivo) {
      try {
        await d.audio.setSinkId(d.dispositivo);
      } catch (e) {
        throw new Error(`não consegui usar a ${d.rotulo}: ${e.message}`);
      }
    }
  }

  await Promise.all(
    destinos.map(
      (d) =>
        new Promise((resolve, reject) => {
          d.audio.onended = resolve;
          d.audio.onerror = () => reject(new Error(`falha ao tocar na ${d.rotulo}`));
          d.audio.play().catch(reject);
        })
    )
  );
}

/**
 * Pede a sintese ao processo principal.
 * @param {string} texto
 * @param {number} [reforco=0] acrescimo de velocidade, em pontos percentuais
 */
async function sintetizar(texto, reforco = 0) {
  const r = await window.api.falar({
    motor: el.motor.value,
    texto,
    voz: el.voz.value,
    velocidade: Number(el.velocidade.value) + reforco,
    tom: Number(el.tom.value),
  });
  if (!r.ok) throw new Error(r.erro);
  return new Blob([r.audio], { type: r.mime });
}

// =================================================================== fila ====

/**
 * Fila de fala do modo ao vivo.
 *
 * Cada item e uma frase inteira, do jeito que o reconhecedor fechou.
 *
 * O ponto aqui e que sintetizar e tocar acontecem AO MESMO TEMPO: enquanto a
 * frase 1 esta tocando, a frase 2 ja esta sendo sintetizada. Em serie a fila
 * cresceria sem parar quando voce emenda uma frase na outra.
 *
 * Tocar continua estritamente em ordem -- so a sintese e adiantada.
 */
// `window.__fila` e uma janelinha de diagnostico: os testes em testes/ leem o
// estado da fila por ela pra provar que nada ficou preso no meio do caminho.
const fila = (window.__fila = {
  itens: [],
  sintetizando: false,
  tocando: false,
  descartados: 0,

  /** Limite de espera: se acumular demais, o mais antigo perde a validade. */
  MAX: 6,

  enfileirar(texto) {
    this.itens.push({ texto, blob: null, falhou: false, entrouEm: Date.now() });
    if (this.itens.length > this.MAX) {
      this.itens.shift();
      this.descartados++;
      avisar(`Ficando pra trás — descartei ${this.descartados} trecho(s).`, 'ocupado');
    }
    this._bombearSintese();
  },

  /** Quantas palavras no maximo entram num unico pedido de sintese. */
  MAX_PALAVRAS: 9,

  async _bombearSintese() {
    if (this.sintetizando) return;
    const inicio = this.itens.findIndex((i) => !i.blob && !i.falhou);
    if (inicio === -1) return;

    // Funde os trechos pendentes num pedido so.
    //
    // Duas palavras soltas viram ~0,9s de audio pra ~0,35s de fala, porque toda
    // frase isolada carrega entrada, saida e prosodia de frase completa. Juntas,
    // as mesmas palavras saem no ritmo de fala normal -- e o TTS ainda soa
    // melhor, porque le uma frase em vez de sete pedacos.
    //
    // A fusao se regula sozinha: com voce em dia so ha um trecho pendente e nada
    // e fundido (atraso minimo); atrasado, os pendentes se juntam e a fila
    // recupera terreno.
    let fim = inicio;
    let palavras = 0;
    while (fim < this.itens.length && !this.itens[fim].blob && !this.itens[fim].falhou) {
      palavras += this.itens[fim].texto.trim().split(/\s+/).length;
      fim++;
      if (palavras >= this.MAX_PALAVRAS) break;
    }

    const lote = this.itens.slice(inicio, fim);
    const alvo =
      lote.length === 1
        ? lote[0]
        : { texto: lote.map((i) => i.texto).join(' '), blob: null, falhou: false, entrouEm: lote[0].entrouEm };
    if (lote.length > 1) this.itens.splice(inicio, lote.length, alvo);

    this.sintetizando = true;
    try {
      alvo.blob = await sintetizar(alvo.texto);
    } catch (e) {
      alvo.falhou = true;
      avisar(e.message, 'erro');
    }
    this.sintetizando = false;

    this._bombearSintese();
    this._bombearReproducao();
  },

  async _bombearReproducao() {
    if (this.tocando) return;
    const primeiro = this.itens[0];
    if (!primeiro) return;
    // Ainda nao sintetizou: espera o bombeamento da sintese chamar de novo.
    if (!primeiro.blob && !primeiro.falhou) return;

    this.itens.shift();
    if (primeiro.falhou) return this._bombearReproducao();

    this.tocando = true;
    const ritmo = this._ritmo();
    registrarTrecho(primeiro.texto, Date.now() - primeiro.entrouEm, ritmo);
    try {
      await tocarBlob(primeiro.blob, ritmo);
    } catch (e) {
      avisar(e.message, 'erro');
    }
    this.tocando = false;
    this._bombearReproducao();
  },

  /**
   * Acelera a fala quando a fila enche, e volta ao normal quando alcanca.
   *
   * Esperando a frase acabar, a fala de volta comeca depois da sua e leva mais
   * ou menos o mesmo tempo -- entao quem fala em frases separadas nunca acumula
   * atraso, e ouve a voz na velocidade natural.
   *
   * Quem emenda uma frase na outra sem respirar e que acumula: a fila enche
   * enquanto a anterior ainda esta sendo falada. Ai vale apertar o passo.
   */
  _ritmo() {
    return Math.min(1.5, 1 + this.itens.length * 0.12);
  },

  limpar() {
    this.itens = [];
    this.descartados = 0;
  },
});

// ============================================================ modo digitar ===

async function falar(textoForcado) {
  if (falando) return;
  const texto = (textoForcado ?? el.texto.value).trim();
  if (!texto) {
    avisar('Escreva alguma coisa primeiro.', 'erro');
    el.texto.focus();
    return;
  }
  if (!el.voz.value || !vozes.some((v) => v.id === el.voz.value)) {
    avisar('Escolha uma voz primeiro.', 'erro');
    return;
  }

  falando = true;
  el.btnFalar.disabled = true;
  el.btnParar.disabled = false;
  avisar('Sintetizando…', 'ocupado');

  const inicio = Date.now();
  try {
    const blob = await sintetizar(texto);
    avisar(`Falando… (sintetizado em ${((Date.now() - inicio) / 1000).toFixed(1)}s)`, 'ocupado');
    await tocarBlob(blob);
    registrarNoHistorico(texto);
    avisar('Pronto.');
  } catch (e) {
    avisar(e.message, 'erro');
  } finally {
    falando = false;
    el.btnFalar.disabled = false;
    el.btnParar.disabled = true;
  }
}

function parar() {
  for (const audio of [audioPrincipal, audioMonitor]) {
    audio.pause();
    audio.currentTime = 0;
  }
  fila.limpar();
  falando = false;
  el.btnFalar.disabled = false;
  el.btnParar.disabled = true;
  avisar('Parado.');
}

// ============================================================= modo ao vivo ==

const microfone = {
  contexto: null,
  fluxo: null,
  no: null,
  ligado: false,
};

/**
 * Liga a captura do microfone.
 *
 * O AudioContext e criado ja em 16 kHz: assim o proprio Chromium reamostra, o
 * que e mais barato e mais correto do que reamostrar na mao depois -- e 16 kHz
 * e exatamente o que o reconhecedor quer.
 */
async function ligarMicrofone() {
  const dispositivo = el.microfone.value;

  microfone.fluxo = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: dispositivo ? { exact: dispositivo } : undefined,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  microfone.contexto = new AudioContext({ sampleRate: 16000 });
  await microfone.contexto.audioWorklet.addModule('captura-worklet.js');

  const origem = microfone.contexto.createMediaStreamSource(microfone.fluxo);
  microfone.no = new AudioWorkletNode(microfone.contexto, 'coletor-de-voz', {
    processorOptions: { amostrasPorPedaco: 1600 }, // 100ms a 16 kHz
  });

  microfone.no.port.onmessage = ({ data }) => {
    window.api.vozAudio(data.amostras);
    // Medidor: raiz quadrada comprime a escala e deixa a fala visivel sem
    // precisar gritar (a escala linear fica quase sempre colada no zero).
    const altura = Math.min(100, Math.sqrt(data.nivel) * 160);
    el.medidorPreenchido.style.height = altura + '%';
  };

  origem.connect(microfone.no);
  // Sem um destino o grafo nao roda. O ganho zero garante que este caminho
  // nunca produza som -- quem toca e a fila, no dispositivo escolhido.
  const mudo = microfone.contexto.createGain();
  mudo.gain.value = 0;
  microfone.no.connect(mudo).connect(microfone.contexto.destination);

  microfone.ligado = true;
}

async function desligarMicrofone() {
  if (microfone.no) microfone.no.port.onmessage = null;
  if (microfone.fluxo) microfone.fluxo.getTracks().forEach((t) => t.stop());
  if (microfone.contexto) await microfone.contexto.close().catch(() => {});
  microfone.contexto = microfone.fluxo = microfone.no = null;
  microfone.ligado = false;
  el.medidorPreenchido.style.height = '0%';
}

async function alternarEscuta() {
  if (microfone.ligado) {
    el.btnMicrofone.disabled = true;
    window.api.vozEncerrarTrecho();
    await desligarMicrofone();
    await window.api.vozParar();
    el.btnMicrofone.textContent = 'Começar a escutar';
    el.btnMicrofone.classList.remove('gravando');
    el.btnMicrofone.disabled = false;
    avisar('Escuta desligada.');
    return;
  }

  if (!avaliarMicrofone()) {
    avisar('Escolha um microfone de verdade: o cabo virtual faria o app ouvir a si mesmo.', 'erro');
    return;
  }

  el.btnMicrofone.disabled = true;
  avisar('Carregando o reconhecedor…', 'ocupado');

  const r = await window.api.vozIniciar({
    modelo: el.modeloVoz.value,
    pausaFinalS: Number(el.pausa.value) / 1000,
  });

  if (!r.ok) {
    el.btnMicrofone.disabled = false;
    avisar(r.erro, 'erro');
    await verificarModelosVoz();
    return;
  }

  try {
    await ligarMicrofone();
  } catch (e) {
    await window.api.vozParar();
    el.btnMicrofone.disabled = false;
    avisar(`não consegui abrir o microfone: ${e.message}`, 'erro');
    return;
  }

  fila.limpar();
  el.btnMicrofone.textContent = 'Parar de escutar';
  el.btnMicrofone.classList.add('gravando');
  el.btnMicrofone.disabled = false;
  avisar(`Escutando. (reconhecedor carregou em ${(r.carregouEmMs / 1000).toFixed(1)}s)`);
}

function registrarTrecho(texto, esperaMs, ritmo = 1) {
  const vazio = el.listaTrechos.querySelector('.vazio');
  if (vazio) vazio.remove();

  const item = document.createElement('li');
  item.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = texto;
  const tempo = document.createElement('span');
  tempo.className = 'tempo';
  tempo.textContent = esperaMs + 'ms' + (ritmo > 1.01 ? '  ' + ritmo.toFixed(2) + 'x' : '');
  item.append(span, tempo);
  el.listaTrechos.prepend(item);

  while (el.listaTrechos.children.length > 60) el.listaTrechos.lastElementChild.remove();
  el.contadorAtraso.textContent = `fila: ${fila.itens.length}`;
}

// ================================================================ ajustes ====

async function carregarDispositivos() {
  try {
    const fluxo = await navigator.mediaDevices.getUserMedia({ audio: true });
    fluxo.getTracks().forEach((t) => t.stop());
  } catch (_) {
    avisar('Sem permissão de áudio: os nomes dos dispositivos podem não aparecer.', 'erro');
  }

  const todos = await navigator.mediaDevices.enumerateDevices();
  const saidas = todos.filter((d) => d.kind === 'audiooutput');
  const entradas = todos.filter((d) => d.kind === 'audioinput');

  const preencher = (select, lista, selecionado) => {
    select.innerHTML = '';
    for (const d of lista) {
      const opcao = document.createElement('option');
      opcao.value = d.deviceId;
      opcao.textContent = d.label || `Dispositivo ${d.deviceId.slice(0, 6)}`;
      select.appendChild(opcao);
    }
    if (selecionado && lista.some((d) => d.deviceId === selecionado)) select.value = selecionado;
  };

  const saidaAtual = el.saida.value;
  const microfoneAtual = el.microfone.value;
  preencher(el.saida, saidas, saidaAtual);
  preencher(el.monitor, saidas, el.monitor.value);
  preencher(el.microfone, entradas, microfoneAtual);

  const cabo = saidas.find((d) => PADRAO_CABO.test(d.label || ''));
  if (!saidaAtual && cabo) el.saida.value = cabo.deviceId;
  el.avisoCabo.classList.toggle('oculto', Boolean(cabo));

  // O cabo virtual aparece dos DOIS lados: "CABLE Input" como saida e
  // "CABLE Output" como entrada. E o "CABLE Output" costuma virar o microfone
  // padrao do Windows -- o que aqui seria desastroso: o app escutaria a propria
  // voz que acabou de falar e entraria em retroalimentacao. Entao o padrao e
  // sempre um microfone de verdade.
  if (!microfoneAtual) {
    const real = entradas.find((d) => !PADRAO_CABO.test(d.label || ''));
    if (real) el.microfone.value = real.deviceId;
  }
  avaliarMicrofone();
}

/** Avisa se o microfone escolhido for o proprio cabo (retroalimentacao). */
function avaliarMicrofone() {
  const escolhido = el.microfone.selectedOptions[0];
  const ehCabo = escolhido && PADRAO_CABO.test(escolhido.textContent || '');
  el.microfone.classList.toggle('perigo', Boolean(ehCabo));
  if (ehCabo) {
    el.dicaVivo.textContent =
      'Esse "microfone" é o próprio cabo — o app ouviria a si mesmo. Escolha seu microfone de verdade.';
    el.dicaVivo.classList.add('alerta-texto');
  }
  return !ehCabo;
}

async function carregarMotores() {
  const motores = await window.api.listarMotores();
  el.motor.innerHTML = '';
  for (const m of motores) {
    const opcao = document.createElement('option');
    opcao.value = m.id;
    opcao.textContent = m.nome;
    opcao.dataset.descricao = m.descricao;
    el.motor.appendChild(opcao);
  }
}

async function carregarVozes() {
  const motor = el.motor.value;
  const selecionada = el.motor.selectedOptions[0];
  el.descricaoMotor.textContent = selecionada ? selecionada.dataset.descricao : '';

  avisar('Buscando vozes…', 'ocupado');
  const r = await window.api.listarVozes(motor);

  if (!r.ok) {
    vozes = [];
    el.voz.innerHTML = '<option>—</option>';
    el.idioma.innerHTML = '<option>—</option>';
    avisar(r.erro, 'erro');
  } else {
    vozes = r.vozes;
  }

  if (motor === 'piper') {
    const status = await window.api.piperStatus();
    // Ter uma voz qualquer nao basta: sem a voz inglesa, falar inglês com uma
    // voz treinada em português sai com sotaque de leitura, palavra por palavra.
    const temIngles = status.vozesBaixadas.includes(VOZ_INGLES);
    el.piperInstalar.classList.toggle('oculto', Boolean(status.binarioInstalado && temIngles));
  } else {
    el.piperInstalar.classList.add('oculto');
  }

  if (!vozes.length) {
    el.voz.innerHTML = '<option>nenhuma voz disponível</option>';
    el.idioma.innerHTML = '<option>—</option>';
    if (r.ok) avisar('Nenhuma voz disponível neste motor.', 'erro');
    return;
  }

  const idiomas = [...new Set(vozes.map((v) => v.lingua))].sort((a, b) => {
    if (a.startsWith('en')) return -1;
    if (b.startsWith('en')) return 1;
    return a.localeCompare(b);
  });

  const anterior = el.idioma.value;
  el.idioma.innerHTML = '';
  for (const lingua of idiomas) {
    const opcao = document.createElement('option');
    opcao.value = lingua;
    opcao.textContent = `${lingua} (${vozes.filter((v) => v.lingua === lingua).length})`;
    el.idioma.appendChild(opcao);
  }
  el.idioma.value = idiomas.includes(anterior) ? anterior : idiomas[0];

  filtrarVozes();
  avisar('Pronto.');
}

function filtrarVozes() {
  const lingua = el.idioma.value;
  const anterior = el.voz.value;
  const doIdioma = vozes.filter((v) => v.lingua === lingua);

  el.voz.innerHTML = '';
  for (const v of doIdioma) {
    const opcao = document.createElement('option');
    opcao.value = v.id;
    const traco = v.personalidade.length ? ` — ${v.personalidade.join(', ').toLowerCase()}` : '';
    opcao.textContent = `${v.nome} (${v.genero})${traco}`;
    el.voz.appendChild(opcao);
  }
  if (doIdioma.some((v) => v.id === anterior)) el.voz.value = anterior;
}

async function verificarModelosVoz() {
  statusVoz = await window.api.vozModelos();

  el.modeloVoz.innerHTML = '';
  for (const m of statusVoz.catalogo) {
    const opcao = document.createElement('option');
    opcao.value = m.id;
    const baixado = statusVoz.modelosBaixados.includes(m.id);
    opcao.textContent = `${m.nome}${baixado ? '' : ` — ${m.mb} MB a baixar`}`;
    opcao.dataset.descricao = m.descricao;
    el.modeloVoz.appendChild(opcao);
  }

  // O catalogo vem do que entende ingles melhor pro que entende menos bem,
  // entao o primeiro ja baixado e a melhor escolha que nao faz ninguem esperar.
  const primeiroBaixado = statusVoz.catalogo.find((m) => statusVoz.modelosBaixados.includes(m.id));
  if (primeiroBaixado) el.modeloVoz.value = primeiroBaixado.id;
  atualizarEscolhaDeModelo();
  return statusVoz;
}

/** Descricao, aviso de download e botao de escutar seguem o modelo escolhido. */
function atualizarEscolhaDeModelo() {
  const op = el.modeloVoz.selectedOptions[0];
  el.descricaoModelo.textContent = op ? op.dataset.descricao || '' : '';

  const pronto = statusVoz.modelosBaixados.includes(el.modeloVoz.value);
  el.vivoInstalar.classList.toggle('oculto', pronto);
  el.btnMicrofone.disabled = !pronto;
}

// ============================================================== historico ====

function registrarNoHistorico(texto) {
  historico = [texto, ...historico.filter((t) => t !== texto)].slice(0, 25);
  desenharHistorico();
  salvar();
}

function desenharHistorico() {
  el.listaHistorico.innerHTML = '';
  if (!historico.length) {
    const vazio = document.createElement('li');
    vazio.className = 'vazio';
    vazio.textContent = 'Nada ainda. O que você falar aparece aqui pra repetir com um clique.';
    el.listaHistorico.appendChild(vazio);
    return;
  }
  for (const texto of historico) {
    const item = document.createElement('li');
    item.textContent = texto;
    item.title = 'Clique para falar de novo';
    item.addEventListener('click', () => {
      el.texto.value = texto;
      falar(texto);
    });
    el.listaHistorico.appendChild(item);
  }
}

// =========================================================== persistencia ====

function salvar() {
  window.api.salvarConfig({
    motor: el.motor.value, idioma: el.idioma.value, voz: el.voz.value,
    saida: el.saida.value, monitor: el.monitor.value, monitorar: el.monitorar.checked,
    microfone: el.microfone.value, modeloVoz: el.modeloVoz.value,
    pausa: Number(el.pausa.value),
    velocidade: Number(el.velocidade.value), tom: Number(el.tom.value),
    volume: Number(el.volume.value),
    historico,
  });
}

function atualizarValores() {
  const v = Number(el.velocidade.value);
  el.valorVelocidade.textContent = `${v > 0 ? '+' : ''}${v}%`;
  const t = Number(el.tom.value);
  el.valorTom.textContent = `${t > 0 ? '+' : ''}${t} Hz`;
  el.valorVolume.textContent = `${el.volume.value}%`;
  el.valorPausa.textContent = `${(Number(el.pausa.value) / 1000).toFixed(1).replace('.', ',')}s`;
}

// =============================================================== instalacao ==

/** Instalador comum aos dois downloads (voz do Piper e reconhecedor). */
async function instalarComProgresso({ botao, barra, preenchida, texto, aoProgresso, executar }) {
  botao.disabled = true;
  barra.classList.remove('oculto');

  const desligar = aoProgresso((p) => {
    if (p.porcento != null) {
      preenchida.style.width = `${p.porcento}%`;
      const mb = (p.baixado / 1048576).toFixed(1);
      const total = p.total ? ` de ${(p.total / 1048576).toFixed(1)} MB` : '';
      texto.textContent = `${p.rotulo}: ${mb} MB${total} (${p.porcento}%)`;
    } else {
      texto.textContent = `${p.rotulo}…`;
    }
  });

  const r = await executar();
  desligar();
  botao.disabled = false;

  if (!r.ok) {
    texto.textContent = `Falhou: ${r.erro}`;
    avisar(r.erro, 'erro');
    return false;
  }
  barra.classList.add('oculto');
  texto.textContent = '';
  return true;
}

// ================================================================== modos ====

function trocarModo(novo) {
  modo = novo;
  const vivo = novo === 'vivo';

  el.abaVivo.classList.toggle('ativa', vivo);
  el.abaDigitar.classList.toggle('ativa', !vivo);
  el.modoVivo.classList.toggle('oculto', !vivo);
  el.modoDigitar.classList.toggle('oculto', vivo);
  el.grupoVivo.classList.toggle('oculto', !vivo);
  el.blocoHistorico.classList.toggle('oculto', vivo);

  if (vivo) {
    verificarModelosVoz();
    // O Edge cobra 1,5 a 3,5s de ida e volta de rede por trecho -- em tempo
    // real isso e a diferenca entre acompanhar e ficar minutos atras.
    if (el.motor.value === 'edge') {
      el.dicaVivo.textContent = 'Troque o motor para Piper: o Edge depende da internet e atrasa demais aqui.';
      el.dicaVivo.classList.add('alerta-texto');
    } else {
      el.dicaVivo.textContent = 'Fale à vontade: cada frase sai depois que você faz uma pausa.';
      el.dicaVivo.classList.remove('alerta-texto');
    }
  } else if (microfone.ligado) {
    alternarEscuta();
  }
}

// ================================================================= inicio ====

async function iniciar() {
  await carregarMotores();

  const config = await window.api.lerConfig();
  if (config.motor) el.motor.value = config.motor;
  if (config.velocidade !== undefined) el.velocidade.value = config.velocidade;
  if (config.tom !== undefined) el.tom.value = config.tom;
  if (config.volume !== undefined) el.volume.value = config.volume;
  if (config.pausa !== undefined) el.pausa.value = config.pausa;
  if (config.monitorar) el.monitorar.checked = true;
  historico = Array.isArray(config.historico) ? config.historico : [];

  atualizarValores();
  desenharHistorico();

  await carregarDispositivos();
  if (config.saida) el.saida.value = config.saida;
  if (config.monitor) el.monitor.value = config.monitor;
  if (config.microfone) el.microfone.value = config.microfone;
  el.monitor.disabled = !el.monitorar.checked;

  await carregarVozes();
  if (config.idioma) {
    el.idioma.value = config.idioma;
    filtrarVozes();
  }
  if (config.voz) el.voz.value = config.voz;

  const status = await verificarModelosVoz();
  if (config.modeloVoz && status.modelosBaixados.includes(config.modeloVoz)) {
    el.modeloVoz.value = config.modeloVoz;
    atualizarEscolhaDeModelo();
  }

  el.texto.focus();
}

// =============================================================== ligacoes ====

el.abaDigitar.addEventListener('click', () => trocarModo('digitar'));
el.abaVivo.addEventListener('click', () => trocarModo('vivo'));

el.btnFalar.addEventListener('click', () => falar());
el.btnParar.addEventListener('click', parar);
el.texto.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    falar();
  }
});
el.btnTestar.addEventListener('click', () =>
  falar('Teste de saída. Se você está me ouvindo, o caminho do áudio está certo.')
);

el.btnMicrofone.addEventListener('click', alternarEscuta);

el.motor.addEventListener('change', async () => {
  await carregarVozes();
  if (modo === 'vivo') trocarModo('vivo');
  salvar();
});
el.idioma.addEventListener('change', () => { filtrarVozes(); salvar(); });
el.voz.addEventListener('change', salvar);
el.saida.addEventListener('change', salvar);
el.monitor.addEventListener('change', salvar);
el.microfone.addEventListener('change', () => { avaliarMicrofone(); salvar(); });
el.modeloVoz.addEventListener('change', () => { atualizarEscolhaDeModelo(); salvar(); });

el.monitorar.addEventListener('change', () => {
  el.monitor.disabled = !el.monitorar.checked;
  salvar();
});

for (const deslizante of [el.velocidade, el.tom, el.volume, el.pausa]) {
  deslizante.addEventListener('input', atualizarValores);
  deslizante.addEventListener('change', salvar);
}

el.btnRestaurar.addEventListener('click', () => {
  el.velocidade.value = PADROES.velocidade;
  el.tom.value = PADROES.tom;
  el.volume.value = PADROES.volume;
  atualizarValores();
  salvar();
});

el.btnLimparHistorico.addEventListener('click', () => {
  historico = [];
  desenharHistorico();
  salvar();
});

el.btnLimparTrechos.addEventListener('click', () => {
  el.listaTrechos.innerHTML = '<li class="vazio">Nada ainda. Clique em “Começar a escutar” e fale.</li>';
});

el.btnInstalarPiper.addEventListener('click', async () => {
  const ok = await instalarComProgresso({
    botao: el.btnInstalarPiper, barra: el.barraPiper,
    preenchida: el.barraPiperPreenchida, texto: el.textoProgressoPiper,
    aoProgresso: window.api.aoProgressoPiper,
    executar: () => window.api.piperInstalar(VOZ_INGLES),
  });
  if (ok) {
    await carregarVozes();
    // Foi por ela que o download aconteceu, entao ja deixa ela escolhida.
    if (vozes.some((v) => v.id === VOZ_INGLES)) {
      el.idioma.value = 'en-US';
      filtrarVozes();
      el.voz.value = VOZ_INGLES;
      salvar();
    }
    avisar('Voz em inglês instalada.');
  }
});

el.btnInstalarVoz.addEventListener('click', async () => {
  const ok = await instalarComProgresso({
    botao: el.btnInstalarVoz, barra: el.barraVoz,
    preenchida: el.barraVozPreenchida, texto: el.textoProgressoVoz,
    aoProgresso: window.api.aoProgressoVoz,
    executar: () => window.api.vozInstalarModelo(el.modeloVoz.value || 'multi'),
  });
  if (ok) {
    avisar('Reconhecimento instalado.');
    await verificarModelosVoz();
  }
});

el.btnBaixarCabo.addEventListener('click', () => window.api.abrirLink('https://vb-audio.com/Cable/'));

navigator.mediaDevices.addEventListener('devicechange', carregarDispositivos);

// ---------------------------------------------------- eventos do ao vivo ----

window.api.aoParcial(({ texto, entregue }) => {
  // A parte ja falada fica opaca; o resto, que ainda pode mudar, fica apagado.
  el.parcialFirme.textContent = entregue;
  el.parcialSolto.textContent = texto.slice(entregue.length);
});

window.api.aoTrecho(({ texto }) => {
  if (texto.trim()) fila.enfileirar(texto);
});

window.api.aoAtalhoFalar(() => {
  if (modo === 'vivo') alternarEscuta();
  else falar();
});

window.addEventListener('beforeunload', () => {
  if (microfone.ligado) {
    desligarMicrofone();
    window.api.vozParar();
  }
});

iniciar().catch((e) => avisar(`Falha ao iniciar: ${e.message}`, 'erro'));

'use strict';

/**
 * Modo ao vivo da bancada: microfone entrando, voz trocada saindo, contínuo.
 *
 * A parte delicada aqui é o TOCADOR. Os blocos convertidos chegam a cada ~0,5s
 * e precisam sair colados. Tocar um `Audio` por bloco deixaria um buraco entre
 * eles (cada `play()` tem uma partida própria), e o resultado picotaria.
 *
 * Por isso os blocos são AGENDADOS numa linha do tempo do AudioContext: cada um
 * começa exatamente onde o anterior termina, com precisão de amostra. Se a
 * conversão atrasar e a linha do tempo passar, a agenda é reancorada — melhor
 * um salto do que a voz ficar cada vez mais atrás.
 */

const vivo = {
  contexto: null,
  fluxo: null,
  no: null,
  ligado: false,
  proximoInicio: 0,
  desligarBloco: null,
  blocos: 0,
  reancoragens: 0,
};

/** Cria o contexto de saída já apontado pro dispositivo escolhido. */
async function abrirSaida(dispositivo) {
  const ctx = new AudioContext();
  if (dispositivo && typeof ctx.setSinkId === 'function') {
    try {
      await ctx.setSinkId(dispositivo);
    } catch (e) {
      avisar('não consegui usar essa saída: ' + e.message, 'erro');
    }
  }
  return ctx;
}

/** Agenda um bloco convertido pra tocar logo depois do anterior. */
function agendar(ctx, amostras, taxa) {
  const buffer = ctx.createBuffer(1, amostras.length, taxa);
  buffer.getChannelData(0).set(amostras);

  const fonte = ctx.createBufferSource();
  fonte.buffer = buffer;
  fonte.connect(ctx.destination);

  // Uma folga curta: agendar no instante exato às vezes chega tarde demais.
  const agora = ctx.currentTime + 0.02;
  if (vivo.proximoInicio < agora) {
    // A conversão ficou pra trás. Reancora em vez de acumular atraso.
    if (vivo.proximoInicio > 0) vivo.reancoragens++;
    vivo.proximoInicio = agora;
  }

  fonte.start(vivo.proximoInicio);
  vivo.proximoInicio += buffer.duration;
}

async function ligarVivo() {
  const dispositivoSaida = $('saida').value;
  const blocoS = 0.5;

  const r = await window.rvc.vivoIniciar({
    blocoS,
    contextoS: 0.5,
    tomAlvo: Number($('alvo-hz').value),
  });
  if (!r.ok) return avisar(r.erro, 'erro');

  vivo.contexto = await abrirSaida(dispositivoSaida);
  vivo.proximoInicio = 0;
  vivo.blocos = 0;
  vivo.reancoragens = 0;

  vivo.desligarBloco = window.rvc.aoBloco((d) => {
    if (!vivo.ligado || !vivo.contexto) return;
    agendar(vivo.contexto, d.audio instanceof Float32Array ? d.audio : new Float32Array(d.audio), d.taxa);
    vivo.blocos++;

    const fila = Math.max(0, vivo.proximoInicio - vivo.contexto.currentTime);
    $('p-atraso').textContent = Math.round((blocoS + fila) * 1000) + ' ms';
    $('p-gasto').textContent = d.gastoMs + ' ms  (folga ' + d.folgaMs + ' ms)';
    $('p-gasto').style.color = d.folgaMs < 0 ? 'var(--erro)' : '';
  });

  // Captura do microfone, igual à da gravação.
  vivo.fluxo = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: $('microfone').value ? { exact: $('microfone').value } : undefined,
      echoCancellation: true, noiseSuppression: true, autoGainControl: true,
    },
  });

  const entrada = new AudioContext({ sampleRate: 16000 });
  await entrada.audioWorklet.addModule('../src/captura-worklet.js');
  vivo.no = new AudioWorkletNode(entrada, 'coletor-de-voz', {
    processorOptions: { amostrasPorPedaco: 1600 },
  });
  vivo.no.port.onmessage = ({ data }) => {
    window.rvc.vivoAudio(data.amostras);
    $('medidor').style.height = Math.min(100, Math.sqrt(data.nivel) * 160) + '%';
  };
  const mudo = entrada.createGain();
  mudo.gain.value = 0;
  entrada.createMediaStreamSource(vivo.fluxo).connect(vivo.no);
  vivo.no.connect(mudo).connect(entrada.destination);
  vivo.entrada = entrada;

  vivo.ligado = true;
  $('btn-vivo').textContent = 'Parar';
  $('btn-vivo').classList.add('gravando');
  $('placar').style.display = '';
  $('p-orcamento').textContent = blocoS * 1000;
  $('btn-gravar').disabled = true;
  avisar('ao vivo — fale');
}

async function desligarVivo() {
  vivo.ligado = false;
  if (vivo.desligarBloco) vivo.desligarBloco();
  if (vivo.no) vivo.no.port.onmessage = null;
  if (vivo.fluxo) vivo.fluxo.getTracks().forEach((t) => t.stop());
  if (vivo.entrada) await vivo.entrada.close().catch(() => {});
  if (vivo.contexto) await vivo.contexto.close().catch(() => {});
  vivo.contexto = vivo.fluxo = vivo.no = vivo.entrada = null;

  await window.rvc.vivoParar();

  $('medidor').style.height = '0%';
  $('btn-vivo').textContent = 'Falar ao vivo';
  $('btn-vivo').classList.remove('gravando');
  $('btn-gravar').disabled = false;
  const estado = vivo.reancoragens
    ? `parado — ${vivo.blocos} blocos, ${vivo.reancoragens} reancoragens`
    : `parado — ${vivo.blocos} blocos, sem falhas`;
  avisar(estado);
}

$('btn-vivo').addEventListener('click', async () => {
  try {
    if (vivo.ligado) await desligarVivo();
    else await ligarVivo();
  } catch (e) {
    avisar(e.message, 'erro');
    vivo.ligado = false;
  }
});

window.rvc.aoVivoErro((m) => avisar('erro na conversão: ' + m, 'erro'));

/** Lista as saídas de áudio e evita começar num dispositivo que não existe. */
async function listarSaidas() {
  const todos = await navigator.mediaDevices.enumerateDevices();
  const saidas = todos.filter((d) => d.kind === 'audiooutput');
  const sel = $('saida');
  sel.innerHTML = '';
  for (const d of saidas) {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || 'Saída';
    sel.appendChild(o);
  }
  // Se houver cabo virtual, é quase certo que é o destino desejado.
  const cabo = saidas.find((d) => /cable input|vb-audio/i.test(d.label || ''));
  if (cabo) sel.value = cabo.deviceId;
}

// Chamado daqui, e nao do outro arquivo: ele carrega antes deste, e chamar
// listarSaidas() de la dependeria de a ordem de carga dar certo por acaso.
listarSaidas().catch((e) => avisar('nao consegui listar as saidas: ' + e.message, 'erro'));

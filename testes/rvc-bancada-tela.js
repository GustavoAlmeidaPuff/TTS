'use strict';

/** Tela da bancada do RVC: grava do microfone, converte e deixa comparar. */

const $ = (id) => document.getElementById(id);
const TAXA = 16000;
const PADRAO_CABO = /(cable|vb-audio|virtual|voicemeeter|vac\b)/i;

let contexto = null;
let fluxo = null;
let no = null;
let gravando = false;
let pedacos = [];
let amostras = 0;
let inicio = 0;
let relogio = null;

let tomAlvo = 200;
let audioOriginal = null;
let audioConvertido = null;

function avisar(msg, tipo = '') {
  $('estado').textContent = msg;
  $('estado').classList.toggle('erro', tipo === 'erro');
}

/** Monta um WAV tocável a partir de amostras float. */
function montarWav(dados, taxa) {
  const buf = new ArrayBuffer(44 + dados.length * 2);
  const v = new DataView(buf);
  const txt = (pos, s) => { for (let i = 0; i < s.length; i++) v.setUint8(pos + i, s.charCodeAt(i)); };
  txt(0, 'RIFF'); v.setUint32(4, 36 + dados.length * 2, true); txt(8, 'WAVE');
  txt(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, taxa, true); v.setUint32(28, taxa * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  txt(36, 'data'); v.setUint32(40, dados.length * 2, true);
  for (let i = 0; i < dados.length; i++) {
    v.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(dados[i] * 32767))), true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

function tocar(dados, taxa) {
  const a = new Audio(URL.createObjectURL(montarWav(dados, taxa)));
  a.play();
}

async function listarMicrofones() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
  } catch (_) { /* sem permissao os nomes vem vazios, mas ainda da pra gravar */ }

  const todos = await navigator.mediaDevices.enumerateDevices();
  const entradas = todos.filter((d) => d.kind === 'audioinput');
  const sel = $('microfone');
  sel.innerHTML = '';
  for (const d of entradas) {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || 'Microfone';
    sel.appendChild(o);
  }
  // Nunca comeca no cabo virtual: ele ouviria a saida do proprio app.
  const real = entradas.find((d) => !PADRAO_CABO.test(d.label || ''));
  if (real) sel.value = real.deviceId;
}

async function comecar() {
  fluxo = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: $('microfone').value ? { exact: $('microfone').value } : undefined,
      echoCancellation: true, noiseSuppression: true, autoGainControl: true,
    },
  });

  contexto = new AudioContext({ sampleRate: TAXA });
  await contexto.audioWorklet.addModule('../src/captura-worklet.js');

  no = new AudioWorkletNode(contexto, 'coletor-de-voz', {
    processorOptions: { amostrasPorPedaco: 1600 },
  });
  no.port.onmessage = ({ data }) => {
    pedacos.push(data.amostras);
    amostras += data.amostras.length;
    $('medidor').style.height = Math.min(100, Math.sqrt(data.nivel) * 160) + '%';
  };

  const mudo = contexto.createGain();
  mudo.gain.value = 0;
  contexto.createMediaStreamSource(fluxo).connect(no);
  no.connect(mudo).connect(contexto.destination);

  gravando = true;
  pedacos = [];
  amostras = 0;
  inicio = Date.now();
  $('btn-gravar').textContent = 'Parar e converter';
  $('btn-gravar').classList.add('gravando');
  avisar('gravando…');

  relogio = setInterval(() => {
    $('relogio').textContent = ((Date.now() - inicio) / 1000).toFixed(1).replace('.', ',') + 's';
  }, 100);
}

async function parar() {
  gravando = false;
  clearInterval(relogio);
  if (no) no.port.onmessage = null;
  if (fluxo) fluxo.getTracks().forEach((t) => t.stop());
  if (contexto) await contexto.close().catch(() => {});
  contexto = fluxo = no = null;
  $('medidor').style.height = '0%';
  $('btn-gravar').textContent = 'Gravar';
  $('btn-gravar').classList.remove('gravando');

  const juntas = new Float32Array(amostras);
  let pos = 0;
  for (const p of pedacos) { juntas.set(p, pos); pos += p.length; }

  if (juntas.length < TAXA * 0.5) {
    avisar('gravação curta demais — fale por uns 3 segundos', 'erro');
    return;
  }

  audioOriginal = { dados: juntas, taxa: TAXA };
  $('btn-original').disabled = false;

  avisar('convertendo…');
  $('btn-gravar').disabled = true;

  const auto = $('auto-tom').checked;
  const r = await window.rvc.converter(
    juntas,
    auto ? { tomAlvo: Number($('alvo-hz').value) } : { semitons: Number($('semitons').value) }
  );
  $('btn-gravar').disabled = false;

  if (!r.ok) return avisar(r.erro, 'erro');

  audioConvertido = { dados: r.audio, taxa: r.taxa };
  $('btn-convertido').disabled = false;
  $('btn-salvar').disabled = false;

  $('t-conteudo').textContent = r.tempos.conteudo + ' ms';
  $('t-melodia').textContent = r.tempos.melodia + ' ms';
  $('t-gerador').textContent = r.tempos.gerador + ' ms';
  const fator = r.tempos.total / (r.tempos.segundosDeAudio * 1000);
  $('t-fator').textContent = r.tempos.total + ' ms  →  ' + fator.toFixed(2) + 'x';

  // Mostrar a conta do tom e o que explica um resultado rouco.
  if (r.tom && r.tom.seu) {
    $('explica-tom').textContent =
      'Sua voz: ' + r.tom.seu + ' Hz  →  alvo: ' + (r.tom.alvo || tomAlvo) + ' Hz' +
      '  =  ' + (r.tom.semitons > 0 ? '+' : '') + r.tom.semitons + ' semitons';
    $('semitons').value = Math.round(r.tom.semitons);
    $('valor-semitons').textContent = (r.tom.semitons > 0 ? '+' : '') + Math.round(r.tom.semitons) + ' semitons';
  } else if (r.tom) {
    $('explica-tom').textContent = 'Não achei tom na gravação — fale mais alto ou por mais tempo.';
  }

  avisar(
    fator < 1
      ? `pronto — ${fator.toFixed(2)}x, cabe ao vivo`
      : `pronto, mas ${fator.toFixed(2)}x: mais lento que tempo real`
  );

  // Toca a convertida na hora: e o que voce quer ouvir.
  tocar(r.audio, r.taxa);
}

// ------------------------------------------------------------------ ligacoes

$('btn-gravar').addEventListener('click', async () => {
  try {
    if (gravando) await parar();
    else await comecar();
  } catch (e) {
    avisar(e.message, 'erro');
    gravando = false;
  }
});

$('btn-original').addEventListener('click', () => {
  if (audioOriginal) tocar(audioOriginal.dados, audioOriginal.taxa);
});
$('btn-convertido').addEventListener('click', () => {
  if (audioConvertido) tocar(audioConvertido.dados, audioConvertido.taxa);
});

$('btn-salvar').addEventListener('click', async () => {
  const r = await window.rvc.salvar(
    audioOriginal.dados, audioOriginal.taxa,
    audioConvertido.dados, audioConvertido.taxa
  );
  avisar(r.ok ? 'salvo em ' + r.pasta : r.erro, r.ok ? '' : 'erro');
});

$('auto-tom').addEventListener('change', () => {
  const auto = $('auto-tom').checked;
  $('semitons').disabled = auto;
  $('bloco-manual').style.opacity = auto ? '0.45' : '1';
});

$('semitons').addEventListener('input', () => {
  const v = Number($('semitons').value);
  $('valor-semitons').textContent = (v > 0 ? '+' : '') + v + ' semitons';
});

async function listarVozes() {
  const vozes = await window.rvc.vozes();
  const sel = $('voz-alvo');
  sel.innerHTML = '';
  for (const v of vozes) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v.replace(/_/g, ' ');
    sel.appendChild(o);
  }
}

$('voz-alvo').addEventListener('change', async () => {
  const id = $('voz-alvo').value;
  avisar('trocando para ' + id + '…');
  $('btn-gravar').disabled = true;
  const r = await window.rvc.trocarVoz(id);
  $('btn-gravar').disabled = false;
  avisar(r.ok ? 'voz agora: ' + id + ' — grave de novo pra comparar' : r.erro, r.ok ? '' : 'erro');
});

$('alvo-hz').addEventListener('input', () => {
  $('valor-alvo-hz').textContent = $('alvo-hz').value + ' Hz';
});

(async () => {
  await listarMicrofones();
  await listarVozes();
  const info = await window.rvc.pronto();
  $('btn-gravar').disabled = false;
  $('btn-vivo').disabled = false;
  if (info.tomAlvoPadrao) {
    tomAlvo = info.tomAlvoPadrao;
    $('alvo-hz').value = tomAlvo;
    $('valor-alvo-hz').textContent = tomAlvo + ' Hz';
  }
  if (info.voz) $('voz-alvo').value = info.voz;
  $('nota-gpu').textContent = info.semGpu
    ? 'ATENÇÃO: a GPU não aceitou o modelo, está rodando na CPU — vai ficar bem mais lento.'
    : 'Gerador rodando na GPU (DirectML). Voz: ' + info.voz;
  avisar('pronto — grave uns segundos');
})().catch((e) => avisar('falha ao iniciar: ' + e.message, 'erro'));

'use strict';

/**
 * Modo "Trocar timbre": você fala, sai a voz escolhida com a sua entonação.
 *
 * Diferente do modo Ao vivo, aqui não há texto em lugar nenhum — nada é
 * reconhecido nem relido. O áudio entra, o timbre sai trocado, e o que é seu
 * (ritmo, pausas, emoção) fica.
 *
 * ---------------------------------------------------------------------------
 * O tocador, que é a parte delicada
 * ---------------------------------------------------------------------------
 * Os blocos convertidos chegam a cada ~0,5s e precisam sair colados. Um `Audio`
 * por bloco deixaria um buraco entre eles (cada `play()` tem sua própria
 * partida) e a voz sairia picotada.
 *
 * Por isso cada bloco é AGENDADO na linha do tempo do AudioContext, começando
 * exatamente onde o anterior termina, com precisão de amostra. Se a conversão
 * atrasar e a linha do tempo já tiver passado, a agenda é reancorada — melhor
 * um salto curto do que a voz afundar cada vez mais atrás.
 * ---------------------------------------------------------------------------
 */

(() => {
  const $ = (id) => document.getElementById(id);
  const TAXA = 16000;
  const BLOCO_S = 0.75;
  /**
   * Nomes que denunciam um cabo de retorno DE VERDADE.
   *
   * A primeira versão testava a palavra "virtual" sozinha, e isso acusava
   * dispositivos legítimos: "Virtual Desktop Audio" (o microfone do app de VR),
   * "NVIDIA Virtual Audio", "Virtual Audio Device". Recusar o microfone do
   * usuário porque o nome tem uma palavra em comum é pior que não checar nada.
   *
   * Aqui as marcas são específicas: cabo de retorno se chama pelo nome.
   */
  const PADRAO_CABO = /(vb-audio|virtual cable|voicemeeter|\bvac\b|cable (input|output))/i;

  /**
   * O que realmente causa retroalimentação não é o nome: é o microfone ser a
   * OUTRA PONTA do mesmo cabo pra onde o app está escrevendo.
   *
   * "CABLE Input (VB-Audio Virtual Cable)" e "CABLE Output (VB-Audio Virtual
   * Cable)" são o mesmo cabo — o que sai de um entra no outro. Já o seu fone e
   * o seu microfone não têm relação nenhuma, mesmo que os dois digam "virtual".
   *
   * A comparação é pelo miolo entre parênteses, que é o nome do driver.
   */
  function mesmaFamilia(nomeA, nomeB) {
    const familia = (n) => {
      const m = /\(([^)]+)\)\s*$/.exec(String(n || '').trim());
      return (m ? m[1] : String(n || '')).toLowerCase().trim();
    };
    const a = familia(nomeA);
    const b = familia(nomeB);
    return Boolean(a) && a === b && PADRAO_CABO.test(a);
  }

  const t = {
    entrada: null,
    saidas: [],
    fluxo: null,
    no: null,
    ligado: false,
    carregando: false,
    remontando: null,
    desligarBloco: null,
    blocos: 0,
    reancoragens: 0,
    status: null,
  };

  const el = {
    aviso: $('timbre-instalar'),
    avisoTexto: $('timbre-instalar-texto'),
    btnInstalar: $('btn-instalar-timbre'),
    barra: $('barra-timbre'),
    barraCheia: $('barra-timbre-preenchida'),
    progresso: $('texto-progresso-timbre'),
    pronto: $('timbre-pronto'),
    btn: $('btn-timbre'),
    medidor: $('medidor-timbre'),
    dica: $('dica-timbre'),
    microfone: $('microfone-timbre'),
    atraso: $('tb-atraso'),
    gasto: $('tb-gasto'),
    tom: $('tb-tom'),
    orcamento: $('tb-orcamento'),
    portao: $('tb-portao'),
    gpu: $('tb-gpu'),
    voz: $('voz-timbre'),
    descricaoVoz: $('descricao-voz-timbre'),
    alvoHz: $('alvo-hz'),
    valorAlvoHz: $('valor-alvo-hz'),
  };

  // ------------------------------------------------------------- dispositivos

  async function listarMicrofones() {
    const todos = await navigator.mediaDevices.enumerateDevices();
    const entradas = todos.filter((d) => d.kind === 'audioinput');
    const anterior = el.microfone.value;

    el.microfone.innerHTML = '';
    for (const d of entradas) {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || 'Microfone';
      el.microfone.appendChild(o);
    }

    if (anterior && entradas.some((d) => d.deviceId === anterior)) {
      el.microfone.value = anterior;
      return;
    }
    // Não começa numa ponta de cabo de retorno; qualquer outro microfone serve.
    const real = entradas.find((d) => !PADRAO_CABO.test(d.label || ''));
    if (real) el.microfone.value = real.deviceId;
    else if (entradas.length) el.microfone.value = entradas[0].deviceId;
  }

  // -------------------------------------------------------------- instalação

  async function atualizarStatus() {
    t.status = await window.api.rvcStatus();

    el.voz.innerHTML = '';
    for (const v of t.status.catalogo) {
      const o = document.createElement('option');
      o.value = v.id;
      const baixada = t.status.vozesBaixadas.includes(v.id);
      o.textContent = v.nome + (baixada ? '' : ` — ${v.mb} MB a baixar`);
      o.dataset.descricao = v.descricao;
      o.dataset.tom = v.tomSugerido;
      el.voz.appendChild(o);
    }
    const primeira =
      t.status.catalogo.find((v) => t.status.vozesBaixadas.includes(v.id)) ||
      t.status.catalogo.find((v) => v.padrao) ||
      t.status.catalogo[0];
    if (primeira) el.voz.value = primeira.id;
    mostrarDescricaoVoz();

    el.aviso.classList.toggle('oculto', t.status.pronto);
    el.pronto.classList.toggle('oculto', !t.status.pronto);
    if (!t.status.pronto) {
      el.avisoTexto.textContent =
        `São cerca de ${t.status.faltamMb} MB, uma vez só. Depois funciona sem ` +
        'internet, na sua placa de vídeo.';
    }
    return t.status;
  }

  function mostrarDescricaoVoz() {
    const op = el.voz.selectedOptions[0];
    if (!op) return;
    el.descricaoVoz.textContent = op.dataset.descricao || '';
    if (!t.ligado && op.dataset.tom) {
      el.alvoHz.value = op.dataset.tom;
      el.valorAlvoHz.textContent = op.dataset.tom + ' Hz';
    }
  }

  el.btnInstalar.addEventListener('click', async () => {
    el.btnInstalar.disabled = true;
    el.barra.classList.remove('oculto');

    const desligar = window.api.aoProgressoRvc((p) => {
      if (p.porcento != null) {
        el.barraCheia.style.width = p.porcento + '%';
        const mb = (p.baixado / 1048576).toFixed(0);
        const total = p.total ? ` de ${(p.total / 1048576).toFixed(0)} MB` : '';
        el.progresso.textContent = `${p.rotulo}: ${mb} MB${total} (${p.porcento}%)`;
      } else {
        el.progresso.textContent = p.rotulo + '…';
      }
    });

    const r = await window.api.rvcInstalar(el.voz.value);
    desligar();
    el.btnInstalar.disabled = false;

    if (!r.ok) {
      el.progresso.textContent = 'Falhou: ' + r.erro;
      return avisar(r.erro, 'erro');
    }
    el.barra.classList.add('oculto');
    el.progresso.textContent = '';
    avisar('Troca de timbre instalada.');
    await atualizarStatus();
  });

  // ------------------------------------------------------------------- saídas

  /**
   * Para onde a voz trocada deve ir agora.
   *
   * O painel "Para onde vai a voz" é o mesmo em todos os modos, inclusive a
   * caixa "Ouvir também no meu fone" — mas aqui ela não fazia nada: o timbre
   * montava UM contexto, apontado pro cabo, e um AudioContext toca num
   * dispositivo por vez. Marcar pra se escutar não mudava nada porque não havia
   * ninguém tocando no fone.
   *
   * Lido na hora, nunca guardado: os seletores são do app inteiro e podem mudar
   * com o timbre já rodando.
   */
  function destinosDesejados() {
    const ler = (id) => {
      const s = document.getElementById(id);
      const op = s && s.selectedOptions[0];
      return { dispositivo: s ? s.value : '', nome: op ? op.textContent : '' };
    };
    const monitorar = document.getElementById('monitorar');
    const lista = [{ ...ler('saida'), rotulo: 'saída principal' }];
    const fone = ler('monitor');
    if (monitorar && monitorar.checked && fone.dispositivo) {
      lista.push({ ...fone, rotulo: 'monitor' });
    }
    return lista;
  }

  /** Monta (ou remonta) um AudioContext por destino. */
  async function prepararSaidas() {
    const desejado = destinosDesejados();
    const igual =
      t.saidas.length === desejado.length &&
      t.saidas.every((s, i) => s.dispositivo === desejado[i].dispositivo);
    if (igual) return;

    await soltarSaidas();

    const novas = [];
    for (const alvo of desejado) {
      const ctx = new AudioContext();
      if (alvo.dispositivo && typeof ctx.setSinkId === 'function') {
        try {
          await ctx.setSinkId(alvo.dispositivo);
        } catch (e) {
          avisar(`não consegui usar a ${alvo.rotulo}: ${e.message}`, 'erro');
        }
      }
      novas.push({ ...alvo, ctx, proximo: 0 });
    }
    t.saidas = novas;
  }

  async function soltarSaidas() {
    const antigas = t.saidas;
    t.saidas = [];
    for (const s of antigas) await s.ctx.close().catch(() => {});
  }

  /**
   * Refaz as saídas sem parar a troca de timbre.
   *
   * Em fila, porque marcar a caixa e trocar o fone em seguida dispararia duas
   * remontagens ao mesmo tempo — e a segunda fecharia contextos que a primeira
   * ainda estava criando. Os blocos que chegam no meio da troca são
   * descartados: um buraco curto ao trocar de dispositivo é o esperado.
   */
  function remontarSaidas() {
    t.remontando = (t.remontando || Promise.resolve())
      .then(() => (t.ligado || t.saidas.length ? prepararSaidas() : null))
      .catch((e) => avisar(e.message, 'erro'));
    return t.remontando;
  }

  // ------------------------------------------------------------------ tocador

  function agendar(amostras, taxa) {
    let reancorou = false;

    for (const s of t.saidas) {
      const buffer = s.ctx.createBuffer(1, amostras.length, taxa);
      buffer.getChannelData(0).set(amostras);

      const fonte = s.ctx.createBufferSource();
      fonte.buffer = buffer;
      fonte.connect(s.ctx.destination);

      // Uma folga curta: agendar no instante exato às vezes chega tarde demais.
      // Cada destino tem seu próprio relógio, então cada um tem sua agenda.
      const agora = s.ctx.currentTime + 0.02;
      if (s.proximo < agora) {
        if (s.proximo > 0) reancorou = true;
        s.proximo = agora;
      }

      fonte.start(s.proximo);
      s.proximo += buffer.duration;
    }

    // Uma reancoragem por bloco, não uma por destino: o que atrasou foi a
    // conversão, e ela é a mesma pros dois.
    if (reancorou) t.reancoragens++;
  }

  /**
   * Mostra o portao de silencio no placar.
   *
   * Nao e enfeite: se um dia o portao cortar a voz de alguem que fala baixo, e
   * aqui que da pra ver -- o nivel medido ao lado do corte, ao vivo.
   */
  function mostrarPortao(d) {
    if (!el.portao || d.nivel == null) return;
    const n = (v) => v.toFixed(3);
    el.portao.textContent = d.silencio
      ? `fechado — nível ${n(d.nivel)} (corte ${n(d.limiar)})`
      : `aberto — nível ${n(d.nivel)} (corte ${n(d.limiar)})`;
    el.portao.classList.toggle('alerta-texto', Boolean(d.silencio));
  }

  // -------------------------------------------------------------- liga/desliga

  async function ligar() {
    if (!t.status || !t.status.pronto) return avisar('Baixe a troca de timbre primeiro.', 'erro');

    // Só recusa quando o microfone é a outra ponta do MESMO cabo que vai receber
    // a voz. Aí sim seria retroalimentação imediata.
    const escolhido = el.microfone.selectedOptions[0];
    const laco =
      escolhido && destinosDesejados().some((d) => mesmaFamilia(escolhido.textContent, d.nome));
    if (laco) {
      return avisar(
        'Esse microfone é a outra ponta do cabo pra onde a voz vai — o app ouviria a si mesmo.',
        'erro'
      );
    }

    t.carregando = true;
    el.btn.disabled = true;
    avisar('Carregando a voz na placa de vídeo…', 'ocupado');

    const desligarProgresso = window.api.aoProgressoRvc((p) => avisar(p.rotulo + '…', 'ocupado'));
    const carga = await window.api.rvcCarregar(el.voz.value);
    desligarProgresso();
    t.carregando = false;

    if (!carga.ok) {
      el.btn.disabled = false;
      return avisar(carga.erro, 'erro');
    }

    el.gpu.textContent = carga.semGpu
      ? 'ATENÇÃO: a placa de vídeo recusou o modelo; está na CPU e vai atrasar.'
      : `Rodando na placa de vídeo (dispositivo ${carga.dispositivo}).`;
    el.gpu.classList.toggle('alerta-texto', Boolean(carga.semGpu));

    // Aquece ANTES de abrir o microfone.
    //
    // As duas primeiras conversões de uma sessão custam o dobro (a placa ainda
    // está compilando os grafos). Se isso acontecer com o microfone já aberto,
    // os dois blocos atrasados empurram a agenda de reprodução pra frente — e
    // ela NUNCA recupera, porque o agendador só reancora quando fica atrás,
    // nunca quando está adiantado. O atraso do primeiro segundo virava o atraso
    // permanente da sessão: 2s em vez de 0,8s.
    avisar('Aquecendo…', 'ocupado');
    await window.api.rvcAquecer(BLOCO_S);

    const inicio = await window.api.rvcVivoIniciar({
      blocoS: BLOCO_S,
      contextoS: 0.35,
      tomAlvo: Number(el.alvoHz.value),
    });
    if (!inicio.ok) {
      el.btn.disabled = false;
      return avisar(inicio.erro, 'erro');
    }

    // Saídas: os mesmos seletores do resto do app — o cabo virtual e, se a
    // caixa estiver marcada, o fone.
    await prepararSaidas();
    t.blocos = 0;
    t.reancoragens = 0;

    t.desligarBloco = window.api.aoBlocoRvc((d) => {
      if (!t.ligado || !t.saidas.length) return;

      // Portao fechado: ninguem falou, nao veio audio nenhum, nao ha o que
      // tocar. Enquanto ainda houver som na fila a agenda anda junto com o
      // relogio, pra a pausa na saida ter o mesmo tamanho da pausa na fala;
      // quando a fila esvazia, a ancora e esquecida (o zero) pra a proxima
      // frase comecar na hora, sem esperar um buraco que ja passou.
      if (d.silencio) {
        for (const s of t.saidas) {
          s.proximo = s.proximo > s.ctx.currentTime ? s.proximo + BLOCO_S : 0;
        }
        mostrarPortao(d);
        return;
      }

      agendar(d.audio instanceof Float32Array ? d.audio : new Float32Array(d.audio), d.taxa);
      t.blocos++;

      const principal = t.saidas[0];
      const fila = Math.max(0, principal.proximo - principal.ctx.currentTime);
      el.atraso.textContent = Math.round((BLOCO_S + fila) * 1000) + ' ms';
      el.gasto.textContent = d.gastoMs + ' ms  (folga ' + d.folgaMs + ' ms)';
      el.gasto.style.color = d.folgaMs < 0 ? 'var(--erro)' : '';
      mostrarPortao(d);
      if (d.tom && d.tom.seu) {
        el.tom.textContent = `${d.tom.seu} Hz → ${d.tom.alvo} Hz  (${d.tom.semitons > 0 ? '+' : ''}${d.tom.semitons} st)`;
      }
    });

    // Captura do microfone, em 16 kHz (o Chromium reamostra sozinho).
    t.fluxo = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: el.microfone.value ? { exact: el.microfone.value } : undefined,
        echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      },
    });

    t.entrada = new AudioContext({ sampleRate: TAXA });
    await t.entrada.audioWorklet.addModule('captura-worklet.js');
    t.no = new AudioWorkletNode(t.entrada, 'coletor-de-voz', {
      processorOptions: { amostrasPorPedaco: 1600 },
    });
    t.no.port.onmessage = ({ data }) => {
      window.api.rvcAudio(data.amostras);
      el.medidor.style.height = Math.min(100, Math.sqrt(data.nivel) * 160) + '%';
    };
    // Sem um destino o grafo não roda; ganho zero garante que este caminho
    // nunca produza som (quem toca é o agendador, na outra ponta).
    const mudo = t.entrada.createGain();
    mudo.gain.value = 0;
    t.entrada.createMediaStreamSource(t.fluxo).connect(t.no);
    t.no.connect(mudo).connect(t.entrada.destination);

    if (el.orcamento) el.orcamento.textContent = Math.round(BLOCO_S * 1000);

    t.ligado = true;
    el.btn.disabled = false;
    el.btn.textContent = 'Parar';
    el.btn.classList.add('gravando');
    avisar('Trocando o timbre — fale.');
  }

  async function desligar() {
    t.ligado = false;
    if (t.desligarBloco) t.desligarBloco();
    if (t.no) t.no.port.onmessage = null;
    if (t.fluxo) t.fluxo.getTracks().forEach((x) => x.stop());
    if (t.entrada) await t.entrada.close().catch(() => {});
    await soltarSaidas();
    t.entrada = t.fluxo = t.no = null;

    await window.api.rvcVivoParar();

    el.medidor.style.height = '0%';
    if (el.portao) {
      el.portao.textContent = '—';
      el.portao.classList.remove('alerta-texto');
    }
    el.btn.textContent = 'Trocar minha voz';
    el.btn.classList.remove('gravando');
    avisar(
      t.reancoragens
        ? `Parado — ${t.blocos} blocos, ${t.reancoragens} reancoragens.`
        : `Parado — ${t.blocos} blocos, sem falhas.`
    );
  }

  // ------------------------------------------------------------------ ligações

  el.btn.addEventListener('click', async () => {
    try {
      if (t.ligado) await desligar();
      else await ligar();
    } catch (e) {
      avisar(e.message, 'erro');
      t.ligado = false;
      el.btn.disabled = false;
    }
  });

  el.voz.addEventListener('change', async () => {
    mostrarDescricaoVoz();
    if (t.ligado) await desligar();
    await atualizarStatus();
  });

  el.alvoHz.addEventListener('input', () => {
    el.valorAlvoHz.textContent = el.alvoHz.value + ' Hz';
  });

  function avaliarMicrofoneTimbre() {
    const op = el.microfone.selectedOptions[0];
    const perigo = op && destinosDesejados().some((d) => mesmaFamilia(op.textContent, d.nome));
    el.microfone.classList.toggle('perigo', Boolean(perigo));
  }

  el.microfone.addEventListener('change', avaliarMicrofoneTimbre);
  // Os destinos tambem entram na conta: trocar a saida, o fone ou a caixa de se
  // escutar pode criar ou desfazer o laco -- e, com o timbre ligado, muda pra
  // onde os blocos convertidos vao a partir do proximo.
  for (const id of ['saida', 'monitor', 'monitorar']) {
    const alvo = document.getElementById(id);
    if (!alvo) continue;
    alvo.addEventListener('change', () => {
      avaliarMicrofoneTimbre();
      remontarSaidas();
    });
  }

  window.api.aoErroRvc((m) => avisar('erro na troca de timbre: ' + m, 'erro'));

  navigator.mediaDevices.addEventListener('devicechange', () => {
    if (!t.ligado) listarMicrofones();
  });

  /** Chamado pelo renderer ao entrar e sair da aba. */
  window.timbre = {
    async aoEntrar() {
      await listarMicrofones();
      avaliarMicrofoneTimbre();
      await atualizarStatus();
    },
    async aoSair() {
      if (t.ligado) await desligar();
    },
  };
})();

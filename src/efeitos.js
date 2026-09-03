'use strict';

/**
 * Modo "Efeitos": uma grade de botões grandes, um por áudio da sua pasta.
 *
 * A regra é de mesa de som, não de tocador: o som existe enquanto o botão
 * estiver apertado. Soltou, calou. Por isso nada aqui usa `<audio>` --
 * `play()`/`pause()` tem partida própria e o som sairia depois do dedo, o que
 * num efeito de meio segundo é a diferença entre acertar a piada e perder.
 *
 * Cada efeito é decodificado UMA vez pra um AudioBuffer e disparado por
 * `AudioBufferSourceNode`, que começa na amostra seguinte. E os dois destinos
 * (cabo e fone) são dois AudioContext separados, cada um com seu `setSinkId`:
 * um mesmo contexto só consegue apontar pra um dispositivo por vez.
 *
 * ---------------------------------------------------------------------------
 * Organizar sem brigar com tocar
 * ---------------------------------------------------------------------------
 * Segurar o botão já quer dizer "toca". Arrastar pra reordenar começa com o
 * mesmo gesto, e as duas coisas no mesmo clique dariam efeito disparado a cada
 * tentativa de arrastar. Por isso existe o modo Organizar: enquanto ele está
 * ligado a grade não soa, e é aí que se arrasta, favorita e põe emoji.
 *
 * A ordem, os favoritos e os emojis são POR PASTA, guardados por nome de
 * arquivo. Assim trocar de pasta e voltar reencontra tudo arrumado, e um
 * arquivo novo que apareça na pasta entra no fim em vez de bagunçar o resto.
 *
 * ---------------------------------------------------------------------------
 * O corte no começo
 * ---------------------------------------------------------------------------
 * Efeito baixado da internet quase sempre vem com silêncio gravado na frente --
 * medindo os dois primeiros arquivos de teste deu 453 ms e 589 ms de nada antes
 * do som. Tocar o arquivo do início é tocar esse silêncio, e o efeito parece
 * "demorar pra sair" quando na verdade ele já está tocando.
 *
 * Então cada buffer é medido uma vez, na decodificação, e a reprodução começa
 * um pouco antes da primeira amostra audível -- não exatamente nela, senão o
 * ataque do som (a batida, o "wa") entraria cortado pela metade.
 *
 * ---------------------------------------------------------------------------
 * O corte no fim
 * ---------------------------------------------------------------------------
 * Parar seco no meio da onda estala -- a amostra cai de onde estava pra zero de
 * uma vez, e isso é um clique audível. Por isso soltar o botão faz uma rampa de
 * 15 ms até zero antes de desligar: curto demais pra dar sensação de atraso,
 * longo o bastante pra não estalar.
 * ---------------------------------------------------------------------------
 */

(() => {
  const $ = (id) => document.getElementById(id);

  /** Rampa de silenciamento ao soltar. Ver o cabeçalho. */
  const CORTE_S = 0.015;

  /**
   * O que conta como "já é som" na varredura do começo: -46 dB.
   *
   * Baixo o bastante pra pegar o comecinho de uma entrada suave, alto o
   * bastante pra ignorar chiado de fundo de gravação ruim -- que é justamente
   * o que um rip de YouTube tem no lugar do silêncio.
   */
  const LIMIAR_SILENCIO = 0.005;

  /** Quanto se volta antes da primeira amostra audível, pra não cortar o ataque. */
  const FOLGA_ATAQUE_S = 0.012;

  /**
   * Quantas pastas guardam arranjo. As mais antigas caem fora.
   *
   * Sem teto a config cresceria pra sempre com pastas visitadas uma vez só --
   * e ela é relida inteira a cada abertura do app.
   */
  const MAX_PASTAS_LEMBRADAS = 12;

  /** Sugestões da paleta. Qualquer outro emoji entra pela caixa de texto. */
  const EMOJIS = [
    '😂', '🤣', '😭', '😱', '😳', '🤨', '😐', '💀',
    '🔥', '⚡', '💥', '🎉', '🎺', '🥁', '🎸', '🔔',
    '📢', '🚨', '⏰', '👏', '👍', '👎', '🙏', '❤️',
    '💔', '⭐', '✨', '🤡', '👻', '🎃', '🐶', '🐱',
    '🐸', '🐔', '🚗', '💣', '🎯', '🏆', '❌', '✅',
    '❓', '❗', '🍕', '🧠',
  ];

  const e = {
    /** Pasta atual, do jeito que o processo principal confirmou. */
    pasta: '',
    /** [{nome, arquivo, caminho, bytes}] */
    lista: [],
    /** caminho -> AudioBuffer já decodificado. */
    buffers: new Map(),
    /** caminho -> segundo em que o áudio realmente começa. Ver o cabeçalho. */
    inicios: new Map(),
    /** 'segurar' (CUE) ou 'inteiro' (dispara e deixa correr). */
    disparo: 'segurar',
    /** Nomes de arquivo na ordem escolhida à mão. */
    ordem: [],
    /** Nomes de arquivo marcados como favoritos. */
    favoritos: new Set(),
    /** arquivo -> emoji. */
    emojis: new Map(),
    /** Arranjo das OUTRAS pastas, pra não perder ao trocar de pasta e voltar. */
    arranjos: {},
    organizando: false,
    soFavoritos: false,
    /** caminho -> Promise de decodificação em andamento (evita decodificar 2x). */
    carregando: new Map(),
    /** caminho -> [{fonte, ganho, ctx}] tocando agora. */
    tocando: new Map(),
    /** Botões com o dedo/mouse em cima, pra não disparar duas vezes. */
    apertados: new Set(),
    volume: 0.8,
    saidas: null,
    montado: false,
  };

  // `window.__efeitos` e uma janelinha de diagnostico: os testes em testes/
  // leem daqui o que esta decodificado e o que esta soando pra provar que
  // soltar o botao realmente cala o som.
  window.__efeitos = e;

  const el = {
    grade: $('grade-efeitos'),
    vazio: $('efeitos-vazio'),
    btnPasta: $('btn-pasta-efeitos'),
    btnRecarregar: $('btn-recarregar-efeitos'),
    caminho: $('caminho-efeitos'),
    contagem: $('contagem-efeitos'),
    filtro: $('filtro-efeitos'),
    linhaFiltro: $('linha-filtro-efeitos'),
    btnFavoritos: $('btn-favoritos-efeitos'),
    btnOrganizar: $('btn-organizar-efeitos'),
    disparo: $('disparo-efeitos'),
    dica: $('dica-efeitos'),
    btnParar: $('btn-parar-efeitos'),
    volume: $('volume-efeitos'),
    valorVolume: $('valor-volume-efeitos'),
    saida: $('saida'),
    monitorar: $('monitorar'),
    monitor: $('monitor'),
  };

  const avisar = (msg, tipo) => window.avisar && window.avisar(msg, tipo);
  // `salvar` mora no renderer.js, que carrega depois deste arquivo -- por isso
  // procurado na hora da chamada, e não guardado numa referência aqui em cima.
  const salvarConfig = () => window.salvar && window.salvar();

  // ============================================================= arranjo ====

  /**
   * Reconcilia a ordem guardada com o que existe hoje na pasta.
   *
   * Os dois lados mudam por fora: arquivo é apagado no Explorer, arquivo novo é
   * baixado. A ordem salva é uma PREFERÊNCIA, não uma lista de verdade -- então
   * o que ainda existe mantém o lugar, o que sumiu é esquecido, e o que é novo
   * entra no fim (em ordem alfabética entre si), nunca no meio do que você
   * arrumou.
   */
  function reconciliarOrdem() {
    const existentes = new Set(e.lista.map((i) => i.arquivo));
    const conhecidos = e.ordem.filter((a) => existentes.has(a));
    const vistos = new Set(conhecidos);
    // `e.lista` já vem alfabética do processo principal.
    const novos = e.lista.map((i) => i.arquivo).filter((a) => !vistos.has(a));
    e.ordem = [...conhecidos, ...novos];

    const posicao = new Map(e.ordem.map((a, i) => [a, i]));
    e.lista.sort((a, b) => posicao.get(a.arquivo) - posicao.get(b.arquivo));
  }

  /** Guarda o arranjo da pasta atual no bolso das outras pastas. */
  function recolherArranjo() {
    if (!e.pasta) return;
    e.arranjos[e.pasta] = {
      ordem: [...e.ordem],
      favoritos: [...e.favoritos],
      emojis: Object.fromEntries(e.emojis),
    };

    // Poda as pastas mais antigas. `Object.keys` preserva a ordem de inserção
    // pra chaves de texto, então as primeiras são mesmo as mais velhas.
    const chaves = Object.keys(e.arranjos);
    for (const velha of chaves.slice(0, Math.max(0, chaves.length - MAX_PASTAS_LEMBRADAS))) {
      delete e.arranjos[velha];
    }
  }

  /** Tira do bolso o arranjo de uma pasta (ou começa um vazio). */
  function vestirArranjo(pasta) {
    const guardado = e.arranjos[pasta] || {};
    e.ordem = Array.isArray(guardado.ordem) ? [...guardado.ordem] : [];
    e.favoritos = new Set(Array.isArray(guardado.favoritos) ? guardado.favoritos : []);
    e.emojis = new Map(Object.entries(guardado.emojis || {}));
  }

  /** Lê a ordem de volta do DOM. Usado depois de arrastar. */
  function ordemDaTela() {
    const naTela = [...el.grade.children].map((b) => b.dataset.arquivo);
    // A tela pode estar filtrada (busca, só favoritos): quem não está visível
    // conserva a posição relativa que tinha, senão filtrar e arrastar um item
    // jogaria todo o resto pro fim.
    const visiveis = new Set(naTela);
    const fila = [...naTela];
    e.ordem = e.ordem.map((a) => (visiveis.has(a) ? fila.shift() : a));
    recolherArranjo();
    salvarConfig();
  }

  // ============================================================== saídas ====

  /**
   * Monta (ou remonta) os contextos de áudio apontando pros destinos atuais.
   *
   * Refeito toda vez que se entra na aba porque o cabo e o fone podem ter
   * mudado enquanto você estava em outro modo -- e um contexto apontando pro
   * dispositivo errado toca no lugar errado sem reclamar de nada.
   */
  async function prepararSaidas() {
    const desejado = [{ dispositivo: el.saida.value, rotulo: 'saída principal' }];
    if (el.monitorar.checked && el.monitor.value) {
      desejado.push({ dispositivo: el.monitor.value, rotulo: 'monitor' });
    }

    const igual =
      e.saidas &&
      e.saidas.length === desejado.length &&
      e.saidas.every((s, i) => s.dispositivo === desejado[i].dispositivo);
    if (igual) return e.saidas;

    await soltarSaidas();

    const saidas = [];
    for (const alvo of desejado) {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      if (alvo.dispositivo && ctx.setSinkId) {
        try {
          await ctx.setSinkId(alvo.dispositivo);
        } catch (erro) {
          avisar(`não consegui usar a ${alvo.rotulo} para os efeitos: ${erro.message}`, 'erro');
        }
      }
      saidas.push({ ...alvo, ctx });
    }
    e.saidas = saidas;
    return saidas;
  }

  async function soltarSaidas() {
    if (!e.saidas) return;
    const antigas = e.saidas;
    e.saidas = null;
    // Os buffers ficam: AudioBuffer não pertence ao contexto que o decodificou,
    // então trocar de cabo não custa decodificar a pasta inteira de novo.
    for (const s of antigas) {
      try {
        await s.ctx.close();
      } catch (_) {}
    }
  }

  // ============================================================ carregar ====

  /**
   * Onde o áudio de verdade começa, em segundos. Ver "O corte no começo".
   *
   * Varre todos os canais porque um arquivo pode ter o som entrando só na
   * direita, e olhar só o canal 0 daria "silêncio" pro arquivo inteiro.
   *
   * Dois cuidados na saída: nunca antes do zero, e nunca num arquivo que é
   * silêncio do começo ao fim (aí não há o que cortar, e pular tudo faria o
   * botão não tocar nada).
   */
  function inicioReal(buffer) {
    let primeira = Infinity;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const dados = buffer.getChannelData(c);
      for (let i = 0; i < primeira && i < dados.length; i++) {
        if (Math.abs(dados[i]) > LIMIAR_SILENCIO) {
          primeira = i;
          break;
        }
      }
    }
    if (primeira === Infinity) return 0;
    return Math.max(0, primeira / buffer.sampleRate - FOLGA_ATAQUE_S);
  }

  /** Decodifica um efeito, no máximo uma vez por caminho. */
  function garantirBuffer(caminho) {
    if (e.buffers.has(caminho)) return Promise.resolve(e.buffers.get(caminho));
    if (e.carregando.has(caminho)) return e.carregando.get(caminho);

    // Ler o disco e decodificar levam tempo, e nesse tempo a pasta pode ter
    // trocado. Sem esta marca, um buffer da pasta ANTIGA chegava depois do
    // `esquecerBuffers()` e se reinstalava no mapa da pasta nova -- lixo que
    // ninguém mais ia usar, segurando memória e inflando a contagem do que
    // está pronto.
    const pastaDaVez = e.pasta;

    const promessa = (async () => {
      const r = await window.api.efeitosLer(caminho);
      if (!r.ok) throw new Error(r.erro);
      const saidas = e.saidas || (await prepararSaidas());
      // `r.audio` chega como Uint8Array; decodeAudioData consome o ArrayBuffer,
      // por isso a cópia -- sem ela, uma segunda decodificação veria vazio.
      const buffer = await saidas[0].ctx.decodeAudioData(r.audio.buffer.slice(0));
      if (e.pasta !== pastaDaVez) return buffer;
      e.buffers.set(caminho, buffer);
      e.inicios.set(caminho, inicioReal(buffer));
      return buffer;
    })();

    e.carregando.set(caminho, promessa);
    promessa.catch(() => {}).then(() => e.carregando.delete(caminho));
    return promessa;
  }

  /**
   * Decodifica a pasta inteira em segundo plano, um de cada vez.
   *
   * Sem isso o primeiro aperto de cada botão pagaria a decodificação, e o
   * primeiro uso de cada efeito -- justo o momento em que você está tentando
   * acertar o tempo -- sairia atrasado. Em série, e não tudo de uma vez, pra
   * não travar a interface numa pasta com centenas de arquivos.
   */
  async function aquecer(pastaDaVez) {
    for (const efeito of e.lista) {
      if (e.pasta !== pastaDaVez) return; // trocaram de pasta no meio
      try {
        await garantirBuffer(efeito.caminho);
        marcarPronto(efeito.caminho);
      } catch (_) {
        // Um arquivo corrompido não pode impedir os outros de aquecer; o erro
        // reaparece (e aí sim visível) se a pessoa apertar aquele botão.
      }
    }
  }

  function esquecerBuffers() {
    e.buffers.clear();
    e.inicios.clear();
  }

  function botaoDe(caminho) {
    return el.grade.querySelector(`[data-caminho="${CSS.escape(caminho)}"]`);
  }

  function marcarPronto(caminho) {
    const botao = botaoDe(caminho);
    if (botao) botao.classList.add('pronto');
  }

  // ============================================================== tocar =====

  async function tocar(caminho, botao) {
    try {
      const saidas = await prepararSaidas();
      const buffer = await garantirBuffer(caminho);
      // Segurou e soltou antes de terminar de carregar: o efeito perdeu a hora.
      // Só no CUE -- em "até o fim" o dedo já saiu de propósito, e desistir
      // aqui faria o toque rápido (que é o normal nesse modo) não tocar nada.
      if (e.disparo === 'segurar' && !e.apertados.has(caminho)) return;

      // Reaperto rápido no mesmo botão: cala o anterior antes de abrir o novo,
      // senão as duas cópias somariam e o efeito sairia com o dobro do volume.
      parar(caminho, false);

      const vozes = [];
      for (const s of saidas) {
        if (s.ctx.state === 'suspended') await s.ctx.resume();
        const ganho = s.ctx.createGain();
        ganho.gain.value = e.volume;
        ganho.connect(s.ctx.destination);
        const fonte = s.ctx.createBufferSource();
        fonte.buffer = buffer;
        fonte.connect(ganho);
        // Pula o silêncio da frente do arquivo. Ver "O corte no começo".
        fonte.start(0, e.inicios.get(caminho) || 0);
        vozes.push({ fonte, ganho, ctx: s.ctx });
      }

      // O áudio pode ser mais curto que o dedo: quando o próprio efeito acaba,
      // o botão tem que apagar sozinho, senão fica aceso mudo.
      vozes[0].fonte.onended = () => {
        if (e.tocando.get(caminho) !== vozes) return;
        e.tocando.delete(caminho);
        if (botao) botao.classList.remove('soando');
      };

      e.tocando.set(caminho, vozes);
      if (botao) botao.classList.add('soando');
    } catch (erro) {
      avisar(`efeito falhou: ${erro.message}`, 'erro');
      if (botao) botao.classList.add('quebrado');
    }
  }

  /** Silencia com rampa curta e desliga. Ver "O corte no fim" no cabeçalho. */
  function parar(caminho, limparClasse = true) {
    const vozes = e.tocando.get(caminho);
    if (!vozes) return;
    e.tocando.delete(caminho);

    for (const v of vozes) {
      v.fonte.onended = null;
      try {
        const agora = v.ctx.currentTime;
        v.ganho.gain.setValueAtTime(v.ganho.gain.value, agora);
        v.ganho.gain.linearRampToValueAtTime(0, agora + CORTE_S);
        v.fonte.stop(agora + CORTE_S);
      } catch (_) {
        // Fonte que já terminou sozinha: parar de novo lança, e não há o que fazer.
      }
    }

    if (limparClasse) {
      const botao = botaoDe(caminho);
      if (botao) botao.classList.remove('soando');
    }
  }

  function pararTudo() {
    for (const caminho of [...e.tocando.keys()]) parar(caminho);
    for (const botao of el.grade.querySelectorAll('.efeito.apertado')) {
      botao.classList.remove('apertado');
    }
    e.apertados.clear();
  }

  // ================================================================ grade ===

  function desenhar() {
    const busca = (el.filtro.value || '').trim().toLowerCase();
    const visiveis = e.lista.filter(
      (i) =>
        (!busca || i.nome.toLowerCase().includes(busca)) &&
        (!e.soFavoritos || e.favoritos.has(i.arquivo))
    );

    el.grade.innerHTML = '';
    for (const efeito of visiveis) {
      el.grade.appendChild(montarBotao(efeito));
    }

    const temPasta = Boolean(e.pasta);
    el.vazio.classList.toggle('oculto', visiveis.length > 0);
    el.grade.classList.toggle('oculto', visiveis.length === 0);
    el.grade.classList.toggle('organizando', e.organizando);
    el.filtro.classList.toggle('oculto', e.lista.length < 8);
    // A linha some inteira quando não há nem o que buscar nem o que favoritar.
    el.linhaFiltro.classList.toggle('oculto', e.lista.length < 8 && e.favoritos.size === 0);
    el.btnOrganizar.disabled = e.lista.length === 0;

    if (!temPasta) {
      el.vazio.textContent = 'Escolha a pasta onde estão seus efeitos sonoros.';
    } else if (e.lista.length === 0) {
      el.vazio.textContent = 'Nenhum áudio nessa pasta. Aceito: mp3, wav, ogg, opus, m4a, aac, flac.';
    } else if (e.soFavoritos && !busca) {
      el.vazio.textContent = 'Nenhum favorito ainda. Ligue Organizar e clique na estrela dos que você mais usa.';
    } else if (visiveis.length === 0) {
      el.vazio.textContent = 'Nenhum efeito com esse nome.';
    }

    el.contagem.textContent = temPasta
      ? `${e.lista.length} efeito${e.lista.length === 1 ? '' : 's'}`
      : '';
    el.caminho.textContent = e.pasta || 'nenhuma pasta escolhida';
    el.caminho.title = e.pasta;
    el.btnRecarregar.disabled = !temPasta;
  }

  function montarBotao(efeito) {
    const botao = document.createElement('button');
    botao.type = 'button';
    botao.className = 'efeito';
    if (e.buffers.has(efeito.caminho)) botao.classList.add('pronto');
    if (e.favoritos.has(efeito.arquivo)) botao.classList.add('favorito');
    botao.dataset.caminho = efeito.caminho;
    botao.dataset.arquivo = efeito.arquivo;
    botao.title = efeito.arquivo;
    // Só arrasta no modo organizar; fora dele o mesmo gesto é "tocar".
    botao.draggable = e.organizando;

    const estrela = document.createElement('span');
    estrela.className = 'efeito-estrela';
    estrela.textContent = '★';
    estrela.title = 'Favorito';
    botao.appendChild(estrela);

    const trocar = document.createElement('span');
    trocar.className = 'efeito-trocar-emoji';
    trocar.textContent = e.emojis.get(efeito.arquivo) ? 'emoji' : '+ emoji';
    botao.appendChild(trocar);

    const emoji = e.emojis.get(efeito.arquivo);
    if (emoji) {
      const span = document.createElement('span');
      span.className = 'efeito-emoji';
      span.textContent = emoji;
      botao.appendChild(span);
    }

    const nome = document.createElement('span');
    nome.className = 'efeito-nome';
    nome.textContent = efeito.nome;
    botao.appendChild(nome);
    return botao;
  }

  /** Aplica um resultado de `efeitos:listar` / `efeitos:escolherPasta`. */
  function aplicar(r) {
    if (!r || r.cancelado) return false;
    if (!r.ok) {
      avisar(r.erro, 'erro');
      desenhar();
      return false;
    }
    pararTudo();
    if (r.pasta !== e.pasta) {
      // Buffers da pasta antiga não servem mais e segurariam memória à toa.
      esquecerBuffers();
      recolherArranjo();
      vestirArranjo(r.pasta);
    }
    e.pasta = r.pasta;
    e.lista = r.efeitos;
    reconciliarOrdem();
    recolherArranjo();
    desenhar();
    salvarConfig();
    aquecer(e.pasta);
    return true;
  }

  // ========================================================== organizar =====

  function definirOrganizando(ligado) {
    e.organizando = Boolean(ligado);
    // Entrar em organizar cala tudo: um som de 15 s correndo enquanto se
    // arrasta a grade é ruído puro, e a grade nem responde a toque nesse modo.
    if (e.organizando) pararTudo();
    else fecharPaleta();
    el.btnOrganizar.setAttribute('aria-pressed', String(e.organizando));
    el.btnOrganizar.textContent = e.organizando ? 'Pronto' : 'Organizar';
    el.dica.textContent = e.organizando
      ? 'Arraste pra trocar de lugar. ★ favorita, + emoji marca.'
      : e.disparo === 'inteiro'
        ? 'Um toque dispara; aperte de novo pra cortar.'
        : 'Segure o botão: o som toca enquanto estiver apertado.';
    desenhar();
  }

  function alternarFavorito(arquivo) {
    if (e.favoritos.has(arquivo)) e.favoritos.delete(arquivo);
    else e.favoritos.add(arquivo);
    const botao = el.grade.querySelector(`[data-arquivo="${CSS.escape(arquivo)}"]`);
    if (botao) botao.classList.toggle('favorito', e.favoritos.has(arquivo));
    // A linha do filtro aparece assim que existe o primeiro favorito.
    el.linhaFiltro.classList.toggle('oculto', e.lista.length < 8 && e.favoritos.size === 0);
    recolherArranjo();
    salvarConfig();
  }

  function definirEmoji(arquivo, emoji) {
    // Um "emoji" só é útil como marca se for curto: colar uma frase aqui
    // encheria o botão e empurraria o nome pra fora.
    const marca = [...String(emoji || '').trim()].slice(0, 2).join('');
    if (marca) e.emojis.set(arquivo, marca);
    else e.emojis.delete(arquivo);
    recolherArranjo();
    salvarConfig();
    desenhar();
  }

  // ------------------------------------------------------- paleta de emoji

  const paleta = document.createElement('div');
  paleta.className = 'paleta oculto';
  paleta.innerHTML = '<div class="paleta-grade"></div>';
  const paletaGrade = paleta.querySelector('.paleta-grade');
  for (const emoji of EMOJIS) {
    const botao = document.createElement('button');
    botao.type = 'button';
    botao.textContent = emoji;
    botao.dataset.emoji = emoji;
    paletaGrade.appendChild(botao);
  }
  const rodape = document.createElement('div');
  rodape.className = 'paleta-rodape';
  const campo = document.createElement('input');
  campo.type = 'text';
  campo.maxLength = 8;
  campo.placeholder = 'ou cole aqui (Win + .)';
  const btnTirar = document.createElement('button');
  btnTirar.type = 'button';
  btnTirar.className = 'botao pequeno';
  btnTirar.textContent = 'Tirar';
  rodape.append(campo, btnTirar);
  paleta.appendChild(rodape);
  document.body.appendChild(paleta);

  /** Arquivo cujo emoji a paleta está editando agora. */
  let paletaAlvo = null;

  function abrirPaleta(arquivo, ancora) {
    paletaAlvo = arquivo;
    campo.value = e.emojis.get(arquivo) || '';
    paleta.classList.remove('oculto');

    // Posiciona colada no botão, mas presa dentro da janela: um botão na
    // beirada direita jogaria a paleta pra fora da tela.
    const r = ancora.getBoundingClientRect();
    const largura = paleta.offsetWidth;
    const altura = paleta.offsetHeight;
    paleta.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - largura - 8))}px`;
    paleta.style.top =
      r.bottom + altura + 8 < window.innerHeight
        ? `${r.bottom + 6}px`
        : `${Math.max(8, r.top - altura - 6)}px`;
    campo.focus();
    campo.select();
  }

  function fecharPaleta() {
    paletaAlvo = null;
    paleta.classList.add('oculto');
  }

  paletaGrade.addEventListener('click', (evento) => {
    const botao = evento.target.closest('button');
    if (!botao || !paletaAlvo) return;
    definirEmoji(paletaAlvo, botao.dataset.emoji);
    fecharPaleta();
  });
  btnTirar.addEventListener('click', () => {
    if (paletaAlvo) definirEmoji(paletaAlvo, '');
    fecharPaleta();
  });
  campo.addEventListener('keydown', (evento) => {
    if (evento.key === 'Enter' && paletaAlvo) {
      definirEmoji(paletaAlvo, campo.value);
      fecharPaleta();
    } else if (evento.key === 'Escape') {
      fecharPaleta();
    }
  });
  document.addEventListener('pointerdown', (evento) => {
    if (paletaAlvo && !paleta.contains(evento.target) && !evento.target.closest('.efeito-trocar-emoji')) {
      fecharPaleta();
    }
  });

  // ============================================================= ligações ===

  el.btnPasta.addEventListener('click', async () => {
    el.btnPasta.disabled = true;
    try {
      aplicar(await window.api.efeitosEscolherPasta());
    } finally {
      el.btnPasta.disabled = false;
    }
  });

  async function usarPasta(pasta) {
    return aplicar(await window.api.efeitosListar(pasta));
  }

  el.btnRecarregar.addEventListener('click', async () => {
    esquecerBuffers();
    await usarPasta(e.pasta);
  });

  el.filtro.addEventListener('input', desenhar);

  el.disparo.addEventListener('click', (evento) => {
    const botao = evento.target.closest('.escolha-opcao');
    if (!botao || botao.dataset.disparo === e.disparo) return;
    definirDisparo(botao.dataset.disparo);
    salvarConfig();
  });

  el.btnParar.addEventListener('click', pararTudo);

  el.btnOrganizar.addEventListener('click', () => definirOrganizando(!e.organizando));

  el.btnFavoritos.addEventListener('click', () => {
    e.soFavoritos = !e.soFavoritos;
    el.btnFavoritos.setAttribute('aria-pressed', String(e.soFavoritos));
    desenhar();
  });

  // Botão direito favorita sem precisar entrar no organizar -- é o atalho pra
  // quando você percebe no meio da conversa que usa aquele o tempo todo.
  el.grade.addEventListener('contextmenu', (evento) => {
    const botao = evento.target.closest('.efeito');
    if (!botao) return;
    evento.preventDefault();
    alternarFavorito(botao.dataset.arquivo);
  });

  // -------------------------------------------------------------- arrastar

  let arrastado = null;

  el.grade.addEventListener('dragstart', (evento) => {
    const botao = evento.target.closest('.efeito');
    if (!botao || !e.organizando) return evento.preventDefault();
    arrastado = botao;
    botao.classList.add('arrastando');
    evento.dataTransfer.effectAllowed = 'move';
    // O Chromium cancela o arrasto se nada for escrito no dataTransfer.
    evento.dataTransfer.setData('text/plain', botao.dataset.arquivo);
  });

  el.grade.addEventListener('dragover', (evento) => {
    if (!arrastado) return;
    evento.preventDefault();
    const alvo = evento.target.closest('.efeito');
    if (!alvo || alvo === arrastado) return;

    // Antes ou depois do alvo conforme o lado em que o ponteiro está: sem essa
    // conta o item empurrado ficaria sempre à esquerda e nunca daria pra soltar
    // no fim da fila.
    const r = alvo.getBoundingClientRect();
    const depois = evento.clientX > r.left + r.width / 2;
    alvo.parentNode.insertBefore(arrastado, depois ? alvo.nextSibling : alvo);
  });

  el.grade.addEventListener('drop', (evento) => evento.preventDefault());

  el.grade.addEventListener('dragend', () => {
    if (!arrastado) return;
    arrastado.classList.remove('arrastando');
    arrastado = null;
    ordemDaTela();
  });

  // Mesmo remanejo pelo teclado: Ctrl+setas movem o botão em foco. É o caminho
  // de quem não usa mouse, e também o conserto quando o arrasto escorrega.
  el.grade.addEventListener('keydown', (evento) => {
    if (!e.organizando || !evento.ctrlKey) return;
    const passo = evento.key === 'ArrowRight' ? 1 : evento.key === 'ArrowLeft' ? -1 : 0;
    if (!passo) return;
    const botao = evento.target.closest('.efeito');
    if (!botao) return;
    evento.preventDefault();
    const irmaos = [...el.grade.children];
    const destino = irmaos.indexOf(botao) + passo;
    if (destino < 0 || destino >= irmaos.length) return;
    el.grade.insertBefore(botao, passo > 0 ? irmaos[destino].nextSibling : irmaos[destino]);
    botao.focus();
    ordemDaTela();
  });

  // Escape cala tudo em qualquer modo: é a saída de emergência quando o efeito
  // errado foi disparado no meio de uma conversa.
  window.addEventListener('keydown', (evento) => {
    if (evento.key === 'Escape' && e.tocando.size) pararTudo();
  });

  el.volume.addEventListener('input', () => {
    e.volume = Number(el.volume.value) / 100;
    el.valorVolume.textContent = `${el.volume.value}%`;
    // Quem já está tocando acompanha na hora: mexer no volume durante o efeito
    // é justamente quando se quer ouvir a mudança.
    for (const vozes of e.tocando.values()) {
      for (const v of vozes) v.ganho.gain.setTargetAtTime(e.volume, v.ctx.currentTime, 0.01);
    }
    salvarConfig();
  });

  // Ponteiro: `pointerdown` no botão, e o `pointerup` capturado nele mesmo.
  // `setPointerCapture` é o que garante que soltar o mouse FORA do botão ainda
  // cala o som -- sem isso, arrastar pra fora deixaria o efeito preso tocando.
  el.grade.addEventListener('pointerdown', (evento) => {
    const botao = evento.target.closest('.efeito');
    if (!botao || evento.button !== 0) return;

    if (e.organizando) {
      // No organizar o clique não toca: ele favorita, abre a paleta, ou é o
      // começo de um arrasto (que o navegador cuida sozinho a partir daqui).
      if (evento.target.closest('.efeito-estrela')) alternarFavorito(botao.dataset.arquivo);
      else if (evento.target.closest('.efeito-trocar-emoji')) {
        abrirPaleta(botao.dataset.arquivo, botao);
      }
      return;
    }

    // `preventDefault` só depois de decidir que é pra tocar: no organizar ele
    // mataria o arrasto antes de o Chromium começar.
    evento.preventDefault();
    try {
      botao.setPointerCapture(evento.pointerId);
    } catch (_) {}
    apertar(botao);
  });

  const soltar = (evento) => {
    const botao = evento.target.closest('.efeito');
    if (botao) largar(botao);
  };
  el.grade.addEventListener('pointerup', soltar);
  el.grade.addEventListener('pointercancel', soltar);

  // Teclado: mesma regra do mouse -- soa enquanto a tecla estiver afundada.
  // `evento.repeat` é descartado porque segurar a tecla dispara repetições, e
  // cada uma reiniciaria o efeito do zero.
  el.grade.addEventListener('keydown', (evento) => {
    if (evento.key !== ' ' && evento.key !== 'Enter') return;
    const botao = evento.target.closest('.efeito');
    if (!botao || evento.repeat || e.organizando) return;
    evento.preventDefault();
    apertar(botao);
  });

  el.grade.addEventListener('keyup', (evento) => {
    if (evento.key === ' ' || evento.key === 'Enter') soltar(evento);
  });

  function apertar(botao) {
    const caminho = botao.dataset.caminho;
    if (e.apertados.has(caminho)) return;

    // Em "até o fim", apertar o que já está soando é o jeito de calar: sem
    // isso um efeito de 15 s ficaria preso até o fim sem escapatória.
    if (e.disparo === 'inteiro' && e.tocando.has(caminho)) {
      parar(caminho);
      return;
    }

    e.apertados.add(caminho);
    botao.classList.add('apertado');
    tocar(caminho, botao);
  }

  function largar(botao) {
    const caminho = botao.dataset.caminho;
    if (!e.apertados.delete(caminho)) return;
    botao.classList.remove('apertado');
    // Soltar só cala no CUE. Em "até o fim" o som segue, e quem apaga o botão
    // é o `onended` da própria fonte quando o áudio acabar.
    if (e.disparo === 'segurar') parar(caminho);
  }

  /**
   * Troca entre CUE e "até o fim".
   *
   * Cala tudo na troca: os dois modos combinam coisas diferentes com o mesmo
   * gesto, e deixar um som de 15 s correndo enquanto se volta pro CUE daria a
   * impressão de que o botão travou.
   */
  function definirDisparo(qual) {
    e.disparo = qual === 'inteiro' ? 'inteiro' : 'segurar';
    pararTudo();
    for (const botao of el.disparo.querySelectorAll('.escolha-opcao')) {
      botao.classList.toggle('ativa', botao.dataset.disparo === e.disparo);
    }
    el.btnParar.classList.toggle('oculto', e.disparo !== 'inteiro');
    // Organizando, a dica é a do organizar: trocar o disparo enquanto se
    // arruma a grade não pode reescrever a instrução que está valendo.
    if (!e.organizando) {
      el.dica.textContent =
        e.disparo === 'inteiro'
          ? 'Um toque dispara; aperte de novo pra cortar.'
          : 'Segure o botão: o som toca enquanto estiver apertado.';
    }
  }

  // Trocar o cabo (ou ligar o fone) com a aba aberta precisa remontar os
  // contextos na hora: eles já apontam pro dispositivo antigo, e sem isso o
  // próximo efeito sairia no lugar errado sem nenhum aviso.
  const remontar = () => {
    if (e.saidas) prepararSaidas();
  };
  el.saida.addEventListener('change', remontar);
  el.monitor.addEventListener('change', remontar);
  el.monitorar.addEventListener('change', remontar);

  // Perder o foco da janela com o dedo no botão deixaria o som preso: o
  // `pointerup` acontece fora e nunca chega aqui.
  window.addEventListener('blur', pararTudo);

  /** Chamado pelo renderer ao entrar e sair da aba. */
  window.efeitos = {
    async aoEntrar() {
      await prepararSaidas();
      if (!e.montado && e.pasta) {
        e.montado = true;
        await usarPasta(e.pasta);
      } else {
        desenhar();
      }
    },
    /**
     * Sair da aba NÃO cala os efeitos nem solta as saídas.
     *
     * A primeira versão fechava os dois AudioContext aqui, com medo de que
     * segurassem o cabo. Não seguram -- o Windows mistura vários fluxos no
     * mesmo dispositivo, que é justamente o que faz a voz e o efeito saírem
     * juntos pelo cabo. E fechar tinha um custo real: um efeito disparado em
     * "até o fim" morria no meio quando você voltava pra aba Ao vivo.
     *
     * O que sai é só o estado de edição, que não faz sentido fora da aba.
     */
    async aoSair() {
      if (e.organizando) definirOrganizando(false);
      fecharPaleta();
    },
    /** Restaura o que estava salvo na config, antes da primeira entrada. */
    restaurar({ pasta, volume, disparo, arranjos }) {
      if (arranjos && typeof arranjos === 'object') e.arranjos = { ...arranjos };
      if (pasta) {
        e.pasta = pasta;
        vestirArranjo(pasta);
      }
      if (typeof volume === 'number') {
        el.volume.value = volume;
        e.volume = volume / 100;
        el.valorVolume.textContent = `${volume}%`;
      }
      definirDisparo(disparo); // já redesenha
    },
    usarPasta,
    estado: () => ({
      pasta: e.pasta,
      volume: Number(el.volume.value),
      disparo: e.disparo,
      arranjos: e.arranjos,
    }),
  };

  desenhar();
})();

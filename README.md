# Voz TTS

App de desktop (Electron) que transforma texto em fala e **toca a voz num
dispositivo de áudio que você escolhe** — inclusive um cabo virtual, que é o
jeito de outros programas ouvirem essa voz como se fosse seu microfone.

Tudo que ele usa é gratuito e sem cadastro.

---

## O detalhe que muda tudo: áudio não sai por microfone

Microfone é **entrada**. Não existe "tocar um som no microfone" — nem neste app,
nem em nenhum outro. O que existe é um **cabo de áudio virtual**: um par de
dispositivos falsos que o Windows enxerga, ligados um no outro.

```
Voz TTS  ──toca em──>  CABLE Input  ═══>  CABLE Output  ──escutado por──>  Discord
         (saída)          (saída)         (entrada/"microfone")            OBS, jogo…
```

Você escolhe **CABLE Input** como saída aqui no app, e **CABLE Output** como
microfone no Discord/OBS/jogo. É assim que todo mundo faz isso, e é por isso que
o app tem um seletor de saída em vez de um seletor de microfone.

### Instalando o cabo

O VB-CABLE já está baixado em `C:\Users\gualm\Downloads\VBCABLE_Driver_Pack45`.

1. Clique com o botão direito em **`VBCABLE_Setup_x64.exe`** → **Executar como
   administrador**.
2. Clique em **Install Driver** e aceite o aviso do Windows.
3. **Reinicie o computador.** (Esse passo não é opcional — o driver só aparece
   depois.)

Instalação de driver precisa de elevação e mexe no subsistema de áudio do
Windows, então é você quem roda — o app não faz isso por você.

Depois de reiniciar, abra o app: o aviso amarelo some sozinho e a saída já vem
apontada pro cabo.

---

## Abrindo

**Do jeito normal:** dois cliques no atalho **Voz TTS** na Área de Trabalho (ou
procure "Voz TTS" no menu Iniciar). O app empacotado mora em
`C:\Users\gualm\Apps\Voz TTS` — fora do OneDrive de propósito, porque são 269 MB
que não precisam sincronizar.

**Pra desenvolver** (recarrega o código que você acabou de editar):

```bash
npm start
```

`npm run dev` abre igual, mas com o DevTools junto.

### Regerando o app depois de mexer no código

```bash
npm run build
```

Isso escreve `dist/win-unpacked`. Copie por cima de `C:\Users\gualm\Apps\Voz TTS`
que o atalho continua valendo.

> **Sobre o instalador `.exe`:** o `npm run build` **não** consegue gerar o
> instalador NSIS nesta máquina. O electron-builder baixa um pacote de
> assinatura de código que contém symlinks de macOS, e o Windows recusa criar
> symlink sem privilégio — o build termina com código 0 mas só entrega a pasta
> `win-unpacked`. Não é problema do app.
>
> Se um dia quiser o instalador de verdade, ligue o **Modo de Desenvolvedor** do
> Windows (Configurações → Sistema → Para desenvolvedores), que libera symlink
> sem admin, e rode o build de novo. Pra uso pessoal, o atalho resolve igual.

---

## Os dois motores de voz

| | **Edge (online)** | **Piper (offline)** |
|---|---|---|
| Qualidade | Muito natural (neural da Microsoft) | Boa, um pouco robótica |
| Internet | Precisa | Não precisa |
| Latência medida | 1,7 – 3,5 s por frase | **0,6 s por frase** |
| Vozes pt-BR | Francisca, Antonio, Thalita | Faber |
| Custo | Grátis | Grátis |

O **Edge** é o padrão, porque a voz é claramente melhor. O **Piper** é a rede de
segurança: roda dentro da sua máquina, não depende de servidor nenhum, e é
**cinco vezes mais rápido** — o que vai importar bastante na fase 2.

O Piper e a voz Faber **já estão instalados** em
`%APPDATA%\voz-tts\motores`. Pra baixar outras vozes, use o botão dentro do app.

---

## Quando o motor Edge parar de funcionar

Um dia ele vai dar erro 403. Não é bug do app: o Edge TTS é um endpoint não
documentado da Microsoft, e ela recusa o acesso quando a versão de navegador que
o app declara fica velha. Já aconteceu uma vez durante a construção.

**Conserto:** abra `electron/tts/edge.js` e atualize duas linhas:

```js
const VERSAO_CHROMIUM = '143.0.3650.75';
const VERSAO_MAIOR = '143';
```

Pegue a versão atual em `edge://version` no seu Edge, ou copie de
[constants.py do edge-tts](https://github.com/rany2/edge-tts/blob/master/src/edge_tts/constants.py).
O app já mostra essa instrução na própria mensagem de erro.

Se cansar do gato e rato, use o Piper — offline não quebra.

---

## Como está organizado

```
electron/
  main.js         janela, atalho global, IPC, onde ficam os modelos
  preload.js      a ponte estreita entre a interface e o Node
  tts/
    index.js      registro de motores (é aqui que se pluga um motor novo)
    edge.js       cliente do Edge TTS, com o token Sec-MS-GEC
    piper.js      motor offline: baixa, descompacta e sintetiza
  efeitos.js      lê a pasta de efeitos e entrega os bytes de cada áudio
src/
  index.html      a tela
  renderer.js     a lógica da interface e o roteamento de áudio (setSinkId)
  efeitos.js      a grade de efeitos: segura o botão, sai o som
  styles.css
testes/           arranjos que sobem o app de verdade e conferem o que aparece
```

A parte que faz a mágica são ~15 linhas em `renderer.js`, na função `tocar()`:
o áudio vira um `Blob`, o `Blob` vira um `<audio>`, e o `setSinkId` manda esse
`<audio>` pro dispositivo escolhido. Dois elementos de áudio em paralelo é o que
te deixa ouvir no fone *e* mandar pro cabo ao mesmo tempo.

---

## Recursos

- **Ctrl+Enter** fala o que está na caixa.
- **Ctrl+Shift+Espaço** é atalho global — funciona com o app atrás do jogo.
- Aba **Efeitos**: seus próprios áudios em botões grandes, tocando enquanto
  você segura.
- Marque *"Ouvir também no meu fone"* pra se monitorar sem tirar a voz do cabo.
- Velocidade, tom e volume ajustáveis; o app lembra tudo entre sessões.
- Frases recentes ficam guardadas — um clique repete.

---

## Os quatro modos

| aba | você faz | sai |
|---|---|---|
| **Digitar** | escreve | a voz do TTS lendo o texto |
| **Ao vivo** | fala | a voz do TTS relendo o que você disse |
| **Trocar timbre** | fala | outra pessoa, com a SUA entonação |
| **Efeitos** | segura um botão | o áudio daquele botão, enquanto estiver apertado |

Os dois primeiros passam por texto (e por isso perdem a entonação e erram
palavra às vezes). O terceiro não — ver a seção no fim.

---

## Efeitos sonoros

A quarta aba é uma mesa de som: **um botão grande por arquivo de áudio da sua
pasta, e o som toca só enquanto o botão está apertado**. Soltou, calou — como um
CUE. Serve pra soltar uma risada, um tambor ou um efeito no meio da conversa sem
ter que parar, achar o arquivo e tocar inteiro.

- **Como o botão dispara**: em *Segurar* (o CUE) o som existe só enquanto o
  botão está apertado. Em *Até o fim* um toque dispara e o áudio corre sozinho —
  apertar de novo corta, e há um **Parar tudo**. `Esc` cala tudo nos dois modos.
- **Organizar** liga o modo de arrumação: arraste os botões pra trocar de lugar
  (ou `Ctrl`+setas), clique na ★ pra favoritar e em *+ emoji* pra marcar o botão
  com um emoji — os da paleta ou qualquer outro (`Win` + `.` abre o do Windows).
  Enquanto está organizando a grade não toca, senão cada tentativa de arrastar
  dispararia o efeito. Botão direito favorita sem entrar no modo.
- **★ só favoritos** filtra a grade. Ordem, favoritos e emojis são **por pasta**,
  guardados por nome de arquivo: trocar de pasta e voltar reencontra tudo
  arrumado, e um arquivo novo entra no fim em vez de bagunçar o meio.
- **Escolher pasta…** aponta pra qualquer pasta sua. Trocar a pasta troca o
  conjunto inteiro de efeitos. O app não copia nem converte nada, e lembra a
  pasta entre sessões.
- Aceita `mp3`, `wav`, `ogg`, `opus`, `m4a`, `aac`, `flac` e `webm`. Subpastas
  são ignoradas de propósito: a grade é chapada pra você mirar, não navegar.
- O nome do botão vem do nome do arquivo (`risada-do-chaves.mp3` vira *risada do
  chaves*). A bolinha verde no canto quer dizer que aquele efeito já está
  decodificado na memória e dispara na hora.
- Sai pela mesma **Saída principal** da voz — quem te ouve pelo cabo ouve os
  efeitos também — e pelo fone, se *"Ouvir também no meu fone"* estiver marcado.
- **Funciona junto com o Ao vivo**: ligue o microfone na aba *Ao vivo*, vá pra
  *Efeitos* e solte o que quiser no meio da fala. Os dois saem pelo mesmo cabo.
- **Volume dos efeitos** é separado do volume da voz.
- Também funciona pelo teclado: `Tab` até o botão, `Espaço` ou `Enter` segurado.
- A partir de 8 efeitos aparece uma caixa de busca pra filtrar por nome.

Nada de `<audio>` aqui: cada efeito é decodificado uma vez e disparado por
`AudioBufferSourceNode`, que começa na amostra seguinte ao aperto. Soltar faz
uma rampa de 15 ms até o silêncio — cortar seco no meio da onda estala.

### O silêncio que parecia atraso

Efeito baixado da internet quase sempre traz silêncio gravado na frente.
Medindo dois rips de YouTube de verdade:

| suspeito | medido |
|---|---|
| caminho JS do aperto até `start()` | 0,2 ms |
| latência do AudioContext (WASAPI + cabo) | ~50 ms |
| **silêncio no começo do arquivo** | **453 ms e 589 ms** |

Ou seja: o app tocava na hora, e tocava o silêncio junto. Por isso cada buffer é
medido uma vez na decodificação e a reprodução começa 12 ms antes da primeira
amostra audível — 12 ms de folga porque começar exatamente nela cortaria o
ataque do som pela metade. Os ~50 ms restantes são o piso do áudio do Windows,
não dá pra tirar daqui.

```bash
npx electron testes/efeitos-atraso.js ["pasta"]   # mede de onde vem o atraso
```

### Só quem captura o microfone é exclusivo

As abas não são todas mutuamente exclusivas. **Ao vivo** e **Trocar timbre**
disputam a mesma entrada de áudio e não podem correr juntas — duas capturas do
mesmo microfone dariam áudio picotado nas duas. **Digitar** e **Efeitos** não
capturam nada.

A primeira versão desligava o microfone ao *sair* do Ao vivo, seja pra onde
fosse: ir buscar um efeito matava a fala. A regra olhava de onde você saiu em vez
de pra onde você foi. Hoje quem manda é o destino (`captura` na tabela `MODOS`
do renderer), e por isso dá pra falar ao vivo e soltar efeito ao mesmo tempo.

Pelo mesmo motivo sair da aba Efeitos **não** fecha mais os `AudioContext`: o
Windows mistura vários fluxos no mesmo dispositivo (é o que faz voz e efeito
saírem juntos pelo cabo), e fechá-los matava no meio um efeito disparado em
*Até o fim*.

O processo principal só entrega arquivos que estejam **dentro da pasta
escolhida**, e a checagem é por caminho resolvido: `../../.ssh/id_rsa` não passa.

---

## Testes

```bash
npx electron testes/tela.js       # sobe a tela, confere estado e tira foto
npx electron testes/roteamento.js # dirige o app e prova que o áudio percorreu tudo
npx electron testes/efeitos.js    # CUE, até o fim, corte do silêncio, ordem, ★ e emoji
npx electron testes/efeitos-com-vivo.js # prova que efeito e ao vivo rodam juntos
```

Eles usam os módulos de verdade, não imitações.

---

## Trocar timbre (RVC)

A terceira aba. Você fala, **sai a voz de outra pessoa** dizendo exatamente o que
você disse, do jeito que você disse — suas palavras, seu ritmo, suas pausas, sua
emoção. Só o timbre muda.

Não confundir com o modo **Ao vivo**: lá o app *reconhece* o que você diz e um
robô relê. Aqui não existe texto em lugar nenhum — o áudio entra e sai
transformado.

### Como usar

1. Aba **Trocar timbre**
2. Escolha seu microfone (o de verdade; o app recusa o cabo virtual, que faria
   ele ouvir a si mesmo)
3. Em **Saída principal**, escolha **CABLE Input**
4. **Trocar minha voz**

No Discord/OBS, **CABLE Output** como microfone.

### Ajustes

**Voz alvo** — o timbre é do modelo, não de um controle. Trocar recarrega só o
gerador (~2s); as duas redes pesadas continuam de pé.

**Quão aguda** — o app mede a altura da sua voz e transpõe até este alvo,
sozinho. Isto não é enfeite: cada modelo foi treinado numa faixa, e entregar uma
melodia masculina (~120 Hz) a um modelo feminino (~220 Hz) faz a voz sair
**rouca**. Com o alvo certo, sai natural.

### Desempenho medido

Bloco de 0,75s, RTX 4050 via DirectML:

| | |
|---|---|
| por bloco | ~360 ms de 750 ms — **0,48x** |
| atraso total | ~1,6 s |
| primeira carga | ~5 s (uma vez por sessão) |

### Três coisas que decidem se cabe ou não cabe

**A placa certa.** O DirectML usa o "dispositivo 0" por padrão, que em notebook é
a integrada. Aqui: Intel 627 ms contra RTX 82 ms — **7,6x**. O app mede os
dispositivos e escolhe o mais rápido, uma vez, guardando em
`motores/gpu-escolhida.json`. A sondagem roda num **processo separado**: feita no
mesmo processo, ela deixava a placa num estado em que a conversão seguinte levava
53 segundos.

**Tudo na GPU, não só o gerador.** Deixar o extrator de conteúdo e o detector de
melodia na CPU parecia econômico e era o contrário: eles ficavam presos atrás da
espera ativa que o DirectML mantém. 498 ms → 67 ms.

**Aquecer antes de abrir o microfone.** As duas primeiras conversões custam o
dobro. Com o microfone já aberto, esse atraso entra na agenda de reprodução e
**nunca sai** — o atraso do primeiro segundo virava o da sessão inteira.

**Portão de silêncio.** O gerador é um vocoder: alimentado com silêncio ele não
devolve silêncio, ele **inventa voz**. Sem portão, o modo ficava murmurando
sozinho com a pessoa calada. Cada bloco é medido em quadros de 50 ms antes de
converter — bloco todo calado não vai pra GPU, e no bloco misto só o trecho
falado sai. A folga de 200 ms de cada lado garante que nenhuma palavra seja
comida: só silêncio de mais de 400 ms seguidos chega a ser cortado.

**Duas saídas, dois contextos.** Um `AudioContext` toca num dispositivo por vez,
então "Ouvir também no meu fone" exige um contexto por destino — cada um com sua
própria agenda, porque cada um tem seu próprio relógio.

### Testes

```bash
npx electron testes/timbre.js           # a aba sobe, acha os modelos, alterna
npx electron testes/timbre-vivo.js      # conversão ao vivo ponta a ponta
npx electron testes/timbre-vivo-tom.js  # idem, com tom sintético (mede melhor)
npx electron testes/timbre-monitor.js   # cabo e fone recebendo a mesma voz
node testes/portao-silencio.js          # o portão corta o silêncio e só ele
```

Os três com `electron` injetam áudio no lugar do microfone: percorrem worklet,
IPC, conversor, streaming e agendador de verdade, sem ninguém precisar falar. O
do portão roda em Node puro, com um conversor de mentira que sempre devolve som
alto — assim todo trecho que sai baixo saiu baixo porque o portão fechou.

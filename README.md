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
src/
  index.html      a tela
  renderer.js     a lógica da interface e o roteamento de áudio (setSinkId)
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
- Marque *"Ouvir também no meu fone"* pra se monitorar sem tirar a voz do cabo.
- Velocidade, tom e volume ajustáveis; o app lembra tudo entre sessões.
- Frases recentes ficam guardadas — um clique repete.

---

## Fase 2: falar com a sua voz (conversão em tempo real)

Ainda não construído. Anotações do que a fase 1 já deixou pronto:

- O `tts/index.js` é um registro: um motor novo entra sem mexer na interface.
- O Piper aceita `--output-raw` e cospe PCM contínuo, sem passar por arquivo —
  é o caminho pra streaming de verdade.
- O caminho de saída (`setSinkId` + cabo virtual) **é o mesmo** pra conversão de
  voz. Essa metade do problema já está resolvida e testada.
- Pro tempo real de fato, o alvo é conversão de voz (RVC / seed-vc) em vez de
  TTS: você fala, o modelo troca o timbre e devolve. A latência aceitável fica
  em ~100–300 ms, o que exige GPU e processamento em blocos — não dá pra
  reaproveitar a chamada de rede do Edge, que sozinha já gasta segundos.

## Testes

```bash
npx electron testes/tela.js       # sobe a tela, confere estado e tira foto
npx electron testes/roteamento.js # dirige o app e prova que o áudio percorreu tudo
```

Eles usam os módulos de verdade, não imitações.

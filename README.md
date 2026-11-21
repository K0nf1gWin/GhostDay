```
   ▄▄▄▄▄▄▄
  █ ▄▄▄▄▄ █     G H O S T D A Y
  █ █>_█ █      navegador de privacidade
  █▄▀▄▀▄▀▄█     desktop · android
```

Dois apps nativos, um shield em comum. Sem telemetria, sem nuvem, sem nada que
voce nao possa ler.

| | |
|---|---|
| **Desktop** | Electron (engine Chromium) → `.exe` e `.msi` |
| **Android** | Kotlin + WebView → `.apk` |
| **Comum** | `shared/shield.js` — mesmas defesas de fingerprint nos dois |

---

## Build

### No GitHub Actions (recomendado)

Todo push na `main` dispara `.github/workflows/build.yml`, que monta os tres
instaladores e publica numa release rolante chamada **latest**:

| arquivo | o que e |
|---|---|
| `GhostDay-debug.apk` | Android, assinado com a chave de debug |
| `GhostDay-0.1.0-x64.exe` | instalador NSIS do Windows |
| `GhostDay-0.1.0-x64.msi` | instalador MSI do Windows |

Da para rodar na mao em **Actions -> build -> Run workflow**.

Nada e assinado com certificado: o Windows mostra aviso do SmartScreen
(Mais informacoes -> Executar assim mesmo) e o Android pede confirmacao de
origem desconhecida.

### Desktop (Windows), local

Node.js 18+.

```bash
npm install
npm start              # roda
npm run dist           # gera .exe (NSIS) e .msi em dist/
npm run dist:exe       # so o .exe
npm run dist:msi       # so o .msi
```

O target `msi` do electron-builder **precisa rodar no Windows** (usa WiX). O
`.exe` NSIS sai em Windows, Linux ou macOS.

### Android, local

Android Studio (Ladybug+) ou SDK via linha de comando.

```bash
cd android
./gradlew assembleDebug          # app/build/outputs/apk/debug/
./gradlew assembleRelease        # precisa de keystore sua
```

O repositorio nao traz `gradle-wrapper.jar` (binario). Abra a pasta `android/`
no Android Studio e ele gera o wrapper, ou rode `gradle wrapper` se tiver o
Gradle instalado.

O Gradle copia `shared/shield.js` para `app/src/main/assets/` no `preBuild`, a
cada build. Nao edite a copia em assets — edite o original em `shared/`.

---

## Arquitetura

```
shared/shield.js              defesas de fingerprint — FONTE UNICA
build/                        icone (svg -> ico + pngs)

desktop/src/main/main.js      processo principal, janela, IPC, atalhos
            config.js         config em JSON no userData
            privacy.js        switches, hardening de sessao, proxy, URL, referer
            blocklist.js      lista de bloqueio + parser EasyList/hosts
            fingerprint.js    le shared/shield.js e monta o script
            tabs.js           WebContentsView por aba, sessoes, navegacao
desktop/src/preload/ui.js     unica ponte UI <-> main (contextBridge)
desktop/src/ui/               interface (sem Node, CSP default-src 'none')

android/app/src/main/java/dev/ghostday/browser/
            MainActivity.kt       UI, painel, abas, proxy
            TabManager.kt         WebViews, settings, cookies, wipe
            GhostWebViewClient.kt bloqueio, limpeza de URL, upgrade de esquema
            Shield.kt             injeta shared/shield.js no document-start
            ProxyManager.kt       ProxyController (Tor/custom)
            Blocklist.kt          gerado a partir da mesma semente do desktop
            UrlUtils.kt           mesmas regras de URL do desktop
            Prefs.kt              SharedPreferences
```

### Adblock

Engine propria no dialeto Adblock Plus, em `desktop/src/main/filters.js`:
regras de rede (`||dominio^`, ancoras, curingas, `/regex/`), opcoes
(`$third-party`, `$script`, `$domain=`, `$important`), excecoes `@@` e filtros
cosmeticos (`##seletor`). Cada regra e indexada por um token extraido do
padrao, entao uma requisicao so testa as regras cujos tokens aparecem na URL,
e nao as ~100 mil da lista.

Medido com 73.600 regras de rede e 42.000 cosmeticas carregadas: **16 a 22
microssegundos por requisicao**, ~310 ms para interpretar as listas inteiras.

As listas vem de `desktop/src/main/subscriptions.js` — EasyList, EasyPrivacy,
EasyList Brasil, Peter Lowe, uBlock filters e uBlock badware — baixadas pelo
modulo `net` do Electron (ou seja, passam pelo proxy/Tor se estiver ligado),
guardadas em disco e atualizadas a cada 5 dias. Da para desligar cada uma e
importar lista local.

### Ferramentas de pentest

O painel tem tres abas:

- **escudo** — contador de bloqueios, rota de rede, chaves de privacidade, listas
- **rede** — toda requisicao da aba (status, tipo, host, tempo), filtravel por
  bloqueadas / terceiros / erros; clique copia o comando `curl` equivalente com
  os headers reais. Em cima, auditoria dos cabecalhos de seguranca do documento
  com nota de A a F: CSP, HSTS, clickjacking, `nosniff`, Referrer-Policy,
  Permissions-Policy, COOP, flags dos cookies e vazamento de banner do servidor
- **recursos** — CPU e memoria por aba e por processo, com o aviso de quando
  duas abas dividem o mesmo processo

DevTools em F12.

### Como o shield entra na pagina

Precisa rodar no **mundo principal**, **antes** de qualquer script do site.

- **Desktop:** CDP, `Page.addScriptToEvaluateOnNewDocument`. Um preload com
  `contextIsolation` nao serviria: vive em outro mundo JS e nao alcanca os
  prototypes que a pagina enxerga.
- **Android:** `WebViewCompat.addDocumentStartJavaScript` — o equivalente
  exato. Exige WebView 110+; abaixo disso cai para injecao em `onPageStarted`,
  e o painel mostra "tardio" em vez de "document-start".

O ruido e **estavel por site**: dentro de um site o valor nunca muda (nada
quebra), mas dois sites veem impressoes diferentes, entao nao conseguem cruzar
sua visita em A com a visita em B. Mesma abordagem do Brave.

---

## O que cada um faz

| | Desktop | Android |
|---|---|---|
| Adblock com EasyList e companhia (engine ABP) | **sim** | lista de dominios |
| Filtros cosmeticos (esconde o buraco do anuncio) | **sim** | nao |
| Log de requisicoes + copiar como curl | **sim** | nao |
| Auditoria de cabecalhos de seguranca (nota A-F) | **sim** | nao |
| Monitor de CPU e memoria por aba | **sim** | nao |
| DevTools (F12) | **sim** | nao |
| Limpeza de URL (`utm_*`, `fbclid`, `gclid`...) | sim | sim |
| Upgrade para HTTPS | sim | sim |
| Anti-fingerprint (canvas/WebGL/audio/navigator) | sim | sim |
| Cookies de terceiro bloqueados | por header | nativo do WebView |
| Proxy / Tor trocavel em runtime | por sessao | global (processo) |
| Sessao volatil | sim | modo fantasma |
| Sessao isolada por aba | **sim** | **nao** (ver abaixo) |
| Referer cross-site encurtado | **sim** | **nao** (ver abaixo) |
| DNS sobre HTTPS | sim | do sistema |
| WebRTC travado | sim | n/a no WebView |
| Permissoes negadas por padrao | sim | sim |
| Safe Browsing (telemetria Google) desligado | sim | sim |
| Certificado invalido sempre rejeitado | sim | padrao do WebView |

### Tor

- **Desktop:** qualquer coisa que exponha SOCKS5 em `127.0.0.1:9050` — Tor
  Browser aberto, `tor` do Tor Expert Bundle, ou o servico `tor`.
- **Android:** Orbot. SOCKS5 em `9050`; se o `ProxyController` recusar socks
  na sua versao de WebView, use "proxy..." e aponte para `http://127.0.0.1:8118`,
  o HTTP do proprio Orbot. O app avisa e volta para rota direta se falhar.

---

## Limitacoes, sem maquiagem

**Isto e privacidade, nao anonimato.** Privacidade = sites e anunciantes nao
conseguem te perfilar nem ligar sua atividade entre eles; o GhostDay entrega
isso. Anonimato = ninguem liga a atividade a sua identidade; para isso, **Tor
Browser sem modificacao**, de preferencia em VM. O motivo e contraintuitivo:
anonimato depende de voce parecer igual a milhares de pessoas, e um navegador
customizado, usado so por voce, tem assinatura unica. Cada personalizacao aqui
te deixa mais identificavel, nao menos. O Tor Browser nao tenta ser especial —
tenta fazer todo mundo parecer a mesma pessoa.

Alem disso:

- **Android nao tem sessao por aba.** `CookieManager` e `ProxyController` sao
  unicos por processo no WebView: nao existe o equivalente das abas isoladas do
  desktop. No lugar ha o modo fantasma, que e global.
- **Android nao encurta o `Referer`.** Nao da para alterar headers de saida sem
  reemitir a requisicao por conta propria, o que quebraria POST e streaming.
- **Fuso horario nao e mascarado** em nenhum dos dois: mascarar quebra sites e
  o descompasso com `getTimezoneOffset` e detectavel de qualquer jeito.
- **"Terceiro" usa heuristica de sufixo**, nao a Public Suffix List completa;
  erra em TLDs exoticos.
- **Voce herda a obrigacao de atualizar.** Duas semanas atras de uma correcao do
  V8 e o GhostDay fica menos seguro que um Chrome comum. `npm update electron`
  no desktop; no Android o WebView vem da Play Store, entao e o sistema que
  atualiza.
- **Sem extensoes, sem sync, sem gerenciador de senhas, sem historico.**

---

## Atalhos (desktop)

| | |
|---|---|
| `Ctrl+T` | nova aba |
| `Ctrl+Shift+N` | nova aba isolada |
| `Ctrl+W` | fechar aba |
| `Ctrl+Tab` | proxima aba |
| `Ctrl+1..9` | ir para a aba n |
| `Ctrl+L` | focar a barra de endereco |
| `F5` / `Ctrl+R` | recarregar |
| `Esc` | parar |
| `Alt+setas` | voltar / avancar |
| `Ctrl+Shift+Del` | apagar tudo |

No Android o botao fisico de voltar faz, nessa ordem: fecha o painel, volta no
historico, fecha a aba, sai.

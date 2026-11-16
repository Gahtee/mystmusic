# MystMusic

Bot de música para Discord, otimizado para rodar em **Raspberry Pi 4**. Toca YouTube, SoundCloud e links do Spotify (convertidos para busca), com fila, playlists persistentes, autoplay, slash commands e efeito sonoro de entrada do dono mixado em tempo real.

## Features

- **Reprodução**: YouTube (busca ou link), SoundCloud (busca ou link direto), Spotify (track, álbum, playlist e artista convertidos para busca no YouTube — sem `spotdl`, sem download em disco).
- **Fila**: `!queue`, `!move`, `!remove`, `!shuffle`, `!playnow` (fura-fila), limite anti-spam de 100 faixas.
- **Playlists persistentes** (SQLite): criar, renomear, excluir, add/remover/mover faixas, tocar, ver as do servidor e as suas.
- **Autoplay** (`!autoplay`): ao acabar a fila, puxa relacionados do YouTube (Mix `RD<id>`), com anti-repetição (não repete faixa recente).
- **Loop** (`!loop`), **seek** (`!seek 1:30`), **pause/resume/restart/skip/stop**, **now playing** (`!np`), **histórico** (`!history`).
- **Slash commands**: espelho dos comandos `!` (`/play`, `/playsc`, `/playnow`, `/queue`, `/np`, `/seek`, `/skip`, `/pause`, `/resume`, `/stop`, `/shuffle`, `/autoplay`, `/loop`, `/move`, `/history`, `/playlists`, `/playlist ...`).
- **SFX de entrada** (estilo join sound do Nitro): quando o dono entra no canal, toca um efeito aleatório de `sounds/` **por cima** da música, sem pausar nem reiniciar. Com bot idle, toca "solto". Ver [Efeitos sonoros](#efeitos-sonoros-sfx).
- **Painel musical** com botões (pause, skip, fila, curtir, autoplay) e barra de progresso atualizada.

## Arquitetura do áudio (por que não trava)

Pipeline por faixa: `yt-dlp` → `ffmpeg` (decode para **PCM** `s16le` 48 kHz estéreo) → `PcmMixer` → encoder Opus do `@discordjs/voice` (`StreamType.Raw`).

- O `PcmMixer` (`src/music/pcmMixer.js`) fica **permanentemente** entre a música e o player. Sem overlay, repassa bit-idêntico; com overlay, soma o efeito com duck da música (0.35x) + clipping, dentro do próprio mixer.
- O SFX **nunca mata/recria o stream** da música: o efeito é pré-decodificado para PCM no boot e injetado via `playOverlay()` — zero rede, zero seek, zero gap.
- Sem transcodificação extra fora do necessário, sem `inlineVolume` (economia de CPU no Pi).

## Requisitos

- Node.js 22+, `ffmpeg` + `ffprobe`, `yt-dlp`, `pm2` (produção).
- Conta Discord com app/bot criado no [Developer Portal](https://discord.com/developers/applications) (token + client ID + intents de voz/mensagens).

## Instalação

```bash
git clone <repo> mystmusic && cd mystmusic
npm install
cp .env.example .env  # se não existir, crie conforme abaixo
```

### `.env` (existe `.env.example` como modelo)

```env
TOKEN=seu_token_do_bot
CLIENT=seu_client_id
GUILDS=ids_das_guilds_permitidas,separados_por_virgula
OWNER_IDS=seu_user_id_do_discord
# opcional:
# cookies.txt na raiz (cookies do YouTube exportados) — melhora extração
# SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=... (p/ playlists do Spotify >50 faixas)
```

#### Spotify API (opcional — playlists grandes)

Sem credencial, link do Spotify resolve via embed público (`open.spotify.com/embed`, sem login): **teto de ~50 faixas por playlist e ~10 top tracks por artista** — resto é cortado.

Com `SPOTIFY_CLIENT_ID` + `SPOTIFY_CLIENT_SECRET` no `.env`, dá para buscar a playlist inteira, de 100 em 100 (sem teto):

1. Crie um app grátis em https://developer.spotify.com/dashboard (qualquer nome/descrição).
2. Copie **Client ID** e **Client Secret** (Settings → Basic Information) para o `.env`.
3. `pm2 restart mystmusic`.

Como funciona (fluxo **Client Credentials**, server-to-server, sem login de usuário):
- `POST https://accounts.spotify.com/api/token` com `Authorization: Basic base64(ID:SECRET)` + `grant_type=client_credentials` → `access_token` Bearer (vale 3600 s).
- `GET https://api.spotify.com/v1/playlists/{id}/tracks?limit=100&offset=N` (e `/v1/albums/{id}/tracks`, `/v1/artists/{id}/top-tracks`) com `Authorization: Bearer …`, paginando `offset` até `total`.
- Privadas/restritas continuam inacessíveis (precisariam de login OAuth com escopo) — só públicas.
- Código ainda não implementado: hoje `src/music/spotify.js` só usa o embed; com as vars no `.env`/`env.js` o próximo passo é trocar `resolveSpotifyLink` para tentar a API primeiro e cair no embed como fallback.

> **Não use `USER=` para o seu ID.** No Linux `$USER` já existe (usuário do SO) e o `dotenv` não sobrescreve — o bot leria `gahtee`/`pi` em vez do ID. Use sempre `OWNER_IDS`. Para pegar seu ID: Discord → Ajustes → Avançado → modo desenvolvedor → botão direito no seu nome → Copiar ID.

### Rodando

```bash
npm start            # dev
pm2 start src/index.js --name mystmusic   # produção
pm2 restart mystmusic
pm2 logs mystmusic --lines 30 --nostream
```

### Slash commands

```bash
npm run slash:deploy   # registra
npm run slash:limpar   # remove
npm run slash:reset    # remove + registra (use após mudar descrições)
```

### Testes

```bash
npm run smoke          # completo (usa rede: yt-dlp/ffmpeg)
npm run smoke:offline  # só sintaxe + puras (SMOKE_SKIP_NETWORK=1)
```

## Comandos

Prefixo `!` (e equivalente `/` onde indicado):

| Comando | Descrição |
|---|---|
| `!play <nome/link>` (`/play`) | Adiciona à fila (YouTube/Spotify). |
| `!playsc <nome/link>` (`/playsc`) | SoundCloud (busca pode retornar preview de 30 s em faixa de selo — prefira link direto). |
| `!playnow <nome/link>` (`/playnow`) | Fura a fila e toca a seguir. Aceita Spotify. |
| `!queue` (`/queue`) | Mostra a fila. |
| `!np` (`/np`) | Faixa atual. |
| `!seek <10:20\|1:12:14\|00:15\|15>` (`/seek`) | Pula para a posição (min:seg). |
| `!skip` (`/skip`) | Pula a faixa. |
| `!pause` / `!resume` | Pausa / retoma. |
| `!restart` | Retoca a faixa do zero. |
| `!stop` (`/stop`) | Para, limpa a fila e sai do canal. |
| `!autoplay` (`/autoplay`) | Liga/desliga autoplay (relacionados). |
| `!loop` (`/loop`) | Liga/desliga loop da faixa atual. |
| `!move <de> <para>` (`/move`) | Move faixa na fila. |
| `!remove <n>` | Remove faixa da fila. |
| `!shuffle` | Embaralha a fila. |
| `!history` (`/history`) | Últimas faixas tocadas. |
| `!playlist criar "Nome"` | Cria playlist. |
| `!playlist add "Nome" <música>` | Adiciona faixa (aceita link do Spotify — salva já resolvido no YouTube). |
| `!playlist remover "Nome" <pos>` / `!playlist mover "Nome" <de> <para>` | Gerencia faixas. |
| `!playlist listar "Nome"` / `!playlist tocar "Nome" [@usuário]` | Lista / toca (pode tocar a de outro membro). |
| `!playlist excluir "Nome"` / `renomear "Antiga" "Nova"` | Exclui / renomeia. |
| `!playlists` (`/playlists minhas\|servidor`) | Lista playlists. |
| `!sfx` | Toca efeito aleatório (só dono). Com música: por cima; idle: solto. |
| `!bass [dB\|off]` (`/bass`) | Bass boost (padrão +6dB, sem limite; sem arg liga/desliga). Aplica na hora. |
| `!nightcore [taxa\|off]` (`/nightcore`) | Nightcore (padrão 1.25x, 0.5–3; sem arg liga/desliga). A faixa acaba mais cedo. |
| `!botmorreu` / `!botbosta` | Reinicia o bot via pm2. |
| `!help` | Ajuda. |

## Efeitos sonoros (SFX)

- Jogue `.mp3`/`.ogg`/`.wav`/`.m4a`/`.opus` curtos (1–3 s, até 2 MB cada) em `sounds/` e dê `pm2 restart mystmusic` — o boot pré-decodifica tudo para PCM em RAM (~192 KB por segundo de efeito).
- O sorteio (join do dono ou `!sfx`) pega **qualquer áudio da pasta, exceto `entrada.mp3`**.
- `sounds/entrada.mp3` é o **failsafe**: só toca se não houver nenhum outro efeito válido. É o único arquivo de `sounds/` rastreado no git — seus efeitos pessoais ficam fora (ver `.gitignore`).
- Disparo: só para `OWNER_IDS`, só em JOIN real (mute/deafen/troca não disparam), com debounce 5 s + cooldown 30 s por servidor.
- Formato "ideal": tanto faz para lag — o decode é 1x no boot, o trigger custa zero. Prefira `.ogg`/`.mp3` curtos e com volume normalizado.

## Estrutura

```
src/
  index.js            # Discord client, !comandos, slash router, voiceStateUpdate
  music/
    manager.js        # fila/state, transições, autoplay, seek, SFX trigger
    resolver.js       # yt-dlp/ffmpeg (metadados, PCM, playlists)
    pcmMixer.js       # mixer PCM em tempo real (overlay sem restart)
    player.js         # playStream (createAudioResource)
    sfx.js            # detecção de join, sorteio, preload PCM, failsafe
    spotify.js        # conversão link Spotify → busca (via embed público, sem credencial)
  config/
    env.js            # TOKEN/CLIENT/GUILDS/OWNER_IDS
    sqlite.js         # logs + playlists (db/*.db, fora do git)
    deploy-commands.js / remover.js
sounds/
  entrada.mp3         # chime failsafe (único rastreado)
test/
  smoke.js            # sintaxe + puras + integração yt-dlp/ffmpeg
```

## Limites conhecidos

- Embed público do Spotify retorna ~50 faixas por playlist e ~10 top tracks por artista (teto da página pública, não do bot).
- Episódios de podcast convertem o título, mas o YouTube raramente tem o episódio exato.
- `scsearch` pode devolver preview de 30 s com DRM em faixa de selo — prefira link direto do SoundCloud.
- O bot sai sozinho do canal quando ele esvazia (inatividade).

## Licença

ISC.

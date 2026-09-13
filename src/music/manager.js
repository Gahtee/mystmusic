const {
  joinVoiceChannel,
  createAudioPlayer,
  entersState,
  VoiceConnectionStatus,
  StreamType,
} = require("@discordjs/voice");
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { playStream } = require("./player");
const {
  getAudioMetadata,
  getAudioStream,
  getPlaylistMetadata,
  killStreamProcesses,
} = require("./resolver");
const { logsDb, playlistDb } = require("../config/sqlite");
const states = new Map();

// Limites anti-spam: evitam N yt-dlp em paralelo e fila infinita.
const MAX_QUEUE = 100;
// Intervalo de atualização da barra de progresso (30s p/ evitar rate-limit).
const PROGRESS_EDIT_INTERVAL_MS = 30_000;
const PROGRESS_INITIAL_DELAY_MS = 10_000;

function savePlayLog(
  guildId,
  userId,
  query,
  title,
  status,
  errorMessage = null,
) {
  const sql = `INSERT INTO play_logs (guild_id, requested_by, query, resolved_title, status, error_message) VALUES (?, ?, ?, ?, ?, ?)`;
  logsDb.run(
    sql,
    [guildId, userId, query, title, status, errorMessage],
    (err) => {
      if (err) console.error("Falha ao salvar play_log:", err.message);
    },
  );
}

function formatarTempo(segundos) {
  if (segundos === null || segundos === undefined || !Number.isFinite(segundos))
    return "--:--";
  const m = Math.floor(segundos / 60);
  const s = Math.floor(segundos % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function criarBarraProgresso(elapsedSec, totalSec, tamanho = 20) {
  if (!totalSec || totalSec <= 0) return "▬".repeat(tamanho);
  const proporcao = Math.max(0, Math.min(elapsedSec / totalSec, 1));
  const posicao = Math.min(tamanho - 1, Math.round(proporcao * (tamanho - 1)));
  return "▬".repeat(posicao) + "🔵" + "▬".repeat(tamanho - posicao - 1);
}

// Quanto tempo (ms) já tocou da faixa atual, descontando o tempo pausado.
function calcularElapsedMs(state) {
  if (!state.playbackStartedAt) return 0;
  const agora = state.pausedAt || Date.now();
  return Math.max(
    0,
    agora - state.playbackStartedAt - (state.totalPausedMs || 0),
  );
}

// Extrai o ID de 11 caracteres de uma URL do YouTube (watch?v= ou youtu.be/), usado
// pelo autoplay para montar a playlist "Mix" (relacionados) a partir da faixa atual.
function extrairYoutubeId(url) {
  if (!url) return null;
  const match = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

function criarPainelMusical(metadata, elapsedSec = 0, flags = {}) {
  const titulo = metadata.title || "🔍 Buscando dados da faixa...";
  const url = metadata.url || null;
  const descricaoTitulo = url ? `**[${titulo}](${url})**` : `**${titulo}**`;
  // Clamp: o relógio é Date.now() e o Discord atrasa/adianta o áudio real —
  // sem isso o painel mostra "4:10 / 4:05".
  const elapsedSafe = Math.max(0, Math.floor(elapsedSec) || 0);
  const elapsed = metadata.duration
    ? Math.min(elapsedSafe, Math.floor(metadata.duration))
    : elapsedSafe;
  const barra = metadata.duration
    ? `${criarBarraProgresso(elapsed, metadata.duration)}\n\`${formatarTempo(elapsed)} / ${formatarTempo(metadata.duration)}\``
    : "🔍 *Carregando informações...*";
  const pedidoPor = metadata.requestedBy
    ? `<@${metadata.requestedBy}>`
    : "📻 Autoplay";
  const statusExtras = [
    flags.autoplay ? "📻 Autoplay ON" : null,
    flags.loop ? "🔂 Loop ON" : null,
  ]
    .filter(Boolean)
    .join(" • ");
  const rodape = statusExtras
    ? `MystMusic • ${statusExtras}`
    : "MystMusic • Controle pelos botões abaixo";

  const embed = new EmbedBuilder()
    .setColor("#5865F2")
    .setTitle("🎶 Tocando Agora")
    .setDescription(`${descricaoTitulo}\n${barra}`)
    .setThumbnail(metadata.thumbnail || null)
    .addFields(
      {
        name: "📺 Canal",
        value: String(metadata.uploader || "Desconhecido").slice(0, 256),
        inline: true,
      },
      { name: "👤 Pedido por", value: pedidoPor, inline: true },
    )
    .setFooter({ text: rodape });
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("btn_restart")
      .setLabel("🔄")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("btn_stop")
      .setLabel("⏹️")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("btn_skip")
      .setLabel("⏭️")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("btn_shuffle")
      .setLabel("🔀")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("btn_like")
      .setLabel("❤️ Curtir")
      .setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("btn_pauseresume")
      .setLabel("⏯️ Pausar/Retomar")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("btn_queue")
      .setLabel("📋 Fila")
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row1, row2] };
}

function shuffleQueue(guildId) {
  const state = states.get(guildId);
  if (!state || state.queue.length <= 2) return false;

  const musicaAtual = state.queue[0];
  const proximasMusicas = state.queue.slice(1);

  for (let i = proximasMusicas.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [proximasMusicas[i], proximasMusicas[j]] = [
      proximasMusicas[j],
      proximasMusicas[i],
    ];
  }
  state.queue = [musicaAtual, ...proximasMusicas];
  return true;
}

// Para os timers da barra de progresso sem derrubar o resto do state.
function limparTimersProgresso(state) {
  if (!state) return;
  if (state.progressTimeout) {
    clearTimeout(state.progressTimeout);
    state.progressTimeout = null;
  }
  if (state.progressInterval) {
    clearInterval(state.progressInterval);
    state.progressInterval = null;
  }
}

// Mata o stream anterior (yt-dlp/ffmpeg) antes de trocar de faixa.
function pararStreamAtual(state) {
  if (!state || !state.audioStream) return;
  killStreamProcesses(state.audioStream);
  state.audioStream = null;
}

// Flags visuais do painel (autoplay/loop) sem acoplar o state inteiro.
function flagsDoPainel(state) {
  if (!state) return {};
  return { autoplay: !!state.autoplay, loop: !!state.loop };
}

// Gerenciador de painéis (envia o novo, tenta apagar o antigo, e liga a atualização
// periódica da barra de progresso)
async function enviarNovoPainel(channel, state, metadata) {
  limparTimersProgresso(state);
  if (state.lastPanelMessage) {
    try {
      await state.lastPanelMessage.delete();
    } catch (err) {
      // Ignora se a mensagem já tiver sido apagada manualmente
    }
  }
  const painel = criarPainelMusical(
    metadata,
    Math.floor(calcularElapsedMs(state) / 1000),
    flagsDoPainel(state),
  );
  state.lastPanelMessage = await channel.send(painel);

  // Só vale a pena atualizar a barra se soubermos a duração da faixa.
  // Delay inicial para compensar o tempo entre o envio da mensagem e o início
  // real da reprodução no Discord. Intervalo de 30s para evitar rate-limit
  // da API do Discord em sessões longas.
  if (metadata.duration) {
    state.progressTimeout = setTimeout(() => {
      state.progressInterval = setInterval(async () => {
        if (!state.current || !state.lastPanelMessage) return;
        const elapsedSec = Math.floor(calcularElapsedMs(state) / 1000);
        // Pausado: a barra não anda, não gasta edit à toa.
        if (state.pausedAt) return;
        try {
          await state.lastPanelMessage.edit(
            criarPainelMusical(state.current, elapsedSec, flagsDoPainel(state)),
          );
        } catch (err) {
          // Mensagem apagada manualmente ou permissão perdida — para de tentar.
          clearInterval(state.progressInterval);
          state.progressInterval = null;
        }
      }, PROGRESS_EDIT_INTERVAL_MS);
    }, PROGRESS_INITIAL_DELAY_MS);
  }
}

// Centraliza a decisão de qual StreamType usar e o retry automático.
// song.isOpus: true (confirmado), false (confirmado outro codec) ou null/undefined (desconhecido, ex: playlists).
// Retorna o AudioResource criado (o chamador pode comparar resource === state.resource
// para saber se um idle pertence ao stream atual ou a um stream antigo já superado).
function iniciarReproducao(
  state,
  song,
  forcarTranscodificacao = false,
  seekSec = 0,
) {
  // Mata o stream anterior antes de criar o novo — sem isso cada skip/seek
  // deixava um yt-dlp (+ffmpeg) órfão consumindo banda/CPU.
  pararStreamAtual(state);

  // Seek sempre força transcodificação (--download-sections quebra o Opus nativo).
  const streamType =
    forcarTranscodificacao || seekSec > 0 || song.isOpus === false
      ? StreamType.Arbitrary
      : StreamType.WebmOpus;

  // Ajusta o relógio interno para que o timer reflita a posição real na faixa.
  state.playbackStartedAt = Date.now() - seekSec * 1000;
  state.pausedAt = null;
  state.totalPausedMs = 0;
  if (!forcarTranscodificacao) state.fallbackAttempted = false;

  const audioStream = getAudioStream(song.url, seekSec);
  state.audioStream = audioStream;
  state.resource = playStream(state.player, audioStream, streamType);
  return state.resource;
}

// Inicia uma faixa otimista: o stream começa IMEDIATAMENTE com o que já se
// sabe, sem esperar o metadado completo (~8s). Retorna a promise de metadados
// para o chamador preencher título/painel/log quando chegar.
// metaPromise opcional: reaproveita uma extração já em andamento (evita duplo yt-dlp).
function iniciarFaixaOtimista(
  state,
  song,
  query,
  searchEngine = "ytsearch",
  seekSec = 0,
  metaPromise = null,
) {
  // Stream usa URL canônica se já conhecida; senão monta o target de busca
  // (yt-dlp resolve `ytsearch1:termo` direto como stream — texto cru não vale).
  const isQueryUrl =
    typeof query === "string" &&
    (query.startsWith("http://") || query.startsWith("https://"));
  const streamTarget =
    song.url || (isQueryUrl ? query : `${searchEngine}1:${query}`);
  pararStreamAtual(state);

  // Otimista: ainda não sabemos o codec → começa em WebmOpus (passthrough,
  // sem transcodificação). Se falhar no início, o handler de 'error' do
  // player faz fallback para Arbitrary (caminho já existente).
  const streamType =
    seekSec > 0 || song.isOpus === false
      ? StreamType.Arbitrary
      : StreamType.WebmOpus;

  state.playbackStartedAt = Date.now() - seekSec * 1000;
  state.pausedAt = null;
  state.totalPausedMs = 0;
  state.fallbackAttempted = false;

  const audioStream = getAudioStream(streamTarget, seekSec);
  state.audioStream = audioStream;
  state.resource = playStream(state.player, audioStream, streamType);

  // Metadados em paralelo (cache cobre repetições em ~0ms).
  // Se o chamador já tem uma extração em andamento, reaproveita.
  const metaP =
    metaPromise ||
    (song.url
      ? garantirMetadadosCompletos(song)
      : getAudioMetadata(query, searchEngine).then((meta) => {
          song.title = meta.title;
          song.url = meta.url;
          song.uploader = meta.uploader;
          song.thumbnail = meta.thumbnail;
          song.isOpus = meta.isOpus;
          song.duration = meta.duration;
          return song;
        }));
  metaP.catch(() => {});
  return metaP;
}

// Pré-resolve os metadados da próxima faixa em background enquanto a atual
// toca. Na transição, o metadado já está no cache → skip/fim de faixa
// começam o stream sem esperar extração.
function prefetchProxima(state, searchEngine = "ytsearch") {
  try {
    const proxima = state && state.queue && state.queue[1];
    if (!proxima) return;
    // Só vale pré-resolver se ainda falta algo (playlist flat ou otimista).
    if (proxima.title && proxima.duration && proxima.url) return;
    const p = proxima.url
      ? garantirMetadadosCompletos(proxima)
      : getAudioMetadata(proxima.query || "", searchEngine).then((meta) => {
          Object.assign(proxima, meta);
          return proxima;
        });
    p.catch(() => {});
  } catch (err) {
    // Pré-fetch é best-effort — nunca pode quebrar a reprodução.
  }
}

// Faixas vindas de playlist são listadas com --flat-playlist (rápido), mas o
// extrator do SoundCloud não preenche título/uploader/thumbnail nesse modo (limitação
// conhecida do yt-dlp). Se estiver faltando, busca os metadados completos AGORA — só
// dessa faixa, não da playlist inteira, então não impacta o tempo de adicionar à fila.
async function garantirMetadadosCompletos(song) {
  if (song.title && song.duration && song.url) return song;
  try {
    const completo = await getAudioMetadata(song.url);
    song.title = song.title || completo.title;
    song.uploader = completo.uploader;
    song.thumbnail = song.thumbnail || completo.thumbnail;
    song.isOpus = completo.isOpus;
    song.duration = song.duration || completo.duration;
    // URL pode ter sido resolvida agora (caso do play otimista por busca).
    if (completo.url && (!song.url || /^ytsearch\d*:/i.test(song.url))) {
      song.url = completo.url;
    }
  } catch (err) {
    console.error(`Falha ao completar metadados de ${song.url}:`, err.message);
    song.title = song.title || "Título indisponível";
  }
  return song;
}

// Faixa já tem dados suficientes para um painel final? Se sim, o chamador
// manda UM painel só em vez de provisório + completo (menos flicker,
// menos chance de órfão duplicado).
function temMetadadosCompletos(song) {
  return !!(song && song.title && song.url && song.duration);
}

// IDs já tocados/enfileirados recentemente (anti-repetição do autoplay).
function registrarIdRecente(state, song) {
  try {
    const id = extrairYoutubeId(song?.url);
    if (!id) return;
    if (!state.recentIds) state.recentIds = new Set();
    state.recentIds.add(id);
    // Cap: Set itera em ordem de inserção — descarta os mais antigos.
    while (state.recentIds.size > 100) {
      state.recentIds.delete(state.recentIds.values().next().value);
    }
  } catch {
    // Best-effort: nunca pode quebrar a reprodução.
  }
}

// Filtra candidatas do autoplay removendo o que já está na fila/atual/recente.
function filtrarRelacionadasNovas(state, candidatas) {
  const vistos = new Set(state?.recentIds || []);
  const atual = extrairYoutubeId(state?.current?.url);
  if (atual) vistos.add(atual);
  for (const s of state?.queue || []) {
    const id = extrairYoutubeId(s?.url);
    if (id) vistos.add(id);
  }
  return (candidatas || []).filter((s) => {
    const id = extrairYoutubeId(s?.url);
    return id && !vistos.has(id);
  });
}

// Detecta playlist tanto do YouTube (?list=...) quanto do SoundCloud (.../sets/...).
function isPlaylistUrl(query) {
  return (
    query.includes("list=") || /soundcloud\.com\/[^/]+\/sets\//i.test(query)
  );
}

async function play(message, query, searchEngine = "ytsearch") {
  const voiceChannel = message.member.voice.channel;
  if (!voiceChannel) return message.reply("Entra num canal de voz primeiro!");

  const guildId = message.guild.id;
  let state = states.get(guildId);

  const isPlaylist = isPlaylistUrl(query);
  // Dispara a busca de metadados JÁ, em paralelo com a conexão de voz abaixo — as
  // duas coisas são independentes, não precisam rodar em sequência.
  // searchEngine só é usado quando query não é uma URL (texto livre).
  const metadataPromise = isPlaylist
    ? getPlaylistMetadata(query)
    : getAudioMetadata(query, searchEngine);
  metadataPromise.catch(() => {}); // evita warning de unhandledRejection; o erro real é tratado no try/catch mais abaixo

  if (!state) {
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guildId,
      adapterCreator: message.guild.voiceAdapterCreator,
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      console.log("✅ Conexão de voz estabelecida com sucesso!");
    } catch (error) {
      connection.destroy();
      return message.reply("A conexão com o Discord falhou.");
    }

    const serverPlayer = createAudioPlayer();
    connection.subscribe(serverPlayer);

    serverPlayer.on("error", (error) => {
      console.error(`Erro no player do servidor ${guildId}: ${error.message}`);

      const currentState = states.get(guildId);
      const tocandoHaPouco =
        currentState &&
        Date.now() - (currentState.playbackStartedAt || 0) < 2500;

      // Se a falha foi logo no início (provável erro de demux por assumirmos Opus
      // errado) e ainda não tentamos o fallback, tenta de novo já transcodificando.
      // Chamar iniciarReproducao aqui dentro, de forma síncrona, faz a própria lib
      // @discordjs/voice cancelar a transição forçada para "idle" (ela só força idle
      // se o resource ainda for o mesmo que falhou) — então a fila NÃO avança.
      if (
        currentState &&
        currentState.current &&
        tocandoHaPouco &&
        !currentState.fallbackAttempted
      ) {
        currentState.fallbackAttempted = true;
        console.warn(
          `⚠️ Falha ao tocar "${currentState.current.title}" via WebmOpus. Tentando novamente com transcodificação (Arbitrary)...`,
        );
        return iniciarReproducao(currentState, currentState.current, true);
      }

      serverPlayer.stop();
    });

    // Loop da Fila Automática (Quando a música termina)
    // O @discordjs/voice 0.19 emite 'idle' 2x na mesma transição quando a
    // troca de resource acontece rápido (fallback Arbitrary que falha,
    // buffering->idle), e o handler antigo fazia shift() + painel a cada
    // evento — 1 fim de faixa gerava 2 painéis ("mostrou 2x" no autoplay).
    // Correção em 2 camadas:
    //  (a) resourceDoEvento: só o idle do resource ATUAL avança a fila;
    //      idle de resource antigo (já substituído) é ignorado.
    //  (b) transitioning+generation: transição em andamento bloqueia
    //      entrada duplicada; continuação perdedora aborta após o await.
    serverPlayer.on("stateChange", (oldState, newState) => {
      const foiParaIdle =
        newState?.status === "idle" && oldState?.status !== "idle";
      if (!foiParaIdle) return;
      // (a): idle de resource antigo — player já está tocando/buffering
      // outra coisa, então este evento é obsoleto. Compara o resource do
      // EVENTO (oldState.resource morreu) com o resource atual do player:
      // se o player já tem resource diferente em playing/buffering/paused,
      // ignora.
      try {
        const statusAgora = serverPlayer?.state?.status;
        const resourceAgora = serverPlayer?.state?.resource;
        const resourceQueMorreu = oldState?.resource;
        const tocandoOutraCoisa =
          (statusAgora === "playing" ||
            statusAgora === "buffering" ||
            statusAgora === "paused") &&
          resourceAgora &&
          resourceQueMorreu &&
          resourceAgora !== resourceQueMorreu;
        if (tocandoOutraCoisa) return;
      } catch {
        /* best-effort */
      }
      queueMicrotask(() => processarIdle(guildId));
    });

    async function processarIdle(guildId) {
      const currentState = states.get(guildId);
      if (!currentState) return;

      // (b1): transição já em andamento — ignora a duplicada.
      if (currentState.transitioning) {
        console.warn(
          `⚠️ Transição ignorada (já em andamento) no servidor ${guildId}.`,
        );
        return;
      }
      currentState.transitioning = true;
      try {
        // Loop de faixa: não avança a fila, retoca a atual do zero.
        // Equivale a um restart automático (sem duplicar referência).
        if (currentState.loop && currentState.current) {
          iniciarReproducao(currentState, currentState.current);
          if (currentState.textChannel) {
            await enviarNovoPainel(
              currentState.textChannel,
              currentState,
              currentState.current,
            ).catch(() => {});
          }
          return;
        }

        currentState.queue.shift();

        if (currentState.queue.length > 0) {
          currentState.current = currentState.queue[0];
          registrarIdRecente(currentState, currentState.current);
          // Painel ÚNICO por transição: provisório só se faltar dado.
          // O painel antigo é DELETADO dentro do enviarNovoPainel,
          // então duplicata visível = duas transições concorrentes
          // (ver guards transitioning+generation abaixo) ou um segundo
          // painel enviado por outro caminho (ex: seek/next).
          const painelProvisorio = !temMetadadosCompletos(currentState.current);

          // Guarda contra transição concorrente: se outra troca de faixa
          // começar enquanto awaitamos os metadados (stream otimista que
          // falha rápido, skip duplo, etc.), endTransicao roda 2x e o
          // painel/log duplicam (foi o bug do autoplay "mostrou 2x").
          // (Belt + suspenders: transitioning bloqueia entry duplicada,
          // geração aborta a continuação perdedora.)
          const minhaGeracao = (currentState.generation =
            (currentState.generation || 0) + 1);

          // Play imediato: stream começa já, metadados completam em
          // paralelo (ou já vieram do pré-fetch) e o painel atualiza.
          const faixaIniciada = currentState.current;
          const metaP = iniciarFaixaOtimista(
            currentState,
            currentState.current,
            currentState.current.query,
          );
          if (painelProvisorio) {
            enviarNovoPainel(
              currentState.textChannel,
              currentState,
              currentState.current,
            ).catch(() => {});
          }
          prefetchProxima(currentState);

          try {
            await metaP;
          } catch (err) {
            console.error("Falha nos metadados da próxima faixa:", err.message);
          }

          // Atualiza o painel com os dados completos (título, thumbnail).
          // Guarda dupla: geração mudou (nova transição assumiu) ou a
          // faixa atual trocou durante o await — NÃO reenvia, a nova
          // transição já mandou o próprio painel. Sem isso cada falha
          // rápida gerava painel duplicado.
          // Se a faixa já tinha metadados e NÃO mandamos provisório,
          // o painel único vai AGORA (evita faixa sem painel).
          if (
            currentState.generation !== minhaGeracao ||
            currentState.current !== faixaIniciada
          )
            return;
          if (currentState.textChannel && currentState.current) {
            await enviarNovoPainel(
              currentState.textChannel,
              currentState,
              currentState.current,
            ).catch(() => {});
          }

          const quemPediu =
            currentState.current.requestedBy || "Fila Automática";
          savePlayLog(
            guildId,
            quemPediu,
            currentState.current.query,
            currentState.current.title,
            "SUCCESS",
          );
        } else if (currentState.autoplay) {
          // Autoplay: só funciona a partir de uma faixa do YouTube (usamos a
          // playlist "Mix"/relacionados dela). SoundCloud não tem equivalente.
          const idAtual = extrairYoutubeId(currentState.current?.url);
          let relacionadas = [];
          if (idAtual) {
            try {
              const resultado = await getPlaylistMetadata(
                `https://www.youtube.com/watch?v=${idAtual}&list=RD${idAtual}`,
              );
              relacionadas = filtrarRelacionadasNovas(
                currentState,
                (resultado.songs || []).filter(
                  (s) => extrairYoutubeId(s.url) !== idAtual,
                ),
              ).slice(0, 5);
            } catch (err) {
              console.error(
                "Autoplay: falha ao buscar relacionados:",
                err.message,
              );
            }
          }

          if (relacionadas.length > 0) {
            relacionadas.forEach((s) => {
              s.requestedBy = null;
              s.query = s.url;
              registrarIdRecente(currentState, s);
            });
            currentState.queue.push(...relacionadas);
            currentState.current = currentState.queue[0];
            registrarIdRecente(currentState, currentState.current);
            const minhaGeracao = (currentState.generation =
              (currentState.generation || 0) + 1);

            const faixaIniciada = currentState.current;
            const metaP = iniciarFaixaOtimista(
              currentState,
              currentState.current,
              currentState.current.query,
            );
            // Autoplay sempre chega com flat-playlist (sem duration) →
            // provisório no início, final após os metadados.
            if (currentState.textChannel) {
              currentState.textChannel
                .send(
                  `📻 **Autoplay:** adicionei ${relacionadas.length} música(s) relacionada(s) à fila.`,
                )
                .catch(() => {});
              await enviarNovoPainel(
                currentState.textChannel,
                currentState,
                currentState.current,
              ).catch(() => {});
            }
            try {
              await metaP;
            } catch (err) {
              console.error("Autoplay: falha nos metadados:", err.message);
            }
            if (
              currentState.generation !== minhaGeracao ||
              currentState.current !== faixaIniciada
            )
              return;
            if (currentState.textChannel && currentState.current) {
              await enviarNovoPainel(
                currentState.textChannel,
                currentState,
                currentState.current,
              ).catch(() => {});
            }

            savePlayLog(
              guildId,
              null,
              currentState.current.query,
              currentState.current.title,
              "SUCCESS",
            );
          } else {
            currentState.current = null;
          }
        } else {
          currentState.current = null;
        }
      } catch (err) {
        console.error(
          `Erro na transição de faixa (${guildId}):`,
          err?.message || err,
        );
      } finally {
        currentState.transitioning = false;
      }
    }

    // Configuração inicial do Estado do Servidor
    state = {
      connection,
      player: serverPlayer,
      queue: [],
      current: null,
      textChannel: message.channel, // Salva o canal para usar no stateChange
      lastPanelMessage: null,
      autoplay: false,
      loop: false,
      pausedAt: null,
      totalPausedMs: 0,
      progressInterval: null,
      progressTimeout: null,
      audioStream: null,
    };
    states.set(guildId, state);
  } else {
    // Sessão já existe: acompanha o canal de texto mais recente para que o
    // painel da próxima faixa não caia num canal antigo.
    state.textChannel = message.channel;
  }

  // Anti-spam: barra novas adições quando a fila já está cheia.
  const filaCheia = () => state.queue.length >= MAX_QUEUE;

  try {
    if (isPlaylist) {
      message.reply(
        "🔍 Processando playlist... Isso pode levar alguns segundos.",
      );

      const { playlistTitle, songs } = await metadataPromise;

      if (!songs || songs.length === 0) {
        return message.reply(
          "❌ Não encontrei nenhuma música válida nessa playlist.",
        );
      }

      const espacoLivre = Math.max(0, MAX_QUEUE - state.queue.length);
      if (espacoLivre <= 0) {
        return message.reply(
          `❌ A fila está cheia (limite de ${MAX_QUEUE}). Use \`!skip\` ou \`!remove\` para liberar espaço.`,
        );
      }
      const paraAdicionar = songs.slice(0, espacoLivre);

      paraAdicionar.forEach((song) => {
        song.requestedBy = message.author.id;
        song.query = song.url;
        // Campos que o modo --flat-playlist não garante (ex: SoundCloud).
        song.isOpus = song.isOpus ?? null;
        state.queue.push(song);
      });

      const avisoLimite =
        songs.length > paraAdicionar.length
          ? ` (limite de ${MAX_QUEUE} — ${songs.length - paraAdicionar.length} ficaram de fora)`
          : "";
      message.reply(
        `✅ **${paraAdicionar.length} músicas** da playlist **"${playlistTitle}"** foram adicionadas à fila!${avisoLimite}`,
      );

      if (state.queue.length === paraAdicionar.length) {
        state.current = state.queue[0];
        // Play imediato da 1ª faixa da playlist + painel provisório;
        // metadados completam em paralelo e o painel atualiza.
        const metaP = iniciarFaixaOtimista(
          state,
          state.current,
          state.current.query,
        );
        await enviarNovoPainel(message.channel, state, state.current).catch(
          () => {},
        );
        prefetchProxima(state);
        try {
          await metaP;
        } catch (err) {
          console.error("Falha nos metadados da playlist:", err.message);
        }
        await enviarNovoPainel(message.channel, state, state.current).catch(
          () => {},
        );
        savePlayLog(
          guildId,
          message.author.id,
          state.current.query,
          state.current.title,
          "SUCCESS",
        );
      }
      // Pré-resolve a próxima da fila em background (transição sem espera).
      prefetchProxima(state);
    } else {
      if (filaCheia()) {
        return message.reply(
          `❌ A fila está cheia (limite de ${MAX_QUEUE}). Use \`!skip\` ou \`!remove\` para liberar espaço.`,
        );
      }
      // PLAY IMEDIATO: cria o placeholder, começa o stream NA HORA
      // (reaproveitando a extração já em andamento) e completa o painel
      // quando os metadados chegarem. Corta ~8s do caminho crítico.
      const placeholder = {
        title: null, // painel mostra "Buscando dados da faixa..."
        url: null,
        thumbnail: null,
        uploader: null,
        duration: null,
        isOpus: null,
        requestedBy: message.author.id,
        query,
      };
      state.queue.push(placeholder);

      if (state.queue.length === 1) {
        state.current = placeholder;
        const metaP = iniciarFaixaOtimista(
          state,
          placeholder,
          query,
          searchEngine,
          0,
          metadataPromise.then((meta) => {
            placeholder.title = meta.title;
            placeholder.url = meta.url;
            placeholder.uploader = meta.uploader;
            placeholder.thumbnail = meta.thumbnail;
            placeholder.isOpus = meta.isOpus;
            placeholder.duration = meta.duration;
            return placeholder;
          }),
        );
        await enviarNovoPainel(message.channel, state, placeholder).catch(
          () => {},
        );
        try {
          await metaP;
        } catch (err) {
          // Extração falhou: remove o placeholder e informa o motivo.
          state.queue = state.queue.filter((s) => s !== placeholder);
          if (state.current === placeholder) state.current = null;
          console.error("Erro no processamento:", err);
          savePlayLog(
            guildId,
            message.author.id,
            query,
            null,
            "FAILED",
            err.message,
          );
          return message.reply(err.message || "Deu erro ao buscar a música.");
        }
        await enviarNovoPainel(message.channel, state, placeholder).catch(
          () => {},
        );
        savePlayLog(
          guildId,
          message.author.id,
          query,
          placeholder.title,
          "SUCCESS",
        );
      } else {
        // Entrou na fila: resolve o título em background para o !queue
        // mostrar algo útil, sem bloquear o usuário.
        metadataPromise
          .then((meta) => {
            placeholder.title = meta.title;
            placeholder.url = meta.url;
            placeholder.uploader = meta.uploader;
            placeholder.thumbnail = meta.thumbnail;
            placeholder.isOpus = meta.isOpus;
            placeholder.duration = meta.duration;
          })
          .catch((err) => {
            state.queue = state.queue.filter((s) => s !== placeholder);
            message
              .reply(err.message || "Deu erro ao buscar a música.")
              .catch(() => {});
          });
        message
          .reply(
            `🔍 Buscando **${query}**... entro na fila assim que resolver.`,
          )
          .catch(() => {});
        prefetchProxima(state);
      }
    }
  } catch (error) {
    console.error("Erro no processamento:", error);
    savePlayLog(
      guildId,
      message.author.id,
      query,
      null,
      "FAILED",
      error.message,
    );
    message.reply(error.message || "Deu erro ao buscar a música ou playlist.");
  }
}

async function playNow(message, query) {
  const voiceChannel = message.member.voice.channel;
  if (!voiceChannel) return message.reply("Entra num canal de voz primeiro!");

  const guildId = message.guild.id;
  let state = states.get(guildId);

  if (!state) {
    return play(message, query);
  }

  try {
    if (isPlaylistUrl(query)) {
      message.reply(
        "🔍 Processando fura-fila de playlist... Isso pode levar alguns segundos.",
      );
      const { playlistTitle, songs } = await getPlaylistMetadata(query);

      if (!songs || songs.length === 0) {
        return message.reply(
          "❌ Não encontrei nenhuma música válida nessa playlist.",
        );
      }

      const espacoLivre = Math.max(0, MAX_QUEUE - state.queue.length);
      if (espacoLivre <= 0) {
        return message.reply(`❌ A fila está cheia (limite de ${MAX_QUEUE}).`);
      }
      const paraAdicionar = songs.slice(0, espacoLivre);

      paraAdicionar.reverse().forEach((song) => {
        song.requestedBy = message.author.id;
        song.query = song.url;
        song.isOpus = song.isOpus ?? null;

        if (state.queue.length <= 1) {
          state.queue.push(song);
        } else {
          state.queue.splice(1, 0, song);
        }
      });

      const avisoLimite =
        songs.length > paraAdicionar.length
          ? ` (limite de ${MAX_QUEUE} — ${songs.length - paraAdicionar.length} ficaram de fora)`
          : "";
      message.reply(
        `⚡ **Fura-Fila:** **${paraAdicionar.length} músicas** da playlist **"${playlistTitle}"** foram colocadas no topo da fila!${avisoLimite}`,
      );
    } else {
      if (state.queue.length >= MAX_QUEUE) {
        return message.reply(`❌ A fila está cheia (limite de ${MAX_QUEUE}).`);
      }
      const metadata = await getAudioMetadata(query);
      metadata.requestedBy = message.author.id;
      metadata.query = query;

      if (state.queue.length <= 1) {
        state.queue.push(metadata);
      } else {
        state.queue.splice(1, 0, metadata);
      }

      message.reply(
        `⚡ **Fura-Fila:** **${metadata.title}** foi adicionada para ser a **próxima a tocar**!`,
      );
    }
  } catch (error) {
    console.error("Erro no playNow:", error);
    savePlayLog(
      guildId,
      message.author.id,
      query,
      null,
      "FAILED",
      error.message,
    );
    message.reply(error.message || "Deu erro ao processar o fura-fila.");
  }
}

function stop(guildId) {
  const state = states.get(guildId);
  if (!state) return;
  limparTimersProgresso(state);
  pararStreamAtual(state);
  state.queue = [];
  state.current = null;
  state.player.stop();
  if (state.connection.state.status !== "destroyed") {
    state.connection.destroy();
  }
  states.delete(guildId);
}

// Desconecta e limpa tudo quando o canal de voz esvazia ou o bot desliga.
// Reaproveitado pelo voiceStateUpdate e pelo shutdown gracioso.
function cleanupVoiceState(guildId) {
  const state = states.get(guildId);
  if (!state) return false;
  limparTimersProgresso(state);
  pararStreamAtual(state);
  try {
    if (state.player) state.player.stop(true);
  } catch (err) {
    // Player já parado — nada a fazer.
  }
  try {
    if (state.connection) state.connection.destroy();
  } catch (err) {
    console.error("Erro ao destruir conexão:", err);
  }
  states.delete(guildId);
  return true;
}

function skip(guildId) {
  const state = states.get(guildId);
  if (!state || !state.current) return false;
  // O stream antigo é morto dentro de iniciarReproducao quando a próxima
  // faixa começa; o player.stop() aqui dispara o stateChange -> idle.
  state.player.stop();
  return true;
}

// Retorna 'pausado' | 'ja_pausado' | 'nada_tocando'
function pause(guildId) {
  const state = states.get(guildId);
  if (!state || !state.current) return "nada_tocando";
  if (state.player.state.status === "paused") return "ja_pausado";
  const ok = state.player.pause();
  if (ok) state.pausedAt = Date.now();
  return ok ? "pausado" : "nada_tocando";
}

// Retorna 'retomado' | 'nao_pausado' | 'nada_tocando'
function resume(guildId) {
  const state = states.get(guildId);
  if (!state || !state.current) return "nada_tocando";
  if (state.player.state.status !== "paused") return "nao_pausado";
  const ok = state.player.unpause();
  if (ok && state.pausedAt) {
    state.totalPausedMs =
      (state.totalPausedMs || 0) + (Date.now() - state.pausedAt);
    state.pausedAt = null;
  }
  return ok ? "retomado" : "nada_tocando";
}

function toggleAutoplay(guildId) {
  const state = states.get(guildId);
  if (!state) return null;
  state.autoplay = !state.autoplay;
  return state.autoplay;
}

// Loop da faixa atual: ao terminar, retoca do zero em vez de avançar a fila.
// Custo zero de CPU/RAM (só um boolean + reuso do path de restart).
function toggleLoop(guildId) {
  const state = states.get(guildId);
  if (!state) return null;
  state.loop = !state.loop;
  return state.loop;
}

// Move uma faixa dentro da fila (posições do !queue: 1 = primeira após a atual).
// Retorna { title } ou { error: '...' }. Sem custo extra: só splice no array.
function moverNaFila(guildId, de, para) {
  const state = states.get(guildId);
  if (!state || state.queue.length <= 1) return { error: "fila_vazia" };
  const max = state.queue.length - 1;
  if (
    !Number.isInteger(de) ||
    !Number.isInteger(para) ||
    de < 1 ||
    de > max ||
    para < 1 ||
    para > max
  ) {
    return { error: "fora_dos_limites", total: max };
  }
  if (de === para) return { error: "mesma_posicao" };
  const [faixa] = state.queue.splice(de, 1);
  state.queue.splice(para, 0, faixa);
  return { title: faixa.title || "Faixa sem título" };
}

function restart(guildId) {
  const state = states.get(guildId);
  if (!state || !state.current) return false;
  state.queue.unshift(state.current);
  state.player.stop();
  return true;
}

function adicionarAosCurtidos(userId, track) {
  return new Promise((resolve, reject) => {
    playlistDb.run(
      `INSERT OR IGNORE INTO playlists (user_id, name) VALUES (?, 'Curtidas')`,
      [userId],
      function (err) {
        if (err) return reject(err);

        playlistDb.get(
          `SELECT id FROM playlists WHERE user_id = ? AND name = 'Curtidas'`,
          [userId],
          (err, playlist) => {
            if (err) return reject(err);
            if (!playlist) return reject(new Error("Playlist não encontrada."));

            const playlistId = playlist.id;

            playlistDb.get(
              `SELECT id FROM playlist_tracks WHERE playlist_id = ? AND url = ?`,
              [playlistId, track.url],
              (err, trackExiste) => {
                if (err) return reject(err);
                if (trackExiste)
                  return resolve({ status: "existe", title: track.title });

                playlistDb.get(
                  `SELECT COALESCE(MAX(position), 0) as maxPos FROM playlist_tracks WHERE playlist_id = ?`,
                  [playlistId],
                  (err, row) => {
                    if (err) return reject(err);
                    const proximaPosicao = row.maxPos + 1;

                    playlistDb.run(
                      `INSERT INTO playlist_tracks (playlist_id, title, url, thumbnail, uploader, position) 
                                             VALUES (?, ?, ?, ?, ?, ?)`,
                      [
                        playlistId,
                        track.title,
                        track.url,
                        track.thumbnail || null,
                        track.uploader || null,
                        proximaPosicao,
                      ],
                      (err) => {
                        if (err) return reject(err);
                        resolve({ status: "adicionado", title: track.title });
                      },
                    );
                  },
                );
              },
            );
          },
        );
      },
    );
  });
}

// Certifique-se de que a playlistDb está importada no topo do manager.js
// const { playlistDb } = require('../../db/sqlite.js');
// const { getAudioMetadata } = require('./manager.js'); (ou como estiver aí)

// 1. Criar uma Playlist
function criarPlaylist(userId, name) {
  return new Promise((resolve, reject) => {
    playlistDb.run(
      `INSERT INTO playlists (user_id, name) VALUES (?, ?)`,
      [userId, name],
      function (err) {
        if (err) {
          if (err.message.includes("UNIQUE"))
            return resolve({ status: "existe" });
          return reject(err);
        }
        resolve({ status: "criado" });
      },
    );
  });
}

// 2. Excluir uma Playlist (O ON DELETE CASCADE deleta todas as músicas dela automaticamente)
function excluirPlaylist(userId, name) {
  return new Promise((resolve, reject) => {
    playlistDb.run(
      `DELETE FROM playlists WHERE user_id = ? AND name = ?`,
      [userId, name],
      function (err) {
        if (err) return reject(err);
        resolve(this.changes > 0); // Retorna true se deletou algo
      },
    );
  });
}

// 3. Renomear uma Playlist
function renomearPlaylist(userId, oldName, newName) {
  return new Promise((resolve, reject) => {
    playlistDb.run(
      `UPDATE playlists SET name = ? WHERE user_id = ? AND name = ?`,
      [newName, userId, oldName],
      function (err) {
        if (err) {
          if (err.message.includes("UNIQUE"))
            return resolve({ status: "duplicado" });
          return reject(err);
        }
        resolve({ status: this.changes > 0 ? "sucesso" : "nao_encontrada" });
      },
    );
  });
}

// 4. Adicionar Música na Playlist por Nome/URL
async function adicionarFaixaPlaylist(userId, playlistName, query) {
  // Busca os metadados usando o resolvedor robusto do yt-dlp que arrumamos
  const track = await getAudioMetadata(query);

  return new Promise((resolve, reject) => {
    // Busca o ID da playlist
    playlistDb.get(
      `SELECT id FROM playlists WHERE user_id = ? AND name = ?`,
      [userId, playlistName],
      (err, playlist) => {
        if (err) return reject(err);
        if (!playlist) return resolve({ status: "playlist_nao_encontrada" });

        const playlistId = playlist.id;

        // Verifica se a música já existe nela
        playlistDb.get(
          `SELECT id FROM playlist_tracks WHERE playlist_id = ? AND url = ?`,
          [playlistId, track.url],
          (err, existe) => {
            if (err) return reject(err);
            if (existe)
              return resolve({ status: "ja_existe", title: track.title });

            // Pega a última posição para empurrar pro final da lista
            playlistDb.get(
              `SELECT COALESCE(MAX(position), 0) as maxPos FROM playlist_tracks WHERE playlist_id = ?`,
              [playlistId],
              (err, row) => {
                if (err) return reject(err);
                const proximaPosicao = row.maxPos + 1;

                playlistDb.run(
                  `INSERT INTO playlist_tracks (playlist_id, title, url, thumbnail, uploader, duration, position) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                  [
                    playlistId,
                    track.title,
                    track.url,
                    track.thumbnail,
                    track.uploader,
                    track.duration,
                    proximaPosicao,
                  ],
                  (err) => {
                    if (err) return reject(err);
                    resolve({
                      status: "adicionado",
                      title: track.title,
                      pos: proximaPosicao,
                    });
                  },
                );
              },
            );
          },
        );
      },
    );
  });
}

// 5. Remover Música da Playlist por Posição (e reorganizar os números das outras)
function removerFaixaPlaylist(userId, playlistName, posicao) {
  return new Promise((resolve, reject) => {
    playlistDb.get(
      `SELECT id FROM playlists WHERE user_id = ? AND name = ?`,
      [userId, playlistName],
      (err, playlist) => {
        if (err) return reject(err);
        if (!playlist) return resolve({ status: "playlist_nao_encontrada" });

        const playlistId = playlist.id;

        // Verifica se a música existe naquela posição
        playlistDb.get(
          `SELECT title FROM playlist_tracks WHERE playlist_id = ? AND position = ?`,
          [playlistId, posicao],
          (err, track) => {
            if (err) return reject(err);
            if (!track) return resolve({ status: "posicao_invalida" });

            // Encadeia via callbacks: só resolve DEPOIS que DELETE +
            // UPDATE terminarem (o código antigo resolvia antes).
            playlistDb.run(
              `DELETE FROM playlist_tracks WHERE playlist_id = ? AND position = ?`,
              [playlistId, posicao],
              (err) => {
                if (err) return reject(err);
                // Ajusta a posição de todas as músicas que vinham depois dela (-1) para não deixar buracos na numeração
                playlistDb.run(
                  `UPDATE playlist_tracks SET position = position - 1 WHERE playlist_id = ? AND position > ?`,
                  [playlistId, posicao],
                  (err) => {
                    if (err) return reject(err);
                    resolve({ status: "removido", title: track.title });
                  },
                );
              },
            );
          },
        );
      },
    );
  });
}

function moverFaixaPlaylist(userId, playlistName, oldPos, newPos) {
  return new Promise((resolve, reject) => {
    playlistDb.get(
      `SELECT id FROM playlists WHERE user_id = ? AND name = ?`,
      [userId, playlistName],
      (err, playlist) => {
        if (err) return reject(err);
        if (!playlist) return resolve({ status: "playlist_nao_encontrada" });

        const playlistId = playlist.id;

        playlistDb.get(
          `SELECT COUNT(*) as total FROM playlist_tracks WHERE playlist_id = ?`,
          [playlistId],
          (err, row) => {
            if (err) return reject(err);
            if (
              oldPos < 1 ||
              oldPos > row.total ||
              newPos < 1 ||
              newPos > row.total
            ) {
              return resolve({ status: "fora_dos_limites", total: row.total });
            }

            if (oldPos === newPos) return resolve({ status: "mesma_posicao" });
            playlistDb.serialize(() => {
              playlistDb.run(
                `UPDATE playlist_tracks SET position = -1 WHERE playlist_id = ? AND position = ?`,
                [playlistId, oldPos],
              );

              if (oldPos > newPos) {
                playlistDb.run(
                  `UPDATE playlist_tracks SET position = position + 1 WHERE playlist_id = ? AND position >= ? AND position < ?`,
                  [playlistId, newPos, oldPos],
                );
              } else {
                playlistDb.run(
                  `UPDATE playlist_tracks SET position = position - 1 WHERE playlist_id = ? AND position > ? AND position <= ?`,
                  [playlistId, oldPos, newPos],
                );
              }
              playlistDb.run(
                `UPDATE playlist_tracks SET position = ? WHERE playlist_id = ? AND position = -1`,
                [newPos, playlistId],
                (err) => {
                  if (err) return reject(err);
                  resolve({ status: "sucesso" });
                },
              );
            });
          },
        );
      },
    );
  });
}

function listarPlaylist(userId, playlistName) {
  return new Promise((resolve, reject) => {
    playlistDb.get(
      `SELECT id FROM playlists WHERE user_id = ? AND name = ?`,
      [userId, playlistName],
      (err, playlist) => {
        if (err) return reject(err);
        if (!playlist) return resolve(null);

        playlistDb.all(
          `SELECT title, position FROM playlist_tracks WHERE playlist_id = ? ORDER BY position ASC`,
          [playlist.id],
          (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
          },
        );
      },
    );
  });
}

function tocarPlaylist(message, userId, playlistName) {
  return new Promise((resolve, reject) => {
    playlistDb.get(
      `SELECT id FROM playlists WHERE user_id = ? AND name = ?`,
      [userId, playlistName],
      (err, playlist) => {
        if (err) return reject(err);
        if (!playlist) return resolve(false);
        playlistDb.all(
          `SELECT * FROM playlist_tracks WHERE playlist_id = ? ORDER BY position ASC`,
          [playlist.id],
          async (err, tracks) => {
            if (err) return reject(err);
            if (tracks.length === 0) return resolve(false);
            try {
              // Toca a 1ª faixa e espera a sessão existir antes de
              // enfileirar o resto — sem o setTimeout(1000) antigo,
              // que perdia faixas se o play() demorasse mais que isso.
              const [primeiraFaixa, ...resto] = tracks;
              await play(message, primeiraFaixa.url);

              const guildId = message.guild.id;
              const state = states.get(guildId);
              if (!state) return resolve(false);

              const espacoLivre = Math.max(0, MAX_QUEUE - state.queue.length);
              const paraAdicionar = resto.slice(0, espacoLivre);
              paraAdicionar.forEach((track) => {
                state.queue.push({
                  title: track.title,
                  url: track.url,
                  thumbnail: track.thumbnail,
                  uploader: track.uploader,
                  duration: track.duration,
                  isOpus: null,
                  query: track.url,
                  requestedBy: message.author.id,
                });
              });
              resolve(true);
            } catch (playErr) {
              reject(playErr);
            }
          },
        );
      },
    );
  });
}

function listarTodasPlaylists(userId) {
  return new Promise((resolve, reject) => {
    playlistDb.all(
      `SELECT p.name, COUNT(t.id) as total_musicas 
             FROM playlists p 
             LEFT JOIN playlist_tracks t ON p.id = t.playlist_id 
             WHERE p.user_id = ? 
             GROUP BY p.id`,
      [userId],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows); // Retorna um array de objetos: [{ name: 'Rock', total_musicas: 5 }]
      },
    );
  });
}

// Retorna todas as playlists do servidor agrupadas por user_id.
// Resultado: [{ user_id: '123', playlists: [{ name: 'Rock', total_musicas: 5 }, ...] }, ...]
function listarPlaylistsDoServidor() {
  return new Promise((resolve, reject) => {
    playlistDb.all(
      `SELECT p.user_id, p.name, COUNT(t.id) as total_musicas
             FROM playlists p
             LEFT JOIN playlist_tracks t ON p.id = t.playlist_id
             GROUP BY p.id
             ORDER BY p.user_id, p.name ASC`,
      [],
      (err, rows) => {
        if (err) return reject(err);
        // Agrupa por user_id
        const map = new Map();
        for (const row of rows) {
          if (!map.has(row.user_id)) map.set(row.user_id, []);
          map
            .get(row.user_id)
            .push({ name: row.name, total_musicas: row.total_musicas });
        }
        resolve(
          [...map.entries()].map(([user_id, playlists]) => ({
            user_id,
            playlists,
          })),
        );
      },
    );
  });
}

// Converte string de tempo para segundos.
// Formatos aceitos:
//   "15"         → 15 min (sem separador = minutos por convenção do bot)
//   "1:30"       → 1 min 30 s   (MM:SS ou H:MM dependendo do contexto)
//   "10:20"      → 10 min 20 s
//   "1:12:14"    → 1 h 12 min 14 s
//   "00:15"      → 15 s   (zero à esquerda indica segundos)
//   "00:00:15"   → 15 s
//
// Regra para dois segmentos (A:B):
//   Se A === 0  → resultado = B segundos  (ex: 00:15 → 15 s)
//   Caso contrário → resultado = A*60 + B segundos (ex: 10:20 → 620 s)
function parseSeekInput(input) {
  input = input.trim();

  // Sem ":" — número sozinho → minutos
  if (!input.includes(":")) {
    const n = parseInt(input, 10);
    return isNaN(n) ? null : n * 60;
  }

  const partes = input.split(":").map((p) => parseInt(p, 10));
  if (partes.some(isNaN)) return null;

  if (partes.length === 3) {
    // H:MM:SS
    const [h, m, s] = partes;
    return h * 3600 + m * 60 + s;
  }

  if (partes.length === 2) {
    const [a, b] = partes;
    // Se o primeiro segmento é 0 → só segundos (00:15 → 15 s)
    if (a === 0) return b;
    // Caso contrário → MM:SS
    return a * 60 + b;
  }

  return null;
}

// Faz seek na música atual: reinicia o stream a partir de seekSec segundos.
async function seek(guildId, seekSec, message) {
  const state = states.get(guildId);
  if (!state || !state.current) {
    return message.reply("❌ Nenhuma música tocando no momento.");
  }

  const song = state.current;
  if (song.duration && seekSec >= song.duration) {
    return message.reply("❌ Posição além da duração da música.");
  }

  const minutos = Math.floor(seekSec / 60);
  const segundos = seekSec % 60;
  const label = song.duration
    ? `${minutos}:${String(segundos).padStart(2, "0")} / ${Math.floor(song.duration / 60)}:${String(Math.floor(song.duration % 60)).padStart(2, "0")}`
    : `${minutos}:${String(segundos).padStart(2, "0")}`;

  await message.reply(`⏩ Indo para **${label}** em *${song.title}*...`);

  iniciarReproducao(state, song, true, seekSec);
  await enviarNovoPainel(state.textChannel, state, song);
}

// Remove uma música da fila pelo número exibido no !queue (1 = próxima, não a atual).
// Retorna o título da música removida, ou null se a posição for inválida.
function removeFromQueue(guildId, posicao) {
  const state = states.get(guildId);
  if (!state || state.queue.length <= 1) return null; // índice 0 é a atual

  // posicao 1 → queue[1], posicao 2 → queue[2], ...
  const idx = posicao; // já é o índice real no array (0 = atual)
  if (idx < 1 || idx >= state.queue.length) return null;

  const [removida] = state.queue.splice(idx, 1);
  return removida.title;
}

module.exports = {
  play,
  stop,
  cleanupVoiceState,
  limparTimersProgresso,
  skip,
  restart,
  pause,
  resume,
  toggleAutoplay,
  toggleLoop,
  moverNaFila,
  playNow,
  criarPainelMusical,
  calcularElapsedMs,
  adicionarAosCurtidos,
  shuffleQueue,
  removeFromQueue,
  seek,
  parseSeekInput,
  criarPlaylist,
  excluirPlaylist,
  renomearPlaylist,
  adicionarFaixaPlaylist,
  removerFaixaPlaylist,
  moverFaixaPlaylist,
  tocarPlaylist,
  listarPlaylist,
  listarTodasPlaylists,
  listarPlaylistsDoServidor,
  iniciarFaixaOtimista,
  prefetchProxima,
  garantirMetadadosCompletos,
  MAX_QUEUE,
  states,
};

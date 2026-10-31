const {
  play,
  playNow,
  stop,
  skip,
  restart,
  pause,
  resume,
  toggleAutoplay,
  toggleLoop,
  moverNaFila,
  shuffleQueue,
  removeFromQueue,
  seek,
  parseSeekInput,
  criarPainelMusical,
  calcularElapsedMs,
  getAudioFx,
  duracaoEfetiva,
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
  setBassBoost,
  setNightcore,
  states,
} = require("../music/manager");
const { criarPainelFila } = require("../utils/paineis");

// ── Adaptador slash → prefixo ─────────────────────────────────────────────
// Comandos de texto (!play, !skip, ...) recebem `message` (reply/channel/author
// + member.voice.channel + guild). Slash recebe `interaction` (outra API).
// Em vez de duplicar a lógica, este adaptador monta um "fakeMessage" com a
// mesma interface e chama a MESMA função do !comando. Uma correção no !play
// vale automaticamente para o /play.
// Retorna true se a interaction já foi respondida (não chamar followUp extra).
function fakeMessageFromInteraction(interaction, { deferred = false } = {}) {
  return {
    guild: interaction.guild,
    member: interaction.member,
    author: interaction.user,
    channel: interaction.channel,
    client: interaction.client,
    _slash: interaction,
    _deferred: deferred,
    reply: async (content) => {
      const payload = typeof content === "string" ? { content } : content;
      // Guarda o título resolvido para o handler encerrar o defer com contexto.
      const titulo =
        payload?.embeds?.[0]?.data?.title ||
        (typeof payload?.content === "string" &&
          payload.content.slice(0, 80)) ||
        null;
      if (typeof interaction._slashLastTitle === "undefined" || titulo) {
        try {
          interaction._slashLastTitle = titulo || interaction._slashLastTitle;
        } catch {}
      }
      if (deferred || interaction.deferred || interaction.replied) {
        return interaction.followUp(payload).catch(() => null);
      }
      return interaction
        .reply({ ...payload, ephemeral: true })
        .catch(() => null);
    },
  };
}

// Handlers slash espelhando os !comandos. Cada um delega para a lógica de
// texto via fakeMessageFromInteraction — sem duplicação.
// REGRA: todo caminho que chama deferReply PRECISA encerrar o "pensando" com
// editReply ou deleteReply — senão o Discord mostra "pensando" para sempre,
// mesmo com a música tocando (foi o bug do /play).
async function handleSlashPlay(interaction, searchEngine = "ytsearch") {
  const query = interaction.options.getString("musica");
  const member = interaction.member;
  if (!member?.voice?.channel) {
    return interaction.reply({
      content: "Entra num canal de voz primeiro!",
      ephemeral: true,
    });
  }
  // Extração leva ~8s: defer público (visível) para não estourar os 3s do Discord.
  await interaction.deferReply();
  const message = fakeMessageFromInteraction(interaction, { deferred: true });
  try {
    await play(message, query, searchEngine);
    // play() responde via message.reply (= followUp, msg separada). O defer
    // original precisa ser encerrado — edita para confirmação curta.
    const atual = message._slashLastTitle || query;
    await interaction
      .editReply(`▶️ **${atual}** — painel acima ⬆️`)
      .catch(() => {});
  } catch (err) {
    await interaction
      .editReply(err.message || "Deu erro ao buscar a música.")
      .catch(() => {});
  }
}

async function handleSlashPlayNow(interaction) {
  const query = interaction.options.getString("musica");
  if (!interaction.member?.voice?.channel) {
    return interaction.reply({
      content: "Entra num canal de voz primeiro!",
      ephemeral: true,
    });
  }
  await interaction.deferReply({ ephemeral: true });
  const message = fakeMessageFromInteraction(interaction, { deferred: true });
  try {
    await playNow(message, query);
    await interaction
      .editReply("⚡ Fura-fila processado — veja o painel.")
      .catch(() => {});
  } catch (err) {
    await interaction
      .editReply(err.message || "Deu erro ao processar o fura-fila.")
      .catch(() => {});
  }
}

async function handleSlashQueue(interaction) {
  const state = states.get(interaction.guild.id);
  if (!state) {
    return interaction.reply({
      content: "❌ Nenhuma música tocando ou na fila neste servidor.",
      ephemeral: true,
    });
  }
  const painelFila = criarPainelFila(state, 0);
  return interaction.reply({ ...painelFila, ephemeral: true });
}

async function handleSlashHistory(interaction, criarPainelHistorico) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const painelHistorico = await criarPainelHistorico(interaction.guild.id, 0);
    await interaction.editReply(painelHistorico);
  } catch (error) {
    console.error("Erro ao carregar histórico:", error);
    await interaction.editReply(
      "❌ Não foi possível carregar o histórico de músicas.",
    );
  }
}

async function handleSlashNp(interaction) {
  const state = states.get(interaction.guild.id);
  if (!state || !state.current) {
    return interaction.reply({
      content: "❌ Nenhuma música tocando no momento.",
      ephemeral: true,
    });
  }
  const elapsedSec = Math.floor(calcularElapsedMs(state) / 1000);
  const fx = getAudioFx(state);
  const painel = criarPainelMusical(state.current, elapsedSec, {
    autoplay: !!state.autoplay,
    loop: !!state.loop,
    bassDb: fx.bassDb,
    nightcore: fx.nightcore,
    duracaoEfetiva: duracaoEfetiva(state.current, state),
  });
  return interaction.reply({ ...painel, ephemeral: false });
}

async function handleSlashSeek(interaction) {
  const raw = interaction.options.getString("tempo");
  const seekSec = parseSeekInput(raw);
  if (seekSec === null || seekSec < 0) {
    return interaction.reply({
      content:
        "❌ Tempo inválido. Use formatos como `10:20`, `1:12:14`, `00:15` ou `15`.",
      ephemeral: true,
    });
  }
  await interaction.deferReply({ ephemeral: true });
  const message = fakeMessageFromInteraction(interaction, { deferred: true });
  try {
    await seek(interaction.guild.id, seekSec, message);
    // seek() já respondeu via followUp; encerra o "pensando".
    await interaction.deleteReply().catch(() => {});
  } catch (err) {
    await interaction
      .editReply(err.message || "Deu erro no seek.")
      .catch(() => {});
  }
}

async function handleSlashPlaylists(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === "minhas") {
    const playlists = await listarTodasPlaylists(interaction.user.id);
    if (!playlists || playlists.length === 0) {
      return interaction.reply({
        content:
          "📭 Você ainda não tem nenhuma playlist. Use `/playlist criar` para começar!",
        ephemeral: true,
      });
    }
    const lista = playlists
      .map((p) =>
        p.name.toLowerCase() === "curtidas"
          ? `❤️ **${p.name}** (${p.total_musicas} músicas)`
          : `📁 **${p.name}** (${p.total_musicas} músicas)`,
      )
      .join("\n");
    return interaction.reply({
      content: `📋 **Suas playlists:**\n\n${lista}\n\n*Para tocar: \`/playlist tocar\`*`,
      ephemeral: true,
    });
  }
  if (sub === "servidor") {
    await interaction.deferReply({ ephemeral: true });
    const grupos = await listarPlaylistsDoServidor();
    if (!grupos || grupos.length === 0) {
      return interaction.editReply(
        "📭 Nenhuma playlist criada no servidor ainda.",
      );
    }
    const linhas = [];
    for (const { user_id, playlists } of grupos) {
      const membro = interaction.guild.members.cache.get(user_id);
      const nome = membro ? membro.displayName : `<@${user_id}>`;
      const itens = playlists
        .map((p) =>
          p.name.toLowerCase() === "curtidas"
            ? `❤️ ${p.name} (${p.total_musicas})`
            : `📁 ${p.name} (${p.total_musicas})`,
        )
        .join("  ·  ");
      linhas.push(`**${nome}** — ${itens}`);
    }
    return interaction.editReply(
      `📋 **Playlists do servidor:**\n\n${linhas.join("\n")}`,
    );
  }
  if (sub === "de") {
    const alvo = interaction.options.getUser("usuario");
    const playlists = await listarTodasPlaylists(alvo.id);
    if (!playlists || playlists.length === 0) {
      return interaction.reply({
        content: `📭 **${alvo.displayName ?? alvo.username}** ainda não tem nenhuma playlist criada.`,
        ephemeral: true,
      });
    }
    const lista = playlists
      .map((p) =>
        p.name.toLowerCase() === "curtidas"
          ? `❤️ **${p.name}** (${p.total_musicas} músicas)`
          : `📁 **${p.name}** (${p.total_musicas} músicas)`,
      )
      .join("\n");
    return interaction.reply({
      content: `📋 **Playlists de ${alvo.displayName ?? alvo.username}:**\n\n${lista}\n\n*Para tocar: \`/playlist tocar nome:"Nome" usuario:@${alvo.username}\`*`,
      ephemeral: true,
    });
  }
}

async function handleSlashPlaylist(interaction) {
  const subCommand = interaction.options.getSubcommand();
  const userId = interaction.user.id;

  switch (subCommand) {
    case "criar": {
      const name = interaction.options.getString("nome");
      const res = await criarPlaylist(userId, name);
      if (res.status === "existe")
        return interaction.reply({
          content: `ℹ️ Você já tem uma playlist chamada **${name}**.`,
          ephemeral: true,
        });
      return interaction.reply({
        content: `✅ Playlist **${name}** criada com sucesso!`,
        ephemeral: true,
      });
    }

    case "excluir": {
      const name = interaction.options.getString("nome");
      if (name.toLowerCase() === "curtidas")
        return interaction.reply({
          content: "⚠️ A playlist de **Curtidas** é protegida pelo sistema.",
          ephemeral: true,
        });
      const deletado = await excluirPlaylist(userId, name);
      if (!deletado)
        return interaction.reply({
          content: "❌ Você não possui nenhuma playlist com esse nome.",
          ephemeral: true,
        });
      return interaction.reply({
        content: `🗑️ Playlist **${name}** excluída com sucesso.`,
        ephemeral: true,
      });
    }

    case "renomear": {
      const oldName = interaction.options.getString("antigo");
      const newName = interaction.options.getString("novo");
      if (oldName.toLowerCase() === "curtidas")
        return interaction.reply({
          content: "⚠️ A playlist de **Curtidas** não pode ser renomeada.",
          ephemeral: true,
        });
      const res = await renomearPlaylist(userId, oldName, newName);
      if (res.status === "duplicado")
        return interaction.reply({
          content: `❌ Você já tem outra playlist chamada **${newName}**.`,
          ephemeral: true,
        });
      if (res.status === "nao_encontrada")
        return interaction.reply({
          content: `❌ Playlist **${oldName}** não encontrada.`,
          ephemeral: true,
        });
      return interaction.reply({
        content: `🔄 Playlist renomeada de **${oldName}** para **${newName}**!`,
        ephemeral: true,
      });
    }

    case "add": {
      const playlistName = interaction.options.getString("playlist");
      const query = interaction.options.getString("musica");
      await interaction.deferReply({ ephemeral: true });
      try {
        const res = await adicionarFaixaPlaylist(userId, playlistName, query);
        if (res.status === "playlist_nao_encontrada")
          return interaction.editReply(
            `❌ Você não tem uma playlist chamada **${playlistName}**.`,
          );
        if (res.status === "ja_existe")
          return interaction.editReply(
            `ℹ️ **${res.title}** já está nessa playlist.`,
          );
        return interaction.editReply(
          `🎵 **${res.title}** adicionada à playlist **${playlistName}** na posição **#${res.pos}**!`,
        );
      } catch (err) {
        return interaction.editReply(
          "❌ Erro ao buscar ou salvar a música no banco de dados.",
        );
      }
    }

    case "remover": {
      const playlistName = interaction.options.getString("playlist");
      const posicao = interaction.options.getInteger("posicao");
      const res = await removerFaixaPlaylist(userId, playlistName, posicao);
      if (res.status === "playlist_nao_encontrada")
        return interaction.reply({
          content: `❌ Playlist **${playlistName}** não encontrada.`,
          ephemeral: true,
        });
      if (res.status === "posicao_invalida")
        return interaction.reply({
          content: "❌ Nenhuma música encontrada nessa posição da playlist.",
          ephemeral: true,
        });
      return interaction.reply({
        content: `🗑️ **${res.title}** removida com sucesso da playlist!`,
        ephemeral: true,
      });
    }

    case "mover": {
      const playlistName = interaction.options.getString("playlist");
      const dePos = interaction.options.getInteger("de");
      const paraPos = interaction.options.getInteger("para");
      const res = await moverFaixaPlaylist(
        userId,
        playlistName,
        dePos,
        paraPos,
      );
      if (res.status === "playlist_nao_encontrada")
        return interaction.reply({
          content: `❌ Playlist **${playlistName}** não encontrada.`,
          ephemeral: true,
        });
      if (res.status === "fora_dos_limites")
        return interaction.reply({
          content: `❌ Posição inválida. A playlist tem **${res.total}** músicas.`,
          ephemeral: true,
        });
      if (res.status === "mesma_posicao")
        return interaction.reply({
          content: "ℹ️ A música já está nessa posição!",
          ephemeral: true,
        });
      return interaction.reply({
        content: `🔀 Música movida da posição **#${dePos}** para a posição **#${paraPos}** com sucesso!`,
        ephemeral: true,
      });
    }

    case "listar": {
      const playlistName = interaction.options.getString("nome");
      if (!playlistName) {
        const playlists = await listarTodasPlaylists(userId);
        if (!playlists || playlists.length === 0)
          return interaction.reply({
            content: "📭 Você ainda não tem nenhuma playlist criada.",
            ephemeral: true,
          });
        const listaDePlaylists = playlists
          .map((p) =>
            p.name.toLowerCase() === "curtidas"
              ? `✨ **${p.name}** (${p.total_musicas} músicas)`
              : `📁 **${p.name}** (${p.total_musicas} músicas)`,
          )
          .join("\n");
        return interaction.reply({
          content: `📋 **Suas Playlists:**\n\n${listaDePlaylists}`,
          ephemeral: true,
        });
      }
      const faixas = await listarPlaylist(userId, playlistName);
      if (!faixas)
        return interaction.reply({
          content: `❌ Você não tem uma playlist chamada **${playlistName}**.`,
          ephemeral: true,
        });
      if (faixas.length === 0)
        return interaction.reply({
          content: `📭 A playlist **${playlistName}** está vazia.`,
          ephemeral: true,
        });
      const listaTexto = faixas
        .slice(0, 20)
        .map((f) => `**${f.position}.** ${f.title}`)
        .join("\n");
      const rodape =
        faixas.length > 20
          ? `\n*...e mais ${faixas.length - 20} músicas.*`
          : "";
      return interaction.reply({
        content: `📑 **Playlist: ${playlistName}**\n\n${listaTexto}${rodape}`,
        ephemeral: true,
      });
    }

    case "tocar": {
      const playlistName = interaction.options.getString("nome");
      const outro = interaction.options.getUser("usuario");
      const donoId =
        outro && outro.id !== interaction.user.id ? outro.id : userId;
      if (!interaction.member?.voice?.channelId) {
        return interaction.reply({
          content: "❌ Você precisa estar em um canal de voz para tocar!",
          ephemeral: true,
        });
      }
      await interaction.deferReply();
      const message = fakeMessageFromInteraction(interaction, {
        deferred: true,
      });
      const sucesso = await tocarPlaylist(message, donoId, playlistName);
      if (!sucesso)
        return interaction.editReply(
          outro && outro.id !== interaction.user.id
            ? `❌ **${outro.displayName ?? outro.username}** não tem uma playlist chamada **${playlistName}** (ou está vazia).`
            : `❌ Playlist **${playlistName}** não encontrada ou vazia.`,
        );
      const rotulo =
        outro && outro.id !== interaction.user.id
          ? `de **${outro.displayName ?? outro.username}**`
          : `**${playlistName}**`;
      return interaction.editReply(
        `▶️ Playlist ${rotulo} adicionada à fila com sucesso!`,
      );
    }
  }
}

// Roteador principal dos slash commands. Nomes espelham deploy-commands.js;
// se registrar um comando novo lá e esquecer aqui, o bot avisa em vez de
// ficar em silêncio (esse era o bug dos "slash que aparecem mas não funcionam").
async function handleSlashCommand(interaction, deps = {}) {
  const guildId = interaction.guild.id;
  const state = states.get(guildId);

  switch (interaction.commandName) {
    case "play":
      return handleSlashPlay(interaction, "ytsearch");
    case "playsc":
      return handleSlashPlay(interaction, "scsearch");
    case "playnow":
      return handleSlashPlayNow(interaction);
    case "queue":
      return handleSlashQueue(interaction);
    case "history":
      return handleSlashHistory(interaction, deps.criarPainelHistorico);
    case "np":
      return handleSlashNp(interaction);
    case "seek":
      return handleSlashSeek(interaction);
    case "playlists":
      return handleSlashPlaylists(interaction);
    case "playlist":
      return handleSlashPlaylist(interaction);

    case "stop": {
      if (!state)
        return interaction.reply({
          content: "❌ Nenhuma atividade musical neste servidor.",
          ephemeral: true,
        });
      stop(guildId);
      return interaction.reply("⏹️ Fila esvaziada, adeus.");
    }
    case "skip": {
      const pulou = skip(guildId);
      return interaction.reply({
        content: pulou
          ? "⏭️ Música pulada com sucesso!"
          : "❌ Não tem nenhuma música tocando para eu pular.",
        ephemeral: true,
      });
    }
    case "restart": {
      const reiniciou = restart(guildId);
      return interaction.reply({
        content: reiniciou
          ? "🔄 Reiniciando a música atual do começo!"
          : "❌ Não tem nenhuma música tocando para eu reiniciar.",
        ephemeral: true,
      });
    }
    case "pause": {
      const r = pause(guildId);
      return interaction.reply({
        content:
          r === "pausado"
            ? "⏸️ Música pausada."
            : r === "ja_pausado"
              ? "⏸️ Já estava pausada."
              : "❌ Não tem nenhuma música tocando para pausar.",
        ephemeral: true,
      });
    }
    case "resume": {
      const r = resume(guildId);
      return interaction.reply({
        content:
          r === "retomado"
            ? "▶️ Música retomada."
            : r === "nao_pausado"
              ? "▶️ A música já está tocando."
              : "❌ Não tem nenhuma música tocando para retomar.",
        ephemeral: true,
      });
    }
    case "autoplay": {
      const ativado = toggleAutoplay(guildId);
      if (ativado === null)
        return interaction.reply({
          content: "❌ Não há nenhuma sessão de música ativa neste servidor.",
          ephemeral: true,
        });
      return interaction.reply(
        ativado ? "📻 Autoplay **ativado**." : "📻 Autoplay **desativado**.",
      );
    }
    case "loop": {
      const ativado = toggleLoop(guildId);
      if (ativado === null)
        return interaction.reply({
          content: "❌ Não há nenhuma sessão de música ativa neste servidor.",
          ephemeral: true,
        });
      return interaction.reply(
        ativado ? "🔂 Loop **ativado**." : "🔂 Loop **desativado**.",
      );
    }
    case "bass": {
      const raw = interaction.options.getString("nivel");
      const res = setBassBoost(guildId, raw ?? undefined);
      if (res.error === "sem_sessao")
        return interaction.reply({
          content: "❌ Não há nenhuma sessão de música ativa neste servidor.",
          ephemeral: true,
        });
      if (res.error === "invalido")
        return interaction.reply({
          content: "❌ Valor inválido. Use um número em dB (ex: 8) ou deixe vazio para ligar/desligar.",
          ephemeral: true,
        });
      return interaction.reply({
        content:
          res.db === 0
            ? "🔊 Bass boost **desativado**."
            : `🔊 Bass boost **+${Number(res.db.toFixed ? res.db.toFixed(2) : res.db)}dB** — aplica na hora.`,
        ephemeral: true,
      });
    }
    case "nightcore": {
      const raw = interaction.options.getString("taxa");
      const res = setNightcore(guildId, raw ?? undefined);
      if (res.error === "sem_sessao")
        return interaction.reply({
          content: "❌ Não há nenhuma sessão de música ativa neste servidor.",
          ephemeral: true,
        });
      if (res.error === "invalido")
        return interaction.reply({
          content: "❌ Valor inválido. Use uma taxa de 0.5 a 3 (ex: 1.25) ou deixe vazio para ligar/desligar.",
          ephemeral: true,
        });
      return interaction.reply({
        content:
          res.rate === 1
            ? "⚡ Nightcore **desativado**."
            : `⚡ Nightcore **${Number(res.rate.toFixed ? res.rate.toFixed(2) : res.rate)}x** — a faixa anda mais rápido.`,
        ephemeral: true,
      });
    }
    case "remove": {
      const posicao = interaction.options.getInteger("posicao");
      const titulo = removeFromQueue(guildId, posicao);
      return interaction.reply({
        content: titulo
          ? `🗑️ **${titulo}** (posição #${posicao}) removida da fila.`
          : "❌ Posição inválida. Veja os números com `/queue`.",
        ephemeral: true,
      });
    }
    case "move": {
      const de = interaction.options.getInteger("de");
      const para = interaction.options.getInteger("para");
      const res = moverNaFila(guildId, de, para);
      if (res.error === "fila_vazia")
        return interaction.reply({
          content: "❌ Não há músicas na fila para mover.",
          ephemeral: true,
        });
      if (res.error === "fora_dos_limites")
        return interaction.reply({
          content: `❌ Posição inválida. A fila tem **${res.total}** música(s) após a atual.`,
          ephemeral: true,
        });
      if (res.error === "mesma_posicao")
        return interaction.reply({
          content: "ℹ️ A música já está nessa posição!",
          ephemeral: true,
        });
      return interaction.reply({
        content: `🔀 **${res.title}** movida da posição **#${de}** para **#${para}**!`,
        ephemeral: true,
      });
    }
    case "shuffle": {
      const ok = shuffleQueue(guildId);
      return interaction.reply({
        content: ok
          ? "🔀 **Fila embaralhada com sucesso!**"
          : "❌ Não há músicas suficientes na fila para embaralhar.",
        ephemeral: true,
      });
    }
    default:
      return interaction.reply({
        content: `❌ Comando \`/${interaction.commandName}\` registrado mas sem handler. Avise o dono do bot.`,
        ephemeral: true,
      });
  }
}

module.exports = { handleSlashCommand };

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const { exec } = require("child_process");
const { TOKEN, GUILDS, OWNER_IDS } = require("./config/env");
const {
  play,
  stop,
  cleanupVoiceState,
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
  tocarSfxEntrada,
  states,
} = require("./music/manager");
const {
  parseOwnerIds,
  isJoinNoCanalDoBot,
  checkSfxTiming,
  markSfxFired,
  sortearSfxPcm,
  preloadSfxPcm,
} = require("./music/sfx");
const { logsDb, playlistDb } = require("./config/sqlite");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

client.once("clientReady", () => {
  console.log(`Bot online como ${client.user.tag}`);
  try {
    preloadSfxPcm();
  } catch (err) {
    console.error("SFX: falha no preload (sem som):", err.message);
  }
  client.guilds.cache.forEach((guild) => {
    if (!GUILDS.includes(guild.id)) {
      console.log(`Saindo da guilda: ${guild.name}`);
      guild.leave();
    }
  });
});

function criarPainelFila(state, pagina = 0) {
  const { queue, current } = state;
  const itensPorPagina = 10;
  const totalPaginas = Math.ceil((queue.length - 1) / itensPorPagina);

  const embed = new EmbedBuilder()
    .setColor("#5865F2")
    .setTitle("📋 Fila de Reprodução");

  if (!current && queue.length === 0) {
    embed.setDescription("A fila está completamente vazia.");
    return { embeds: [embed], components: [] };
  }
  // Autoplay tem requestedBy null — evita renderizar <@null> / <@undefined>.
  const rotuloPedido = (faixa) =>
    faixa && faixa.requestedBy ? `<@${faixa.requestedBy}>` : "📻 Autoplay";
  let descricao = `**Tocando Agora:**\n🔹 [${current.title}](${current.url}) | ${rotuloPedido(current)}\n\n`;

  if (queue.length > 1) {
    descricao += `**Próximas Músicas:**\n`;
    const inicio = 1 + pagina * itensPorPagina;
    const fim = Math.min(inicio + itensPorPagina, queue.length);

    for (let i = inicio; i < fim; i++) {
      descricao += `\`${i}.\` [${queue[i].title}](${queue[i].url}) | ${rotuloPedido(queue[i])}\n`;
    }

    embed.setFooter({
      text: `Página ${pagina + 1} de ${totalPaginas || 1} • Total de ${queue.length - 1} músicas na fila`,
    });
  } else {
    descricao += "_Não há mais músicas na fila._";
    embed.setFooter({ text: "Nenhuma música na fila" });
  }

  embed.setDescription(descricao);

  // Criação dos botões de paginação
  const row = new ActionRowBuilder();

  if (totalPaginas > 1) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`queue_prev_${pagina}`)
        .setLabel("◀️")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(pagina === 0),
      new ButtonBuilder()
        .setCustomId(`queue_goto_${pagina}_${totalPaginas}`)
        .setLabel("🔢 Ir para...")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`queue_next_${pagina}`)
        .setLabel("▶️")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(pagina >= totalPaginas - 1),
    );
    return { embeds: [embed], components: [row] };
  }

  return { embeds: [embed], components: [] };
}

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

async function handleSlashHistory(interaction) {
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
  const painel = criarPainelMusical(state.current, elapsedSec, {
    autoplay: !!state.autoplay,
    loop: !!state.loop,
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
async function handleSlashCommand(interaction) {
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
      return handleSlashHistory(interaction);
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

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;
  // Aceita !playnow e !playnext (o código antigo só removia "!playnow",
  // então "!playnext <q>" chegava ao playNow com o prefixo junto).
  const playNowMatch = message.content.match(/^!play(?:now|next)\s*/);
  if (playNowMatch) {
    const query = message.content.slice(playNowMatch[0].length).trim();
    if (!query)
      return message.reply("Nome ou o link da música que vai furar a fila!");
    return playNow(message, query);
  }

  // ── Playlists de outros membros ────────────────────────────────────────────

  // !playlists servidor  →  apanhado geral de todas as playlists do servidor
  if (
    message.content === "!playlists servidor" ||
    message.content === "!playlists server"
  ) {
    const grupos = await listarPlaylistsDoServidor();

    if (!grupos || grupos.length === 0) {
      return message.reply("📭 Nenhuma playlist criada no servidor ainda.");
    }

    // Resolve nomes de usuário via cache do guild (sem precisar de fetch extra)
    const linhas = [];
    for (const { user_id, playlists } of grupos) {
      const membro = message.guild.members.cache.get(user_id);
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

    // Discord limita embeds a 4096 chars; manda em blocos se necessário
    const cabecalho = "📋 **Playlists do servidor:**\n\n";
    const corpo = linhas.join("\n");
    const rodape =
      '\n\n*Use `!playlists @usuario` para ver detalhes · `!playlist tocar @usuario "Nome"` para tocar*';

    const mensagem = cabecalho + corpo + rodape;
    if (mensagem.length <= 2000) {
      return message.reply(mensagem);
    }

    // Muito longo: divide em partes
    let parte = cabecalho;
    for (const linha of linhas) {
      if ((parte + linha + "\n").length > 1950) {
        await message.channel.send(parte.trimEnd());
        parte = "";
      }
      parte += linha + "\n";
    }
    if (parte.trim()) await message.channel.send(parte.trimEnd());
    return message.channel.send(rodape.trim());
  }

  // !playlists @usuario  →  lista as playlists de outro membro
  if (message.content.startsWith("!playlists")) {
    const mencionado = message.mentions.users.first();

    // Se não mencionou ninguém, redireciona para o próprio usuário
    if (!mencionado || mencionado.id === message.author.id) {
      const playlists = await listarTodasPlaylists(message.author.id);
      if (!playlists || playlists.length === 0) {
        return message.reply(
          '📭 Você ainda não tem nenhuma playlist. Use `!playlist criar "Nome"` para começar!',
        );
      }
      const lista = playlists
        .map((p) =>
          p.name.toLowerCase() === "curtidas"
            ? `❤️ **${p.name}** (${p.total_musicas} músicas)`
            : `📁 **${p.name}** (${p.total_musicas} músicas)`,
        )
        .join("\n");
      return message.reply(
        `📋 **Suas playlists:**\n\n${lista}\n\n*Para tocar: \`!playlist tocar "Nome"\`*`,
      );
    }

    // Listando playlists de outra pessoa
    const playlists = await listarTodasPlaylists(mencionado.id);
    if (!playlists || playlists.length === 0) {
      return message.reply(
        `📭 **${mencionado.displayName}** ainda não tem nenhuma playlist criada.`,
      );
    }
    const lista = playlists
      .map((p) =>
        p.name.toLowerCase() === "curtidas"
          ? `❤️ **${p.name}** (${p.total_musicas} músicas)`
          : `📁 **${p.name}** (${p.total_musicas} músicas)`,
      )
      .join("\n");
    return message.reply(
      `📋 **Playlists de ${mencionado.displayName}:**\n\n${lista}\n\n` +
        `*Para tocar: \`!playlist tocar @${mencionado.username} "Nome"\`*`,
    );
  }

  if (message.content.startsWith("!playlist")) {
    const args = message.content
      .trim()
      .match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
      .map((arg) => arg.replace(/^["']|["']$/g, ""));
    args.shift();

    const subCommand = args[0]?.toLowerCase();
    const userId = message.author.id;

    if (!subCommand) {
      return message.reply(
        "📋 **Guia de Playlists:**\n" +
          '• `!playlist criar "Nome"`\n' +
          '• `!playlist excluir "Nome"`\n' +
          '• `!playlist renomear "Nome Antigo" "Nome Novo"`\n' +
          '• `!playlist add "Nome" <Link/Busca>`\n' +
          '• `!playlist remover "Nome" <Posição>`\n' +
          '• `!playlist mover "Nome" <Posição Atual> <Nova Posição>`\n' +
          '• `!playlist listar "Nome"`\n' +
          '• `!playlist tocar "Nome"`',
      );
    }

    switch (subCommand) {
      case "criar": {
        const name = args[1];
        if (!name)
          return message.reply(
            '❌ Digite o nome da playlist. Ex: `!playlist criar "Rock"`',
          );

        const res = await criarPlaylist(userId, name);
        if (res.status === "existe")
          return message.reply(
            `ℹ️ Você já tem uma playlist chamada **${name}**.`,
          );
        return message.reply(`✅ Playlist **${name}** criada com sucesso!`);
      }

      case "excluir": {
        const name = args[1];
        if (!name)
          return message.reply("❌ Digite o nome da playlist a ser excluída.");
        if (name.toLowerCase() === "curtidas")
          return message.reply(
            "⚠️ A playlist de **Curtidas** é protegida pelo sistema.",
          );

        const deletado = await excluirPlaylist(userId, name);
        if (!deletado)
          return message.reply(
            "❌ Você não possui nenhuma playlist com esse nome.",
          );
        return message.reply(`🗑️ Playlist **${name}** excluída com sucesso.`);
      }

      case "renomear": {
        const oldName = args[1];
        const newName = args[2];
        if (!oldName || !newName)
          return message.reply(
            '❌ Use: `!playlist renomear "Nome Antigo" "Nome Novo"`',
          );
        if (oldName.toLowerCase() === "curtidas")
          return message.reply(
            "⚠️ A playlist de **Curtidas** não pode ser renomeada.",
          );

        const res = await renomearPlaylist(userId, oldName, newName);
        if (res.status === "duplicado")
          return message.reply(
            `❌ Você já tem outra playlist chamada **${newName}**.`,
          );
        if (res.status === "nao_encontrada")
          return message.reply(`❌ Playlist **${oldName}** não encontrada.`);
        return message.reply(
          `🔄 Playlist renomeada de **${oldName}** para **${newName}**!`,
        );
      }

      case "add": {
        const playlistName = args[1];
        const query = args.slice(2).join(" ");
        if (!playlistName || !query)
          return message.reply(
            '❌ Use: `!playlist add "Nome" <Link ou Nome da música>`',
          );

        const msgAviso = await message.reply(
          "🔍 Buscando dados da faixa... Aguarde.",
        );
        try {
          const res = await adicionarFaixaPlaylist(userId, playlistName, query);
          if (res.status === "playlist_nao_encontrada")
            return msgAviso.edit(
              `❌ Você não tem uma playlist chamada **${playlistName}**.`,
            );
          if (res.status === "ja_existe")
            return msgAviso.edit(`ℹ️ **${res.title}** já está nessa playlist.`);
          return msgAviso.edit(
            `🎵 **${res.title}** adicionada à playlist **${playlistName}** na posição **#${res.pos}**!`,
          );
        } catch (err) {
          return msgAviso.edit("❌ Erro ao buscar ou salvar a música.");
        }
      }

      case "remover": {
        const playlistName = args[1];
        const posicao = parseInt(args[2]);
        if (!playlistName || isNaN(posicao))
          return message.reply(
            '❌ Use: `!playlist remover "Nome" <Número da Posição>`',
          );

        const res = await removerFaixaPlaylist(userId, playlistName, posicao);
        if (res.status === "playlist_nao_encontrada")
          return message.reply(
            `❌ Playlist **${playlistName}** não encontrada.`,
          );
        if (res.status === "posicao_invalida")
          return message.reply(
            "❌ Nenhuma música encontrada nessa posição da playlist.",
          );
        return message.reply(
          `🗑️ **${res.title}** removida com sucesso da playlist!`,
        );
      }

      case "mover": {
        const playlistName = args[1];
        const dePos = parseInt(args[2]);
        const paraPos = parseInt(args[3]);
        if (!playlistName || isNaN(dePos) || isNaN(paraPos))
          return message.reply(
            '❌ Use: `!playlist mover "Nome" <Pos Atual> <Nova Pos>`',
          );

        const res = await moverFaixaPlaylist(
          userId,
          playlistName,
          dePos,
          paraPos,
        );
        if (res.status === "playlist_nao_encontrada")
          return message.reply(
            `❌ Playlist **${playlistName}** não encontrada.`,
          );
        if (res.status === "fora_dos_limites")
          return message.reply(
            `❌ Posição inválida. A playlist tem **${res.total}** músicas.`,
          );
        if (res.status === "mesma_posicao")
          return message.reply("ℹ️ A música já está nessa posição!");
        return message.reply(
          `🔀 Música movida da posição **#${dePos}** para a posição **#${paraPos}** com sucesso!`,
        );
      }

      case "listar": {
        const playlistName = args[1];

        // CENÁRIO A: Usuário não digitou o nome de uma playlist -> Lista todas as dele
        if (!playlistName) {
          const playlists = await listarTodasPlaylists(userId);

          if (!playlists || playlists.length === 0) {
            return message.reply(
              '📭 Você ainda não tem nenhuma playlist criada. Use `!playlist criar "Nome"` para começar!',
            );
          }

          const listaDePlaylists = playlists
            .map((p, index) => {
              // Dá um destaque visual para as 'Curtidas' do sistema
              if (p.name.toLowerCase() === "curtidas") {
                return `**${p.name}** (${p.total_musicas} músicas)`;
              }
              return `📁 **${p.name}** (${p.total_musicas} músicas)`;
            })
            .join("\n");

          return message.reply(
            `📋 **Suas Playlists Criadas:**\n\n${listaDePlaylists}\n\n*Para ver as músicas de uma delas, use: \`!playlist listar "Nome da Playlist"\`*`,
          );
        }

        // CENÁRIO B: Usuário digitou o nome -> Lista as músicas daquela playlist (Código anterior)
        const faixas = await listarPlaylist(userId, playlistName);
        if (!faixas)
          return message.reply(
            `❌ Você não tem uma playlist chamada **${playlistName}**.`,
          );
        if (faixas.length === 0)
          return message.reply(`📭 A playlist **${playlistName}** está vazia.`);

        const listaTexto = faixas
          .slice(0, 20)
          .map((f) => `**${f.position}.** ${f.title}`)
          .join("\n");
        const rodape =
          faixas.length > 20
            ? `\n*...e mais ${faixas.length - 20} músicas.*`
            : "";

        return message.reply(
          `📑 **Playlist: ${playlistName}**\n\n${listaTexto}${rodape}`,
        );
      }

      case "tocar": {
        // Suporte a !playlist tocar @usuario "Nome"
        const mencionado = message.mentions.users.first();
        let donoId = userId;
        let playlistName = args[1];

        if (mencionado && mencionado.id !== message.author.id) {
          donoId = mencionado.id;
          playlistName = args[2]; // nome vem depois da menção
        }

        if (!playlistName)
          return message.reply(
            "❌ Digite o nome da playlist.\n" +
              'Sua playlist: `!playlist tocar "Nome"`\n' +
              'De outro membro: `!playlist tocar @usuario "Nome"`',
          );

        if (!message.member.voice.channelId)
          return message.reply(
            "❌ Você precisa estar em um canal de voz para tocar a playlist!",
          );

        const donoLabel =
          mencionado && mencionado.id !== message.author.id
            ? `de **${mencionado.displayName}**`
            : `**${playlistName}**`;

        const msgAviso = await message.reply(
          `⏳ Carregando as músicas da playlist ${donoLabel} para a fila...`,
        );
        try {
          const sucesso = await tocarPlaylist(message, donoId, playlistName);
          if (!sucesso)
            return msgAviso.edit(
              mencionado && mencionado.id !== message.author.id
                ? `❌ **${mencionado.displayName}** não tem uma playlist chamada **${playlistName}** (ou está vazia).`
                : `❌ Playlist **${playlistName}** não encontrada ou vazia.`,
            );
          return msgAviso.edit(
            `▶️ Playlist ${donoLabel} adicionada à fila com sucesso!`,
          );
        } catch (error) {
          console.error("Erro ao tocar playlist:", error);
          return msgAviso.edit(
            "❌ Ocorreu um erro ao tentar tocar a playlist.",
          );
        }
      }
    }
  }

  if (message.content.startsWith("!playsc")) {
    const query = message.content.replace("!playsc", "").trim();
    if (!query) return message.reply("Nome ou o link da música do SoundCloud!");
    return play(message, query, "scsearch");
  }

  if (message.content.startsWith("!play")) {
    const query = message.content.replace("!play", "").trim();
    if (!query) return message.reply("Nome ou o link da música!");
    return play(message, query);
  }

  if (message.content === "!stop") {
    stop(message.guild.id);
    return message.reply("Fila esvaziada, adeus.");
  }

  if (message.content.startsWith("!skip")) {
    const guildId = message.guild.id;
    const pulou = skip(guildId);

    if (pulou) {
      message.reply("⏭️ Música pulada com sucesso!");
    } else {
      message.reply("❌ Não tem nenhuma música tocando para eu pular.");
    }
  }

  if (message.content.startsWith("!restart")) {
    const guildId = message.guild.id;
    const reiniciou = restart(guildId);

    if (reiniciou) {
      message.reply("🔄 Reiniciando a música atual do começo!");
    } else {
      message.reply("❌ Não tem nenhuma música tocando para eu reiniciar.");
    }
  }

  if (message.content.startsWith("!pause")) {
    const resultado = pause(message.guild.id);
    if (resultado === "pausado") message.reply("⏸️ Música pausada.");
    else if (resultado === "ja_pausado") message.reply("⏸️ Já estava pausada.");
    else message.reply("❌ Não tem nenhuma música tocando para pausar.");
  }

  if (message.content.startsWith("!resume")) {
    const resultado = resume(message.guild.id);
    if (resultado === "retomado") message.reply("▶️ Música retomada.");
    else if (resultado === "nao_pausado")
      message.reply("▶️ A música já está tocando.");
    else message.reply("❌ Não tem nenhuma música tocando para retomar.");
  }

  if (message.content.startsWith("!autoplay")) {
    const ativado = toggleAutoplay(message.guild.id);
    if (ativado === null)
      return message.reply(
        "❌ Não há nenhuma sessão de música ativa neste servidor.",
      );
    message.reply(
      ativado
        ? "📻 Autoplay **ativado** — quando a fila acabar, eu continuo com músicas relacionadas (baseado na última do YouTube tocada)."
        : "📻 Autoplay **desativado**.",
    );
  }

  if (message.content.startsWith("!loop")) {
    const ativado = toggleLoop(message.guild.id);
    if (ativado === null)
      return message.reply(
        "❌ Não há nenhuma sessão de música ativa neste servidor.",
      );
    message.reply(
      ativado
        ? "🔂 Loop **ativado** — a música atual vai repetir ao terminar."
        : "🔂 Loop **desativado**.",
    );
  }

  if (message.content.startsWith("!move")) {
    const args = message.content.split(/\s+/);
    const de = parseInt(args[1]);
    const para = parseInt(args[2]);
    if (isNaN(de) || isNaN(para)) {
      return message.reply(
        "❌ Use `!move <posição atual> <nova posição>` — veja os números com `!queue`.",
      );
    }
    const res = moverNaFila(message.guild.id, de, para);
    if (res.error === "fila_vazia")
      return message.reply("❌ Não há músicas na fila para mover.");
    if (res.error === "fora_dos_limites")
      return message.reply(
        `❌ Posição inválida. A fila tem **${res.total}** música(s) após a atual.`,
      );
    if (res.error === "mesma_posicao")
      return message.reply("ℹ️ A música já está nessa posição!");
    return message.reply(
      `🔀 **${res.title}** movida da posição **#${de}** para **#${para}**!`,
    );
  }

  if (message.content.startsWith("!np")) {
    const state = states.get(message.guild.id);
    if (!state || !state.current) {
      return message.reply("❌ Nenhuma música tocando no momento.");
    }

    const elapsedSec = Math.floor(calcularElapsedMs(state) / 1000);
    const painel = criarPainelMusical(state.current, elapsedSec, {
      autoplay: !!state.autoplay,
      loop: !!state.loop,
    });
    message.channel.send(painel);
  }

  if (
    message.content.startsWith("!queue") ||
    message.content.startsWith("!fila")
  ) {
    const state = states.get(message.guild.id);
    if (!state) {
      return message.reply(
        "❌ Nenhuma música tocando ou na fila neste servidor.",
      );
    }

    const painelFila = criarPainelFila(state, 0);
    message.channel.send(painelFila);
  }

  if (
    message.content.startsWith("!history") ||
    message.content.startsWith("!historico")
  ) {
    try {
      const painelHistorico = await criarPainelHistorico(message.guild.id, 0);
      await message.channel.send(painelHistorico);
    } catch (error) {
      console.error("Erro ao carregar histórico:", error);
      message.reply("❌ Não foi possível carregar o histórico de músicas.");
    }
  }
  if (
    message.content.startsWith("!shuffle") ||
    message.content.startsWith("!misturar")
  ) {
    const guildId = message.guild.id;
    const sucesso = shuffleQueue(guildId);

    if (sucesso) {
      return message.reply(
        "🔀 **Fila embaralhada com sucesso!** Use `!queue` ou clique em **📋 Fila** para ver a nova ordem.",
      );
    } else {
      return message.reply(
        "❌ Não há músicas suficientes na fila para embaralhar.",
      );
    }
  }
  // !sfx — testa o efeito de entrada manualmente (só dono). Toca um efeito
  // aleatório de sounds/ por cima da música atual, igual ao join automático.
  if (message.content.startsWith("!sfx")) {
    const donos = parseOwnerIds(OWNER_IDS);
    if (donos.size === 0 || !donos.has(message.author.id)) {
      return message.reply("❌ Só o dono do bot pode usar o `!sfx`.");
    }
    const pick = sortearSfxPcm();
    if (!pick) {
      return message.reply(
        "❌ Nenhum efeito em `sounds/` (formatos: .mp3/.ogg/.wav/.m4a/.opus, até 2MB).",
      );
    }
    const res = tocarSfxEntrada(message.guild.id, pick.pcm);
    if (res === "tocado") {
      markSfxFired(message.guild.id);
      return message.reply(`🔔 **${pick.nome}** por cima da música!`);
    }
    if (res === "tocado_solto") {
      markSfxFired(message.guild.id);
      return message.reply(`🔔 **${pick.nome}**!`);
    }
    if (res === "sem_efeitos")
      return message.reply("❌ O bot precisa estar num canal de voz para tocar o efeito.");
    if (res === "ja_tocando_sfx")
      return message.reply("ℹ️ Já tem um efeito tocando agora.");
    if (res === "pausado")
      return message.reply("⏸️ Música pausada — retome para ouvir o efeito.");
    return message.reply("❌ Não consegui tocar o efeito agora.");
  }
  if (message.content.startsWith("!seek")) {
    const args = message.content.split(/\s+/);
    if (!args[1]) {
      return message.reply(
        "❌ Use `!seek <tempo>`. Exemplos:\n" +
          "`!seek 10:20` → 10 min 20 s\n" +
          "`!seek 1:12:14` → 1 h 12 min 14 s\n" +
          "`!seek 15` → 15 min\n" +
          "`!seek 00:15` → 15 s",
      );
    }

    const seekSec = parseSeekInput(args[1]);
    if (seekSec === null || seekSec < 0) {
      return message.reply(
        "❌ Tempo inválido. Use formatos como `10:20`, `1:12:14`, `00:15` ou `15`.",
      );
    }

    return seek(message.guild.id, seekSec, message);
  }

  if (message.content.startsWith("!remove")) {
    const args = message.content.split(/\s+/);
    const posicao = parseInt(args[1]);

    if (isNaN(posicao) || posicao < 1) {
      return message.reply(
        "❌ Use `!remove <número>` — o número da música na fila (veja com `!queue`).",
      );
    }

    const state = states.get(message.guild.id);
    if (!state || state.queue.length <= 1) {
      return message.reply("❌ Não há músicas na fila para remover.");
    }

    if (posicao >= state.queue.length) {
      return message.reply(
        `❌ Posição inválida. A fila tem **${state.queue.length - 1}** música(s).`,
      );
    }

    const titulo = removeFromQueue(message.guild.id, posicao);
    if (titulo) {
      return message.reply(
        `🗑️ **${titulo}** (posição #${posicao}) removida da fila.`,
      );
    } else {
      return message.reply("❌ Não foi possível remover essa música.");
    }
  }

  if (message.content === "!help" || message.content === "!comandos") {
    const embed = new EmbedBuilder()
      .setColor("#5865F2")
      .setTitle("🎵 MystMusic — Comandos Disponíveis")
      .addFields(
        {
          name: "▶️ Reprodução",
          value:
            "`!play <nome/link>` — Adiciona música à fila (YouTube/Spotify)\n" +
            "`!playsc <nome/link ou link direto>` — SoundCloud (busca pode retornar preview de 30s em faixa de selo; prefira link direto)\n" +
            "`!playnow <nome/link>` — Fura a fila e toca imediatamente (aceita Spotify)\n" +
            "`!stop` — Para tudo e esvazia a fila\n" +
            "`!skip` — Pula para a próxima música\n" +
            "`!restart` — Reinicia a música atual do começo\n" +
            "`!pause` — Pausa a reprodução\n" +
            "`!resume` — Retoma a reprodução",
        },
        {
          name: "📋 Fila",
          value:
            "`!queue` / `!fila` — Mostra as músicas na fila\n" +
            "`!remove <número>` — Remove uma música da fila pelo número\n" +
            "`!move <de> <para>` — Move uma música dentro da fila\n" +
            "`!loop` — Ativa/desativa repetição da música atual\n" +
            "`!seek <tempo>` — Vai para um trecho da música (ex: `10:20`, `1:12:14`, `00:15`, `15`)\n" +
            "`!shuffle` / `!misturar` — Embaralha a fila\n" +
            "`!np` — Mostra o painel da música atual",
        },
        {
          name: "📻 Autoplay & Histórico",
          value:
            "`!autoplay` — Ativa/desativa o autoplay ao fim da fila\n" +
            "`!history` / `!historico` — Histórico de músicas tocadas",
        },
        {
          name: "📁 Playlists",
          value:
            '`!playlist criar "Nome"` — Cria uma playlist\n' +
            '`!playlist excluir "Nome"` — Exclui uma playlist\n' +
            '`!playlist renomear "Antigo" "Novo"` — Renomeia\n' +
            '`!playlist add "Nome" <música>` — Adiciona faixa (aceita link do Spotify)\n' +
            '`!playlist remover "Nome" <posição>` — Remove faixa\n' +
            '`!playlist mover "Nome" <de> <para>` — Move faixa\n' +
            "`!playlist listar` — Lista suas playlists\n" +
            '`!playlist listar "Nome"` — Lista faixas de uma playlist\n' +
            '`!playlist tocar "Nome"` — Toca uma playlist\n' +
            '`!playlist tocar @usuario "Nome"` — Toca a playlist de outro membro',
        },
        {
          name: "👥 Playlists de outros membros",
          value:
            "`!playlists @usuario` — Lista as playlists de outro membro\n" +
            '`!playlist tocar @usuario "Nome"` — Toca a playlist de outro membro',
        },
        {
          name: "🔧 Outros",
          value:
            "`!sfx` — Testa o efeito de entrada (só dono)\n" +
            "`!botmorreu` / `!botbosta` — Reinicia o bot\n" +
            "`!help` / `!comandos` — Mostra esta mensagem",
        },
      )
      .setFooter({
        text: "MystMusic • Use os botões do painel para controle rápido",
      });

    return message.channel.send({ embeds: [embed] });
  }

  if (
    message.content.startsWith("!botmorreu") ||
    message.content.startsWith("!botbosta")
  ) {
    await message.reply("🔄 Reiniciando o bot...");

    setTimeout(() => {
      exec("pm2 restart mystmusic", (error) => {
        if (error) console.error("Erro ao reiniciar:", error);
      });
    }, 1000);
  }
});

client.on("voiceStateUpdate", async (oldState, newState) => {
  const guildId = oldState.guild.id;
  const botVoiceChannel = oldState.guild.members.me.voice.channelId;
  if (!botVoiceChannel) return;

  // SFX de entrada do dono (estilo "join sound" do Nitro): dono entrou no canal
  // onde o bot já está → remixa a música atual com efeito aleatório POR CIMA.
  // Só JOIN real, só dono, com debounce + cooldown (ver src/music/sfx.js).
  try {
    if (
      newState.member &&
      !newState.member.user.bot &&
      isJoinNoCanalDoBot(oldState, newState, botVoiceChannel)
    ) {
      const donos = parseOwnerIds(OWNER_IDS);
      if (donos.size > 0 && donos.has(newState.member.id)) {
        const timing = checkSfxTiming(guildId);
        if (timing === "ok") {
          const pick = sortearSfxPcm();
          if (pick) {
            const res = tocarSfxEntrada(guildId, pick.pcm);
            if (res === "tocado" || res === "tocado_solto") {
              markSfxFired(guildId);
              console.log(
                `🔔 SFX de entrada para ${newState.member.user.username} (${guildId}): ${pick.nome} (${res})`,
              );
            } else {
              console.log(`🔕 SFX ignorado (${res}) no servidor ${guildId}.`);
            }
          }
        }
      }
    }
  } catch (err) {
    // SFX nunca pode derrubar o handler principal (desconexão por inatividade).
    console.error("Erro no SFX de entrada:", err.message);
  }

  if (
    oldState.channelId === botVoiceChannel &&
    newState.channelId !== botVoiceChannel
  ) {
    const canalDeVoz = oldState.channel;
    const membrosHumanos = canalDeVoz.members.filter(
      (member) => !member.user.bot,
    );
    if (membrosHumanos.size === 0) {
      console.log(
        `🤖 Desconectando por inatividade no servidor ${guildId} (Canal vazio).`,
      );
      // cleanupVoiceState limpa timers, mata yt-dlp/ffmpeg, destrói a conexão
      // e remove o state — antes os timers de progresso vazavam aqui.
      if (!cleanupVoiceState(guildId)) {
        const { getVoiceConnection } = require("@discordjs/voice");
        const connection = getVoiceConnection(guildId);
        if (connection) connection.destroy();
      }
    }
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.guild) return;

  // 1️⃣ PRIMEIRO: Tratamento dos Comandos em Barra (Slash Commands)
  if (interaction.isChatInputCommand()) {
    try {
      await handleSlashCommand(interaction);
    } catch (error) {
      console.error("Erro no slash command:", error);
      const payload = {
        content: "❌ Ocorreu um erro ao executar o comando.",
        ephemeral: true,
      };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
    }
    return; // Garante que comandos em barra parem por aqui
  }

  // 2️⃣ SEGUNDO: Se não for comando em barra, só restam Botões e Modais
  if (!interaction.isButton() && !interaction.isModalSubmit()) return;

  const guildId = interaction.guild.id;
  const state = states.get(guildId);

  if (interaction.isButton()) {
    // Cenário A: Abrir o Modal de "Ir para a página..." (Fila ou Histórico)
    if (
      interaction.customId.startsWith("queue_goto_") ||
      interaction.customId.startsWith("history_goto_")
    ) {
      const partes = interaction.customId.split("_");
      const tipo = partes[0];
      const totalPaginas = partes[3];

      const modal = new ModalBuilder()
        .setCustomId(`${tipo}_modal_${totalPaginas}`)
        .setTitle("Navegar para Página");

      const pageInput = new TextInputBuilder()
        .setCustomId("page_num_input")
        .setLabel(`Digite a página (1 a ${totalPaginas}):`)
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("Ex: 3")
        .setRequired(true)
        .setMaxLength(4);

      const row = new ActionRowBuilder().addComponents(pageInput);
      modal.addComponents(row);

      return await interaction.showModal(modal);
    }

    // Cenário B: Passar/Voltar página no Histórico
    if (
      interaction.customId.startsWith("history_prev_") ||
      interaction.customId.startsWith("history_next_")
    ) {
      const partes = interaction.customId.split("_");
      const acao = partes[1];
      let paginaAtual = parseInt(partes[2]);

      if (acao === "next") paginaAtual++;
      if (acao === "prev") paginaAtual--;

      try {
        const painelAtualizado = await criarPainelHistorico(
          guildId,
          paginaAtual,
        );
        return await interaction.update(painelAtualizado);
      } catch (error) {
        console.error("Erro ao atualizar página do histórico:", error);
        return interaction.reply({
          content: "❌ Erro ao passar de página.",
          ephemeral: true,
        });
      }
    }

    // 🔍 TRAVA DE ATIVIDADE MUSICAL
    if (!state) {
      return interaction.reply({
        content: "❌ Nenhuma atividade musical encontrada neste servidor.",
        ephemeral: true,
      });
    }

    // Cenário C: Clicou no botão "Fila" do painel principal
    if (interaction.customId === "btn_queue") {
      const painelFila = criarPainelFila(state, 0);
      return interaction.reply({ ...painelFila, ephemeral: true });
    }
    // Cenário D: Passar/Voltar página na Fila
    if (
      interaction.customId.startsWith("queue_prev_") ||
      interaction.customId.startsWith("queue_next_")
    ) {
      const partes = interaction.customId.split("_");
      const acao = partes[1];
      let paginaAtual = parseInt(partes[2]);

      if (acao === "next") paginaAtual++;
      if (acao === "prev") paginaAtual--;

      const painelAtualizado = criarPainelFila(state, paginaAtual);
      return interaction.update(painelAtualizado);
    }

    if (
      [
        "btn_skip",
        "btn_stop",
        "btn_restart",
        "btn_shuffle",
        "btn_like",
        "btn_pauseresume",
      ].includes(interaction.customId)
    ) {
      if (!state || !state.current) {
        return interaction.reply({
          content: "❌ Nenhuma música tocando no momento.",
          ephemeral: true,
        });
      }
      const memberVoiceChannel = interaction.member.voice.channelId;
      const botVoiceChannel = interaction.guild.members.me.voice.channelId;

      if (!memberVoiceChannel || memberVoiceChannel !== botVoiceChannel) {
        return interaction.reply({
          content:
            "❌ Você precisa estar no mesmo canal de voz que eu para usar os botões de controle!",
          ephemeral: true,
        });
      }
      switch (interaction.customId) {
        case "btn_skip":
          await interaction.deferUpdate();
          skip(guildId);
          break;

        case "btn_stop":
          await interaction.deferUpdate();
          stop(guildId);
          break;

        case "btn_restart":
          await interaction.deferUpdate();
          restart(guildId);
          break;

        case "btn_pauseresume": {
          const pausado = state.player.state.status === "paused";
          if (pausado) {
            const r = resume(guildId);
            await interaction.reply({
              content:
                r === "retomado"
                  ? "▶️ Retomado!"
                  : "❌ Não foi possível retomar.",
              ephemeral: true,
            });
          } else {
            const r = pause(guildId);
            await interaction.reply({
              content:
                r === "pausado" ? "⏸️ Pausado!" : "❌ Não foi possível pausar.",
              ephemeral: true,
            });
          }
          break;
        }

        case "btn_shuffle":
          const embaralhou = shuffleQueue(guildId);
          if (embaralhou) {
            await interaction.reply({
              content: "🔀 Fila embaralhada!",
              ephemeral: true,
            });
          } else {
            await interaction.reply({
              content: "❌ Poucas músicas na fila para embaralhar.",
              ephemeral: true,
            });
          }
          break;
        case "btn_like":
          await interaction.deferReply({ ephemeral: true }).catch(() => {});

          try {
            const resultado = await adicionarAosCurtidos(
              interaction.user.id,
              state.current,
            );

            if (resultado.status === "existe") {
              return interaction.editReply(
                `ℹ️ **${resultado.title}** já está na sua lista de Curtidas!`,
              );
            }

            return interaction.editReply(
              `❤️ **${resultado.title}** foi adicionada à sua playlist de **Curtidas**!`,
            );
          } catch (error) {
            console.error("Erro ao curtir música:", error);
            return interaction.editReply(
              "❌ Ocorreu um erro ao salvar a música no banco de dados.",
            );
          }
          break;
      }
    }
  }

  if (interaction.isModalSubmit()) {
    if (
      interaction.customId.startsWith("queue_modal_") ||
      interaction.customId.startsWith("history_modal_")
    ) {
      const partes = interaction.customId.split("_");
      const tipo = partes[0];
      const totalPaginas = parseInt(partes[2]);

      const valorDigitado = interaction.fields
        .getTextInputValue("page_num_input")
        .trim();
      const numeroPagina = parseInt(valorDigitado);

      if (
        isNaN(numeroPagina) ||
        numeroPagina < 1 ||
        numeroPagina > totalPaginas
      ) {
        return await interaction.reply({
          content: `❌ **"${valorDigitado}"** não é uma página válida. Digite um número entre 1 e ${totalPaginas}.`,
          ephemeral: true,
        });
      }

      const paginaAlvo = numeroPagina - 1;

      try {
        if (tipo === "queue") {
          if (!state)
            return interaction.reply({
              content: "Fila indisponível.",
              ephemeral: true,
            });
          const painelAtualizado = criarPainelFila(state, paginaAlvo);
          return await interaction.update(painelAtualizado);
        }

        if (tipo === "history") {
          const painelAtualizado = await criarPainelHistorico(
            guildId,
            paginaAlvo,
          );
          return await interaction.update(painelAtualizado);
        }
      } catch (error) {
        console.error("Erro ao pular página via modal:", error);
        return interaction.reply({
          content: "❌ Ocorreu um erro ao mudandar de página.",
          ephemeral: true,
        });
      }
    }
  }
});

async function desligarBotGraciosamente() {
  console.log("\n🛑 Desligando o bot... Limpando conexões de voz.");

  try {
    for (const [guildId, state] of [...states.entries()]) {
      try {
        // cleanupVoiceState já limpa timers, mata yt-dlp/ffmpeg, para o
        // player, destrói a conexão e remove o state.
        const tinha = cleanupVoiceState(guildId);
        if (tinha)
          console.log(`✅ Desconectado com sucesso da guilda: ${guildId}`);
      } catch (err) {
        console.error(`Erro ao desconectar da guilda ${guildId}:`, err);
      }
    }
    await client.destroy();
    if (logsDb) {
      await new Promise((resolve, reject) => {
        logsDb.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      console.log("✅ Banco de dados fechado.");
    }
  } catch (err) {
    console.error("Erro no desligamento:", err);
  }
  process.exit(0);
}

function criarPainelHistorico(guildId, pagina = 0) {
  return new Promise((resolve, reject) => {
    const itensPorPagina = 10;
    const offset = pagina * itensPorPagina;

    // Timeout de segurança para o banco
    const timeout = setTimeout(() => {
      reject(new Error("Timeout ao consultar o banco de dados do SQLite."));
    }, 5000);

    // 1. Query para pegar o total de músicas
    logsDb.get(
      `SELECT COUNT(*) as total FROM play_logs WHERE guild_id = ? AND status = 'SUCCESS'`,
      [guildId],
      (err, rowTotal) => {
        if (err) {
          clearTimeout(timeout);
          return reject(err);
        }

        const totalMusicas = rowTotal ? rowTotal.total : 0;
        const totalPaginas = Math.ceil(totalMusicas / itensPorPagina);

        const embed = new EmbedBuilder()
          .setColor("#ED4245")
          .setTitle("📜 Histórico de Músicas Tocadas");

        if (totalMusicas === 0) {
          clearTimeout(timeout);
          embed.setDescription(
            "Nenhuma música foi tocada neste servidor ainda.",
          );
          return resolve({ embeds: [embed], components: [] });
        }

        // 2. Query atualizada: adicionamos a coluna 'query' para pegar o link do YouTube
        const querySql = `SELECT resolved_title, requested_by, created_at, query 
                              FROM play_logs 
                              WHERE guild_id = ? AND status = 'SUCCESS' 
                              ORDER BY id DESC 
                              LIMIT ? OFFSET ?`;

        logsDb.all(querySql, [guildId, itensPorPagina, offset], (err, rows) => {
          clearTimeout(timeout);

          if (err) return reject(err);

          if (!rows || rows.length === 0) {
            embed.setDescription(
              "Nenhum registro encontrado para esta página.",
            );
            return resolve({ embeds: [embed], components: [] });
          }

          let descricao = "";

          rows.forEach((row, index) => {
            const posicao = offset + index + 1;

            // 📅 Tratamento de Data e Hora
            // row.created_at costuma ser "2026-05-15 13:10:00"
            let dataHoraFormatada = "--/-- --:--";
            if (row.created_at) {
              const partesDataHora = row.created_at.split(" ");
              const dataBruta = partesDataHora[0]; // "2026-05-15"
              const horaCompleta = partesDataHora[1]; // "13:10:00"

              // Inverte o padrão americano (AAAA-MM-DD) para o brasileiro (DD/MM)
              const [ano, mes, dia] = dataBruta.split("-");
              const horaMinuto = horaCompleta.substring(0, 5); // Pega só "13:10"

              dataHoraFormatada = `${dia}/${mes} ${horaMinuto}`;
            }

            const titulo = row.resolved_title || "Música Desconhecida";

            // 🔗 Tratamento do Hyperlink (se não tiver link por ser busca por texto, evita quebrar)
            const linkVideo =
              row.query && row.query.startsWith("http") ? row.query : null;
            const tituloFormatado = linkVideo
              ? `[${titulo}](${linkVideo})`
              : titulo;

            // Autoplay salva requested_by como NULL — evita renderizar <@null>.
            const quemPediu = row.requested_by
              ? `<@${row.requested_by}>`
              : "📻 Autoplay";
            descricao += `\`${posicao}.\` \`[${dataHoraFormatada}]\` **${tituloFormatado}** | ${quemPediu}\n`;
          });

          embed.setDescription(descricao);
          embed.setFooter({
            text: `Página ${pagina + 1} de ${totalPaginas || 1} • Total de ${totalMusicas} registros`,
          });

          const row = new ActionRowBuilder();
          if (totalPaginas > 1) {
            row.addComponents(
              new ButtonBuilder()
                .setCustomId(`history_prev_${pagina}`)
                .setLabel("◀️")
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(pagina === 0),
              new ButtonBuilder()
                .setCustomId(`history_goto_${pagina}_${totalPaginas}`)
                .setLabel("🔢 Ir para...")
                .setStyle(ButtonStyle.Primary),
              new ButtonBuilder()
                .setCustomId(`history_next_${pagina}`)
                .setLabel("▶️")
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(pagina >= totalPaginas - 1),
            );
            return resolve({ embeds: [embed], components: [row] });
          }

          return resolve({ embeds: [embed], components: [] });
        });
      },
    );
  });
}

process.on("SIGINT", desligarBotGraciosamente);
process.on("SIGTERM", desligarBotGraciosamente);

client.login(TOKEN);

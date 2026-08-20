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
const { TOKEN, GUILDS } = require("./config/env");
const {
  play,
  stop,
  skip,
  restart,
  playNow,
  criarPainelMusical,
  adicionarAosCurtidos,
  shuffleQueue,
  criarPlaylist,
  excluirPlaylist,
  renomearPlaylist,
  adicionarFaixaPlaylist,
  removerFaixaPlaylist,
  moverFaixaPlaylist,
  tocarPlaylist,
  listarPlaylist,
  listarTodasPlaylists,
  states,
} = require("./music/manager");
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
  let descricao = `**Tocando Agora:**\n🔹 [${current.title}](${current.url}) | <@${current.requestedBy}>\n\n`;

  if (queue.length > 1) {
    descricao += `**Próximas Músicas:**\n`;
    const inicio = 1 + pagina * itensPorPagina;
    const fim = Math.min(inicio + itensPorPagina, queue.length);

    for (let i = inicio; i < fim; i++) {
      descricao += `\`${i}.\` [${queue[i].title}](${queue[i].url}) | <@${queue[i].requestedBy}>\n`;
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

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;
  if (message.content.startsWith("!playnow")) {
    const query = message.content.replace("!playnow", "").trim();
    if (!query)
      return message.reply("Nome ou o link da música que vai furar a fila!");
    return playNow(message, query);
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
        const playlistName = args[1];
        if (!playlistName)
          return message.reply(
            '❌ Digite o nome da playlist. Ex: `!playlist tocar "Curtidas"`',
          );

        if (!message.member.voice.channelId)
          return message.reply(
            "❌ Você precisa estar em um canal de voz para tocar a playlist!",
          );

        const msgAviso = await message.reply(
          `⏳ Carregando as músicas de **${playlistName}** para a fila...`,
        );
        try {
          const sucesso = await tocarPlaylist(message, userId, playlistName);
          if (!sucesso)
            return msgAviso.edit(
              `❌ Playlist **${playlistName}** não encontrada ou vazia.`,
            );
          return msgAviso.edit(
            `▶️ Playlist **${playlistName}** adicionada à fila com sucesso!`,
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

  if (message.content.startsWith("!np")) {
    const state = states.get(message.guild.id);
    if (!state || !state.current) {
      return message.reply("❌ Nenhuma música tocando no momento.");
    }

    const painel = criarPainelMusical(state.current);
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
      const state = states.get(guildId);
      if (state) {
        if (state.player) state.player.stop();
        if (state.connection) {
          try {
            state.connection.destroy();
          } catch (e) {
            console.error("Erro ao destruir conexão:", e);
          }
        }
        states.delete(guildId);
      } else {
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
    if (interaction.commandName === "playlist") {
      const subCommand = interaction.options.getSubcommand();
      const userId = interaction.user.id;
      const guildId = interaction.guild.id;
      const state = states.get(guildId);

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
              content:
                "⚠️ A playlist de **Curtidas** é protegida pelo sistema.",
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
              content: `❌ Você já tem outra playlist chamada **${newName}**..`,
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
            const res = await adicionarFaixaPlaylist(
              userId,
              playlistName,
              query,
            );
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
              content:
                "❌ Nenhuma música encontrada nessa posição da playlist.",
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

          if (!interaction.member.voice.channelId) {
            return interaction.reply({
              content: "❌ Você precisa estar em um canal de voz para tocar!",
              ephemeral: true,
            });
          }
          await interaction.deferReply();

          try {
            const fakeMessage = {
              guild: interaction.guild,
              member: interaction.member,
              author: interaction.user,
              channel: interaction.channel,
              reply: async (obj) => {
                return interaction.followUp(obj);
              },
            };

            const sucesso = await tocarPlaylist(
              fakeMessage,
              userId,
              playlistName,
            );
            if (!sucesso)
              return interaction.editReply(
                `❌ Playlist **${playlistName}** não encontrada ou vazia.`,
              );
            return interaction.editReply(
              `▶️ Playlist **${playlistName}** adicionada à fila com sucesso!`,
            );
          } catch (error) {
            console.error(error);
            return interaction.editReply(
              "❌ Ocorreu um erro ao carregar a playlist.",
            );
          }
        }
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
    for (const [guildId, state] of states.entries()) {
      try {
        if (state.player) {
          state.player.stop();
        }
        if (state.connection) {
          state.connection.removeAllListeners();
          state.connection.destroy();
          console.log(`✅ Desconectado com sucesso da guilda: ${guildId}`);
        }
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

            descricao += `\`${posicao}.\` \`[${dataHoraFormatada}]\` **${tituloFormatado}** | <@${row.requested_by}>\n`;
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

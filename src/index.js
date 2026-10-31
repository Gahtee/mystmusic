const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const {
  TOKEN,
  GUILDS,
  OWNER_IDS,
  PREFIX,
  ENABLE_SLASH,
} = require("./config/env");
const {
  cleanupVoiceState,
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
const { handleSlashCommand } = require("./routes/slash");
const { handleButtonInteraction } = require("./routes/buttons");
const { handlePrefixMessage } = require("./routes/prefix");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

client.once("clientReady", () => {
  console.log(
    `Bot online como ${client.user.tag} (prefixo "${PREFIX}"${ENABLE_SLASH ? "" : ", slash OFF"})`,
  );
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

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;
  // ── Prefixo configurável (.env: PREFIX="!" ou ".") ────────────────────────
  // Cada instância só responde ao SEU prefixo — assim dois bots podem rodar
  // lado a lado dividindo o mesmo banco sem responder dobrado.
  // Normaliza para a forma canônica "!" e o restante do roteador segue
  // inalterado (menos diff, menos risco de quebrar comando).
  if (!message.content.startsWith(PREFIX)) return;
  const corpo = message.content.slice(PREFIX.length);
  message.content = "!" + corpo;
  // Roteador de comandos de prefixo (!) → routes/prefix.js (switch do
  // !playlist, cadeia de startsWith, patch de reply com prefixo, !help,
  // !sfx, !botmorreu — ordem e fall-through preservados, incluindo o
  // quirk do "!playlist <sub desconhecido>" que cai no startsWith("!play").)
  return handlePrefixMessage(message, { criarPainelHistorico });
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
    // Modo 2 bots: o 2º roda com ENABLE_SLASH=0 e responde SÓ ao prefixo
    // "." — não registre /slash para o app 2 (deploy só com o .env
    // principal). Se algum comando vazar, avisa em vez de falhar em silêncio.
    if (!ENABLE_SLASH) {
      return interaction
        .reply({
          content: `❌ Slash desativado neste bot — use os comandos de texto com \`${PREFIX}\` (ex: \`${PREFIX}play <música>\`).`,
          ephemeral: true,
        })
        .catch(() => {});
    }
    try {
      await handleSlashCommand(interaction, { criarPainelHistorico });
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

  // Modo 2 bots: cada instância só atende botões/modais das SUAS mensagens.
  // Sem isso, o bot 2 responderia "nenhuma atividade" ao clicarem no painel
  // do bot 1 (o state é por processo). Compara o autor da mensagem do painel
  // com o próprio user — interação sem mensagem passa (não é o nosso caso).
  const autorPainel = interaction.message?.author?.id;
  if (autorPainel && autorPainel !== client.user.id) return;

  // Botões (btn_*, paginação) e modais (queue_goto/history_goto) → routes/buttons.js
  return handleButtonInteraction(interaction, { criarPainelHistorico });
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

const { REST, Routes, SlashCommandBuilder } = require("discord.js");
const { TOKEN, CLIENT, GUILDS, PREFIX, ENABLE_SLASH } = require("./env");

if (!TOKEN || !CLIENT) {
  console.error("❌ TOKEN ou CLIENT ausentes no .env — abortando deploy.");
  process.exit(1);
}

// Modo 2 bots: o 2º (PREFIX=".", ENABLE_SLASH=0) responde só ao prefixo de
// texto — registrar /slash para ele criaria entradas duplicadas (/play do
// bot 1 + /play do bot 2). Rode o deploy SÓ com o .env principal.
if (!ENABLE_SLASH) {
  console.error(
    `❌ ENABLE_SLASH=0 neste env (prefixo "${PREFIX}") — deploy de /slash abortado de propósito.\n` +
      "   Rode sem DOTENV_FILE (usa o .env principal) para registrar os /slash uma única vez.",
  );
  process.exit(1);
}

// Espelha 1:1 os comandos de texto (!play, !skip, ...) para que /slash e !
// tenham o mesmo comportamento. Se adicionar um !comando novo, adicione o
// /equivalente aqui e o handler em src/index.js (handleSlashCommand).
const commands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Adiciona música à fila (YouTube/Spotify)")
    .addStringOption((opt) =>
      opt
        .setName("musica")
        .setDescription("Nome ou link da música (aceita link do Spotify)")
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("playsc")
    .setDescription("Adiciona música à fila (SoundCloud)")
    .addStringOption((opt) =>
      opt
        .setName("musica")
        .setDescription("Nome ou link da música")
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("playnow")
    .setDescription("Fura a fila: toca a música a seguir (aceita Spotify)")
    .addStringOption((opt) =>
      opt
        .setName("musica")
        .setDescription("Nome ou link da música (aceita link do Spotify)")
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Para tudo, esvazia a fila e desconecta o bot"),

  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Pula para a próxima música"),

  new SlashCommandBuilder()
    .setName("restart")
    .setDescription("Reinicia a música atual do começo"),

  new SlashCommandBuilder()
    .setName("pause")
    .setDescription("Pausa a reprodução"),

  new SlashCommandBuilder()
    .setName("resume")
    .setDescription("Retoma a reprodução"),

  new SlashCommandBuilder()
    .setName("autoplay")
    .setDescription("Ativa/desativa o autoplay ao fim da fila"),

  new SlashCommandBuilder()
    .setName("loop")
    .setDescription("Ativa/desativa a repetição da música atual"),

  new SlashCommandBuilder()
    .setName("bass")
    .setDescription("Bass boost configurável (padrão +6dB, sem limite)")
    .addStringOption((opt) =>
      opt
        .setName("nivel")
        .setDescription("dB de reforço (ex: 8) — vazio liga/desliga, 0 desliga")
        .setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName("nightcore")
    .setDescription("Nightcore configurável (padrão 1.25x, 0.5–3)")
    .addStringOption((opt) =>
      opt
        .setName("taxa")
        .setDescription("Velocidade/pitch (ex: 1.4) — vazio liga/desliga")
        .setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName("np")
    .setDescription("Mostra o painel da música atual"),

  new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Mostra as músicas na fila"),

  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Remove uma música da fila pelo número (veja com /queue)")
    .addIntegerOption((opt) =>
      opt
        .setName("posicao")
        .setDescription("Número da música na fila")
        .setRequired(true)
        .setMinValue(1),
    ),

  new SlashCommandBuilder()
    .setName("move")
    .setDescription("Move uma música dentro da fila")
    .addIntegerOption((opt) =>
      opt
        .setName("de")
        .setDescription("Posição atual")
        .setRequired(true)
        .setMinValue(1),
    )
    .addIntegerOption((opt) =>
      opt
        .setName("para")
        .setDescription("Nova posição")
        .setRequired(true)
        .setMinValue(1),
    ),

  new SlashCommandBuilder()
    .setName("seek")
    .setDescription(
      "Vai para um trecho da música atual (ex: 10:20, 1:12:14, 00:15)",
    )
    .addStringOption((opt) =>
      opt
        .setName("tempo")
        .setDescription("Posição: MM:SS, H:MM:SS ou minutos")
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("shuffle")
    .setDescription("Embaralha a fila"),

  new SlashCommandBuilder()
    .setName("history")
    .setDescription("Histórico de músicas tocadas neste servidor"),

  new SlashCommandBuilder()
    .setName("playlists")
    .setDescription("Ver playlists: suas, de outro membro ou do servidor")
    .addSubcommand((sub) =>
      sub.setName("minhas").setDescription("Lista as suas playlists"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("servidor")
        .setDescription("Apanhado geral das playlists do servidor"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("de")
        .setDescription("Lista as playlists de outro membro")
        .addUserOption((opt) =>
          opt
            .setName("usuario")
            .setDescription("Membro dono das playlists")
            .setRequired(true),
        ),
    ),

  new SlashCommandBuilder()
    .setName("playlist")
    .setDescription("Gerencia suas playlists personalizadas")
    .addSubcommand((sub) =>
      sub
        .setName("criar")
        .setDescription("Cria uma nova playlist vazia")
        .addStringOption((opt) =>
          opt
            .setName("nome")
            .setDescription("Nome da playlist")
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("excluir")
        .setDescription("Deleta uma playlist existente")
        .addStringOption((opt) =>
          opt
            .setName("nome")
            .setDescription("Nome da playlist")
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("renomear")
        .setDescription("Altera o nome de uma playlist")
        .addStringOption((opt) =>
          opt
            .setName("antigo")
            .setDescription("Nome atual da playlist")
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName("novo")
            .setDescription("Novo nome para a playlist")
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("Adiciona uma música à playlist")
        .addStringOption((opt) =>
          opt
            .setName("playlist")
            .setDescription("Nome da playlist")
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName("musica")
            .setDescription("Link ou busca da música")
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("remover")
        .setDescription("Remove uma música da playlist pela posição")
        .addStringOption((opt) =>
          opt
            .setName("playlist")
            .setDescription("Nome da playlist")
            .setRequired(true),
        )
        .addIntegerOption((opt) =>
          opt
            .setName("posicao")
            .setDescription("Número da posição da música")
            .setRequired(true)
            .setMinValue(1),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("mover")
        .setDescription("Altera a ordem de uma música na playlist")
        .addStringOption((opt) =>
          opt
            .setName("playlist")
            .setDescription("Nome da playlist")
            .setRequired(true),
        )
        .addIntegerOption((opt) =>
          opt
            .setName("de")
            .setDescription("Posição atual")
            .setRequired(true)
            .setMinValue(1),
        )
        .addIntegerOption((opt) =>
          opt
            .setName("para")
            .setDescription("Nova posição")
            .setRequired(true)
            .setMinValue(1),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("listar")
        .setDescription("Lista suas playlists ou as músicas de uma delas")
        .addStringOption((opt) =>
          opt
            .setName("nome")
            .setDescription("Nome da playlist (vazio para ver todas)")
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("tocar")
        .setDescription("Adiciona todas as músicas de uma playlist à fila")
        .addStringOption((opt) =>
          opt
            .setName("nome")
            .setDescription("Nome da playlist")
            .setRequired(true),
        )
        .addUserOption((opt) =>
          opt
            .setName("usuario")
            .setDescription("Tocar a playlist de outro membro (opcional)")
            .setRequired(false),
        ),
    ),
].map((command) => command.toJSON());

const rest = new REST({ version: "10" }).setToken(TOKEN);

(async () => {
  try {
    // Registra por servidor (GUILDS do .env): atualiza na hora, sem esperar
    // a propagação de até 1h dos comandos globais.
    const guilds = [...new Set((GUILDS || []).filter(Boolean))];
    if (guilds.length === 0) {
      console.error("❌ GUILDS vazio no .env — nada para registrar.");
      process.exit(1);
    }
    for (const guildId of guilds) {
      console.log(
        `🔄 Registrando ${commands.length} comandos em ${guildId}...`,
      );
      await rest.put(Routes.applicationGuildCommands(CLIENT, guildId), {
        body: commands,
      });
    }
    // Limpa comandos GLOBAIS para não duplicar (global + guild = 2 entradas).
    await rest.put(Routes.applicationCommands(CLIENT), { body: [] });
    console.log(
      `✅ ${commands.length} slash commands ativos em ${guilds.length} servidor(es).`,
    );
  } catch (error) {
    console.error("❌ Erro no deploy:", error);
    process.exit(1);
  }
})();

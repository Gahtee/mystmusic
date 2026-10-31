// Roteador de comandos de prefixo (!) extraído de index.js sem mudança de
// lógica nem de ordem. As guardas do modo dois bots (autor bot, guild,
// gate de PREFIX e normalização "!" + corpo) ficam em index.js, que delega
// para cá. criarPainelHistorico é injetado por deps (compartilhado com o
// roteador de slash — depende de logsDb).
// Mantenha a ordem: a cadeia de startsWith é sensível à sequência (ex:
// "!playlist <sub desconhecido>" cai no startsWith("!play") — comportamento
// conhecido e preservado de propósito).
const { EmbedBuilder } = require("discord.js");
const { exec } = require("child_process");
const { OWNER_IDS, PREFIX, PM2_NAME } = require("../config/env");
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
  criarPainelMusical,
  calcularElapsedMs,
  getAudioFx,
  duracaoEfetiva,
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
  setBassBoost,
  setNightcore,
  states,
} = require("../music/manager");
const {
  parseOwnerIds,
  sortearSfxPcm,
  markSfxFired,
} = require("../music/sfx");
const { criarPainelFila } = require("../utils/paineis");

async function handlePrefixMessage(message, deps = {}) {
  const { criarPainelHistorico } = deps;
  // Textos de ajuda exibem "`!comando" — traduz para o prefixo real para o
  // bot "." não ensinar "!" (que ele não escuta). Só toca em `!` após
  // crase, então "música!" e afins passam intactos.
  // NOTA: só message.reply é adaptado (objeto por mensagem). channel.send
  // NÃO é adaptado — o objeto do canal é compartilhado no cache e o patch
  // vazaria entre mensagens. O único send com exemplos é o !help (embed),
  // traduzido explicitamente no handler.
  const comPrefixo = (texto) =>
    PREFIX === "!" ? texto : texto.split("`!").join("`" + PREFIX);
  const replyOriginal = message.reply.bind(message);
  message.reply = (conteudo) => {
    if (typeof conteudo === "string") return replyOriginal(comPrefixo(conteudo));
    if (conteudo && typeof conteudo === "object" && typeof conteudo.content === "string")
      conteudo.content = comPrefixo(conteudo.content);
    return replyOriginal(conteudo);
  };
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
    return message.channel.send(comPrefixo(rodape.trim()));
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

  if (
    message.content.startsWith("!bass") ||
    message.content.startsWith("!grave")
  ) {
    const arg = message.content.split(/\s+/).slice(1).join(" ") || undefined;
    const res = setBassBoost(message.guild.id, arg);
    if (res.error === "sem_sessao")
      return message.reply("❌ Não há nenhuma sessão de música ativa neste servidor.");
    if (res.error === "invalido")
      return message.reply(
        "❌ Valor inválido. Use `!bass` (liga/desliga, padrão +6dB), `!bass <dB>` (ex: `!bass 10`) ou `!bass off`.",
      );
    if (res.db === 0) return message.reply("🔊 Bass boost **desativado**.");
    return message.reply(
      `🔊 Bass boost **+${Number(res.db.toFixed ? res.db.toFixed(2) : res.db)}dB**${res.toggled ? " (padrão)" : ""} — aplica na hora, vale para a sessão toda.`,
    );
  }

  if (
    message.content.startsWith("!nightcore") ||
    message.content.startsWith("!nc")
  ) {
    const arg = message.content.split(/\s+/).slice(1).join(" ") || undefined;
    const res = setNightcore(message.guild.id, arg);
    if (res.error === "sem_sessao")
      return message.reply("❌ Não há nenhuma sessão de música ativa neste servidor.");
    if (res.error === "invalido")
      return message.reply(
        "❌ Valor inválido. Use `!nightcore` (liga/desliga, padrão 1.25x), `!nightcore <taxa>` (0.5–3, ex: `!nightcore 1.4`) ou `!nightcore off`.",
      );
    if (res.rate === 1) return message.reply("⚡ Nightcore **desativado**.");
    return message.reply(
      `⚡ Nightcore **${Number(res.rate.toFixed ? res.rate.toFixed(2) : res.rate)}x**${res.toggled ? " (padrão)" : ""} — a faixa anda mais rápido e acaba mais cedo.`,
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
    const fxNp = getAudioFx(state);
    const painel = criarPainelMusical(state.current, elapsedSec, {
      autoplay: !!state.autoplay,
      loop: !!state.loop,
      bassDb: fxNp.bassDb,
      nightcore: fxNp.nightcore,
      duracaoEfetiva: duracaoEfetiva(state.current, state),
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
            "`!bass [dB|off]` — Bass boost (padrão +6dB, sem limite; sem arg liga/desliga)\n" +
            "`!nightcore [taxa|off]` — Nightcore (padrão 1.25x, 0.5–3; sem arg liga/desliga)\n" +
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

    // Traduz os exemplos "`!comando" do help para o prefixo real (bot ".").
    if (PREFIX !== "!") {
      for (const f of embed.data.fields || []) {
        if (typeof f.value === "string")
          f.value = comPrefixo(f.value);
      }
    }
    return message.channel.send({ embeds: [embed] });
  }

  if (
    message.content.startsWith("!botmorreu") ||
    message.content.startsWith("!botbosta")
  ) {
    await message.reply("🔄 Reiniciando o bot...");

    setTimeout(() => {
      // PM2_NAME vem do .env: cada instância reinicia SÓ a si mesma
      // (.env → mystmusic, .env.bot2 → mystmusic2).
      exec(`pm2 restart ${PM2_NAME}`, (error) => {
        if (error) console.error("Erro ao reiniciar:", error);
      });
    }, 1000);
  }
}

module.exports = { handlePrefixMessage };

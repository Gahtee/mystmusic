const {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} = require("discord.js");
const {
  skip,
  stop,
  restart,
  pause,
  resume,
  shuffleQueue,
  adicionarAosCurtidos,
  states,
} = require("../music/manager");
const { criarPainelFila } = require("../utils/paineis");

// Tratamento de botões (btn_*, paginação queue_*) e modais (queue_goto /
// history_goto) extraído de index.js sem mudança de lógica. O guard de autor
// do painel (modo 2 bots) fica em index.js, que delega para cá.
// criarPainelHistorico é injetado por parâmetro (depende de logsDb e é
// compartilhado com o roteador de prefixo).
async function handleButtonInteraction(interaction, { criarPainelHistorico } = {}) {
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
}

module.exports = { handleButtonInteraction };

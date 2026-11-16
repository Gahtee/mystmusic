const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const {
  formatarTempo,
  criarBarraProgresso,
  formatarFx,
} = require("./format");

function criarPainelMusical(metadata, elapsedSec = 0, flags = {}) {
  const titulo = metadata.title || "🔍 Buscando dados da faixa...";
  const url = metadata.url || null;
  const descricaoTitulo = url ? `**[${titulo}](${url})**` : `**${titulo}**`;
  // Com nightcore a faixa acaba rate x mais cedo: a barra usa a duração
  // EFETIVA (flags.duracaoEfetiva, calculada pelo chamador com o state).
  // Fallback p/ duration crua quando o chamador não informa (testes, np sem state).
  const durTotal = flags.duracaoEfetiva || metadata.duration;
  // Clamp: o relógio é Date.now() e o Discord atrasa/adianta o áudio real —
  // sem isso o painel mostra "4:10 / 4:05".
  const elapsedSafe = Math.max(0, Math.floor(elapsedSec) || 0);
  const elapsed = durTotal ? Math.min(elapsedSafe, Math.floor(durTotal)) : elapsedSafe;
  const barra = durTotal
    ? `${criarBarraProgresso(elapsed, durTotal)}\n\`${formatarTempo(elapsed)} / ${formatarTempo(durTotal)}\``
    : "🔍 *Carregando informações...*";
  const pedidoPor = metadata.requestedBy
    ? `<@${metadata.requestedBy}>`
    : "📻 Autoplay";
  const statusExtras = [
    flags.autoplay ? "📻 Autoplay ON" : null,
    flags.loop ? "🔂 Loop ON" : null,
    flags.bassDb > 0 ? `🔊 Bass +${formatarFx(flags.bassDb)}dB` : null,
    flags.nightcore !== undefined && flags.nightcore !== 1
      ? `⚡ ${formatarFx(flags.nightcore)}x`
      : null,
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
  // Placeholder otimista ainda sem metadados (null logo após !play playlist):
  // nunca pode crashar o !queue (era TypeError reading 'title').
  const rotuloFaixa = (faixa) => {
    const t = (faixa && (faixa.title || faixa.query)) || "🔍 Buscando...";
    if (faixa && faixa.url) return `[${t}](${faixa.url})`;
    return t.length > 80 ? `${t.slice(0, 77)}...` : t;
  };
  const atual = current || {};
  let descricao = `**Tocando Agora:**\n🔹 ${rotuloFaixa(atual)} | ${rotuloPedido(atual)}\n\n`;

  if (queue.length > 1) {
    descricao += `**Próximas Músicas:**\n`;
    const inicio = 1 + pagina * itensPorPagina;
    const fim = Math.min(inicio + itensPorPagina, queue.length);

    for (let i = inicio; i < fim; i++) {
      descricao += `\`${i}.\` ${rotuloFaixa(queue[i])} | ${rotuloPedido(queue[i])}\n`;
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

module.exports = {
  criarPainelMusical,
  criarPainelFila,
};
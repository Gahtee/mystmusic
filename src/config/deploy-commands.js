const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const { TOKEN, CLIENT } = require("./env");

const commands = [
    // /play [musica]
    new SlashCommandBuilder()
        .setName('play')
        .setDescription('Toca uma música no canal de voz')
        .addStringOption(opt => opt.setName('musica').setDescription('Nome ou link da música').setRequired(true)),

    // /playnow [musica]
    new SlashCommandBuilder()
        .setName('playnow')
        .setDescription('Fura a fila e toca uma música imediatamente')
        .addStringOption(opt => opt.setName('musica').setDescription('Nome ou link da música').setRequired(true)),

    // /stop
    new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Esvazia a fila de músicas e desconecta o bot'),

    // /skip
    new SlashCommandBuilder()
        .setName('skip')
        .setDescription('Pula a música atual'),

    // /restart
    new SlashCommandBuilder()
        .setName('restart')
        .setDescription('Reinicia a música atual do começo'),

    // /np
    new SlashCommandBuilder()
        .setName('np')
        .setDescription('Mostra o painel da música que está tocando agora'),

    // /queue
    new SlashCommandBuilder()
        .setName('queue')
        .setDescription('Mostra a fila atual de músicas'),

    // /history
    new SlashCommandBuilder()
        .setName('history')
        .setDescription('Mostra o histórico de músicas tocadas'),

    // /shuffle
    new SlashCommandBuilder()
        .setName('shuffle')
        .setDescription('Embaralha as músicas da fila'),

    // /playlist (e seus subcomandos)
    new SlashCommandBuilder()
        .setName('playlist')
        .setDescription('Gerencia suas playlists personalizadas')
        .addSubcommand(sub =>
            sub.setName('criar')
                .setDescription('Cria uma nova playlist vazia')
                .addStringOption(opt => opt.setName('nome').setDescription('Nome da playlist').setRequired(true))
        )
        .addSubcommand(sub =>
            sub.setName('excluir')
                .setDescription('Deleta uma playlist existente')
                .addStringOption(opt => opt.setName('nome').setDescription('Nome da playlist').setRequired(true))
        )
        .addSubcommand(sub =>
            sub.setName('renomear')
                .setDescription('Altera o nome de uma playlist')
                .addStringOption(opt => opt.setName('antigo').setDescription('Nome atual da playlist').setRequired(true))
                .addStringOption(opt => opt.setName('novo').setDescription('Novo nome para a playlist').setRequired(true))
        )
        .addSubcommand(sub =>
            sub.setName('add')
                .setDescription('Adiciona uma música à playlist')
                .addStringOption(opt => opt.setName('playlist').setDescription('Nome da playlist').setRequired(true))
                .addStringOption(opt => opt.setName('musica').setDescription('Link ou busca da música').setRequired(true))
        )
        .addSubcommand(sub =>
            sub.setName('remover')
                .setDescription('Remove uma música da playlist pela posição')
                .addStringOption(opt => opt.setName('playlist').setDescription('Nome da playlist').setRequired(true))
                .addIntegerOption(opt => opt.setName('posicao').setDescription('Número da posição da música').setRequired(true))
        )
        .addSubcommand(sub =>
            sub.setName('mover')
                .setDescription('Altera a ordem de uma música na playlist')
                .addStringOption(opt => opt.setName('playlist').setDescription('Nome da playlist').setRequired(true))
                .addIntegerOption(opt => opt.setName('de').setDescription('Posição atual').setRequired(true))
                .addIntegerOption(opt => opt.setName('para').setDescription('Nova posição').setRequired(true))
        )
        .addSubcommand(sub =>
            sub.setName('listar')
                .setDescription('Lista suas playlists ou as músicas de uma delas')
                .addStringOption(opt => opt.setName('nome').setDescription('Nome da playlist (vazio para ver todas)').setRequired(false))
        )
        .addSubcommand(sub =>
            sub.setName('tocar')
                .setDescription('Adiciona todas as músicas de uma playlist à fila')
                .addStringOption(opt => opt.setName('nome').setDescription('Nome da playlist').setRequired(true))
        )
].map(command => command.toJSON());
const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
    try {
        console.log('🔄 Atualizando comandos em barra (/) na API do Discord...');
        await rest.put(
            Routes.applicationGuildCommands(CLIENT, "849794289805295617"),
            { body: commands }
        );
        console.log('✅ Todos os comandos em barra foram registrados globalmente!');
    } catch (error) {
        console.error(error);
    }
})();
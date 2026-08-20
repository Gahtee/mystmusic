const { REST, Routes } = require('discord.js');

const { TOKEN, CLIENT } = require("./env");

const GUILD_ID = "849794289805295617";

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
    try {
        console.log('🗑️ Iniciando a limpeza dos comandos antigos...');

        // 1. Limpa os comandos globais
        await rest.put(Routes.applicationCommands(CLIENT), { body: [] });
        console.log('✅ Comandos GLOBAIS limpos com sucesso.');

        // 2. Limpa os comandos locais do servidor (Se você preencheu o GUILD_ID)
        if (GUILD_ID && GUILD_ID !== "ID_DO_SEU_SERVIDOR_DE_TESTES_AQUI") {
            await rest.put(Routes.applicationGuildCommands(CLIENT, GUILD_ID), { body: [] });
            console.log('✅ Comandos DO SERVIDOR limpos com sucesso.');
        }

        console.log('✨ Tudo limpo! Agora você pode colocar o código original de volta e rodar o deploy novamente.');
    } catch (error) {
        console.error('❌ Erro ao limpar comandos:', error);
    }
})();
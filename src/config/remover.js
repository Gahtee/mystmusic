const { REST, Routes } = require('discord.js');

const { TOKEN, CLIENT, GUILDS } = require("./env");

if (!TOKEN || !CLIENT) {
    console.error('❌ TOKEN ou CLIENT ausentes no .env — abortando limpeza.');
    process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
    try {
        console.log('🗑️ Limpando slash commands...');

        // 1. Globais (propaga em até 1h — some sozinho depois)
        await rest.put(Routes.applicationCommands(CLIENT), { body: [] });
        console.log('✅ Comandos GLOBAIS limpos.');

        // 2. Por servidor (GUILDS do .env — efeito imediato)
        const guilds = [...new Set((GUILDS || []).filter(Boolean))];
        for (const guildId of guilds) {
            await rest.put(Routes.applicationGuildCommands(CLIENT, guildId), { body: [] });
            console.log(`✅ Comandos de ${guildId} limpos.`);
        }

        console.log('✨ Tudo limpo! Rode `npm run deploy` para registrar os novos.');
    } catch (error) {
        console.error('❌ Erro ao limpar comandos:', error);
        process.exit(1);
    }
})();

const { joinVoiceChannel, createAudioPlayer, entersState, VoiceConnectionStatus } = require("@discordjs/voice");
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { playStream } = require("./player");
const { getAudioMetadata, getAudioStream, getPlaylistMetadata, } = require("./resolver");
const { logsDb, playlistDb } = require("../config/sqlite");
const states = new Map();

function savePlayLog(guildId, userId, query, title, status, errorMessage = null) {
    const sql = `INSERT INTO play_logs (guild_id, requested_by, query, resolved_title, status, error_message) VALUES (?, ?, ?, ?, ?, ?)`;
    logsDb.run(sql, [guildId, userId, query, title, status, errorMessage]);
}

function criarPainelMusical(metadata) {
    const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('🎶 Tocando Agora')
        .setDescription(`**[${metadata.title}](${metadata.url})**`)
        .setThumbnail(metadata.thumbnail || null)
        .addFields(
            { name: '📺 Canal', value: metadata.uploader || "Desconhecido", inline: true },
            { name: '👤 Pedido por', value: `<@${metadata.requestedBy}>`, inline: true }
        )
        .setFooter({ text: 'MystMusic • Controle pelos botões abaixo' });
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('btn_restart')
            .setLabel('🔄')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('btn_stop')
            .setLabel('⏹️')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId('btn_skip')
            .setLabel('⏭️')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('btn_shuffle')
            .setLabel('🔀')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('btn_like')
            .setLabel('❤️ Curtir')
            .setStyle(ButtonStyle.Danger)
    );

    return { embeds: [embed], components: [row] };
}

function shuffleQueue(guildId) {
    const state = states.get(guildId);
    if (!state || state.queue.length <= 2) return false; 

    const musicaAtual = state.queue[0];
    const proximasMusicas = state.queue.slice(1);

    for (let i = proximasMusicas.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [proximasMusicas[i], proximasMusicas[j]] = [proximasMusicas[j], proximasMusicas[i]];
    }
    state.queue = [musicaAtual, ...proximasMusicas];
    return true;
}

// Gerenciador de painéis (envia o novo e tenta apagar o antigo)
async function enviarNovoPainel(channel, state, metadata) {
    if (state.lastPanelMessage) {
        try {
            await state.lastPanelMessage.delete();
        } catch (err) {
            // Ignora se a mensagem já tiver sido apagada manualmente
        }
    }
    const painel = criarPainelMusical(metadata);
    state.lastPanelMessage = await channel.send(painel);
}

async function play(message, query) {
    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) return message.reply("Entra num canal de voz primeiro!");

    const guildId = message.guild.id;
    let state = states.get(guildId);

    if (!state) {
        const connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: guildId,
            adapterCreator: message.guild.voiceAdapterCreator
        });

        try {
            await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
            console.log("✅ Conexão de voz estabelecida com sucesso!");
        } catch (error) {
            connection.destroy();
            return message.reply("A conexão com o Discord falhou.");
        }

        const serverPlayer = createAudioPlayer();
        connection.subscribe(serverPlayer);

        serverPlayer.on('error', error => {
            console.error(`Erro no player do servidor ${guildId}: ${error.message}`);
            serverPlayer.stop(); 
        });

        // Loop da Fila Automática (Quando a música termina)
        serverPlayer.on('stateChange', async (oldState, newState) => {
            if (newState.status === 'idle' && oldState.status !== 'idle') {
                const currentState = states.get(guildId);
                if (!currentState) return;

                currentState.queue.shift();

                if (currentState.queue.length > 0) {
                    currentState.current = currentState.queue[0]; 
                    
                    const nextStream = getAudioStream(currentState.current.url);
                    playStream(currentState.player, nextStream);

                    // Envia o painel automático para a próxima música
                    if (currentState.textChannel) {
                        await enviarNovoPainel(currentState.textChannel, currentState, currentState.current);
                    }

                    const quemPediu = currentState.current.requestedBy || "Fila Automática";
                    savePlayLog(guildId, quemPediu, currentState.current.query, currentState.current.title, "SUCCESS");
                } else {
                    currentState.current = null;
                }
            }
        });

        // Configuração inicial do Estado do Servidor
        state = { 
            connection, 
            player: serverPlayer, 
            queue: [], 
            current: null,
            textChannel: message.channel, // Salva o canal para usar no stateChange
            lastPanelMessage: null 
        };
        states.set(guildId, state);
    }

    try {
        if (query.includes('list=')) {
            message.reply("🔍 Processando playlist... Isso pode levar alguns segundos.");

            const { playlistTitle, songs } = await getPlaylistMetadata(query);
            
            if (!songs || songs.length === 0) {
                return message.reply("❌ Não encontrei nenhuma música válida nessa playlist.");
            }

            songs.forEach(song => {
                song.requestedBy = message.author.id;
                song.query = song.url;
                state.queue.push(song);
            });

            message.reply(`✅ **${songs.length} músicas** da playlist **"${playlistTitle}"** foram adicionadas à fila!`);

            if (state.queue.length === songs.length) {
                state.current = state.queue[0];
                const audioStream = getAudioStream(state.current.url);
                playStream(state.player, audioStream);
                
                await enviarNovoPainel(message.channel, state, state.current);
                savePlayLog(guildId, message.author.id, state.current.query, state.current.title, "SUCCESS");
            }
        } else {
            const metadata = await getAudioMetadata(query);
            metadata.requestedBy = message.author.id;
            metadata.query = query;

            state.queue.push(metadata);

            if (state.queue.length === 1) {
                state.current = metadata;
                const audioStream = getAudioStream(metadata.url); 
                playStream(state.player, audioStream);
                
                await enviarNovoPainel(message.channel, state, metadata);
                savePlayLog(guildId, message.author.id, query, metadata.title, "SUCCESS");
            } else {
                message.reply(`✅ Adicionado à fila: **${metadata.title}**`);
            }
        }
    } catch (error) {
        console.error("Erro no processamento:", error);
        message.reply("Deu erro ao buscar a música ou playlist.");
    }
}


async function playNow(message, query) {
    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) return message.reply("Entra num canal de voz primeiro!");

    const guildId = message.guild.id;
    let state = states.get(guildId);

    if (!state) {
        return play(message, query); 
    }

    try {

        if (query.includes('list=')) {
            message.reply("🔍 Processando fura-fila de playlist... Isso pode levar alguns segundos.");
            const { playlistTitle, songs } = await getPlaylistMetadata(query);
            
            if (!songs || songs.length === 0) {
                return message.reply("❌ Não encontrei nenhuma música válida nessa playlist.");
            }

            songs.reverse().forEach(song => {
                song.requestedBy = message.author.id;
                song.query = song.url;

                if (state.queue.length <= 1) {
                    state.queue.push(song);
                } else {
                    state.queue.splice(1, 0, song);
                }
            });

            message.reply(`⚡ **Fura-Fila:** **${songs.length} músicas** da playlist **"${playlistTitle}"** foram colocadas no topo da fila!`);

        } else {
            const metadata = await getAudioMetadata(query);
            metadata.requestedBy = message.author.id;
            metadata.query = query;

            if (state.queue.length <= 1) {
                state.queue.push(metadata);
            } else {
                state.queue.splice(1, 0, metadata);
            }

            message.reply(`⚡ **Fura-Fila:** **${metadata.title}** foi adicionada para ser a **próxima a tocar**!`);
        }
    } catch (error) {
        console.error("Erro no playNow:", error);
        message.reply("Deu erro ao processar o fura-fila.");
    }
}

function stop(guildId) {
    const state = states.get(guildId);
    if (!state) return;
    state.queue = [];
    state.current = null;
    state.player.stop();
    if (state.connection.state.status !== 'destroyed') {
        state.connection.destroy();
    }
    states.delete(guildId);
}

function skip(guildId) {
    const state = states.get(guildId);
    if (!state || !state.current) return false;
    state.player.stop(); 
    return true;
}

function restart(guildId) {
    const state = states.get(guildId);
    if (!state || !state.current) return false;
    state.queue.unshift(state.current);
    state.player.stop(); 
    return true;
}

function adicionarAosCurtidos(userId, track) {
    return new Promise((resolve, reject) => {
        playlistDb.run(
            `INSERT OR IGNORE INTO playlists (user_id, name) VALUES (?, 'Curtidas')`,
            [userId],
            function (err) {
                if (err) return reject(err);

                playlistDb.get(
                    `SELECT id FROM playlists WHERE user_id = ? AND name = 'Curtidas'`,
                    [userId],
                    (err, playlist) => {
                        if (err) return reject(err);
                        if (!playlist) return reject(new Error("Playlist não encontrada."));

                        const playlistId = playlist.id;

                        playlistDb.get(
                            `SELECT id FROM playlist_tracks WHERE playlist_id = ? AND url = ?`,
                            [playlistId, track.url],
                            (err, trackExiste) => {
                                if (err) return reject(err);
                                if (trackExiste) return resolve({ status: 'existe', title: track.title });

                                playlistDb.get(
                                    `SELECT COALESCE(MAX(position), 0) as maxPos FROM playlist_tracks WHERE playlist_id = ?`,
                                    [playlistId],
                                    (err, row) => {
                                        if (err) return reject(err);
                                        const proximaPosicao = row.maxPos + 1;

                                        playlistDb.run(
                                            `INSERT INTO playlist_tracks (playlist_id, title, url, thumbnail, uploader, position) 
                                             VALUES (?, ?, ?, ?, ?, ?)`,
                                            [playlistId, track.title, track.url, track.thumbnail || null, track.uploader || null, proximaPosicao],
                                            (err) => {
                                                if (err) return reject(err);
                                                resolve({ status: 'adicionado', title: track.title });
                                            }
                                        );
                                    }
                                );
                            }
                        );
                    }
                );
            }
        );
    });
}

// Certifique-se de que a playlistDb está importada no topo do manager.js
// const { playlistDb } = require('../../db/sqlite.js');
// const { getAudioMetadata } = require('./manager.js'); (ou como estiver aí)

// 1. Criar uma Playlist
function criarPlaylist(userId, name) {
    return new Promise((resolve, reject) => {
        playlistDb.run(
            `INSERT INTO playlists (user_id, name) VALUES (?, ?)`,
            [userId, name],
            function (err) {
                if (err) {
                    if (err.message.includes('UNIQUE')) return resolve({ status: 'existe' });
                    return reject(err);
                }
                resolve({ status: 'criado' });
            }
        );
    });
}

// 2. Excluir uma Playlist (O ON DELETE CASCADE deleta todas as músicas dela automaticamente)
function excluirPlaylist(userId, name) {
    return new Promise((resolve, reject) => {
        playlistDb.run(
            `DELETE FROM playlists WHERE user_id = ? AND name = ?`,
            [userId, name],
            function (err) {
                if (err) return reject(err);
                resolve(this.changes > 0); // Retorna true se deletou algo
            }
        );
    });
}

// 3. Renomear uma Playlist
function renomearPlaylist(userId, oldName, newName) {
    return new Promise((resolve, reject) => {
        playlistDb.run(
            `UPDATE playlists SET name = ? WHERE user_id = ? AND name = ?`,
            [newName, userId, oldName],
            function (err) {
                if (err) {
                    if (err.message.includes('UNIQUE')) return resolve({ status: 'duplicado' });
                    return reject(err);
                }
                resolve({ status: this.changes > 0 ? 'sucesso' : 'nao_encontrada' });
            }
        );
    });
}

// 4. Adicionar Música na Playlist por Nome/URL
async function adicionarFaixaPlaylist(userId, playlistName, query) {
    // Busca os metadados usando o resolvedor robusto do yt-dlp que arrumamos
    const track = await getAudioMetadata(query);

    return new Promise((resolve, reject) => {
        // Busca o ID da playlist
        playlistDb.get(
            `SELECT id FROM playlists WHERE user_id = ? AND name = ?`,
            [userId, playlistName],
            (err, playlist) => {
                if (err) return reject(err);
                if (!playlist) return resolve({ status: 'playlist_nao_encontrada' });

                const playlistId = playlist.id;

                // Verifica se a música já existe nela
                playlistDb.get(
                    `SELECT id FROM playlist_tracks WHERE playlist_id = ? AND url = ?`,
                    [playlistId, track.url],
                    (err, existe) => {
                        if (err) return reject(err);
                        if (existe) return resolve({ status: 'ja_existe', title: track.title });

                        // Pega a última posição para empurrar pro final da lista
                        playlistDb.get(
                            `SELECT COALESCE(MAX(position), 0) as maxPos FROM playlist_tracks WHERE playlist_id = ?`,
                            [playlistId],
                            (err, row) => {
                                if (err) return reject(err);
                                const proximaPosicao = row.maxPos + 1;

                                playlistDb.run(
                                    `INSERT INTO playlist_tracks (playlist_id, title, url, thumbnail, uploader, position) VALUES (?, ?, ?, ?, ?, ?)`,
                                    [playlistId, track.title, track.url, track.thumbnail, track.uploader, proximaPosicao],
                                    (err) => {
                                        if (err) return reject(err);
                                        resolve({ status: 'adicionado', title: track.title, pos: proximaPosicao });
                                    }
                                );
                            }
                        );
                    }
                );
            }
        );
    });
}

// 5. Remover Música da Playlist por Posição (e reorganizar os números das outras)
function removerFaixaPlaylist(userId, playlistName, posicao) {
    return new Promise((resolve, reject) => {
        playlistDb.get(
            `SELECT id FROM playlists WHERE user_id = ? AND name = ?`,
            [userId, playlistName],
            (err, playlist) => {
                if (err) return reject(err);
                if (!playlist) return resolve({ status: 'playlist_nao_encontrada' });

                const playlistId = playlist.id;

                // Verifica se a música existe naquela posição
                playlistDb.get(
                    `SELECT title FROM playlist_tracks WHERE playlist_id = ? AND position = ?`,
                    [playlistId, posicao],
                    (err, track) => {
                        if (err) return reject(err);
                        if (!track) return resolve({ status: 'posicao_invalida' });

                        playlistDb.serialize(() => {
                            // Deleta a música alvo
                            playlistDb.run(`DELETE FROM playlist_tracks WHERE playlist_id = ? AND position = ?`, [playlistId, posicao]);
                            // Ajusta a posição de todas as músicas que vinham depois dela (-1) para não deixar buracos na numeração
                            playlistDb.run(`UPDATE playlist_tracks SET position = position - 1 WHERE playlist_id = ? AND position > ?`, [playlistId, posicao]);
                        });

                        resolve({ status: 'removido', title: track.title });
                    }
                );
            }
        );
    });
}

function moverFaixaPlaylist(userId, playlistName, oldPos, newPos) {
    return new Promise((resolve, reject) => {
        playlistDb.get(
            `SELECT id FROM playlists WHERE user_id = ? AND name = ?`,
            [userId, playlistName],
            (err, playlist) => {
                if (err) return reject(err);
                if (!playlist) return resolve({ status: 'playlist_nao_encontrada' });

                const playlistId = playlist.id;

                playlistDb.get(
                    `SELECT COUNT(*) as total FROM playlist_tracks WHERE playlist_id = ?`,
                    [playlistId],
                    (err, row) => {
                        if (err) return reject(err);
                        if (oldPos < 1 || oldPos > row.total || newPos < 1 || newPos > row.total) {
                            return resolve({ status: 'fora_dos_limites', total: row.total });
                        }

                        if (oldPos === newPos) return resolve({ status: 'mesma_posicao' });
                        playlistDb.serialize(() => {
                            playlistDb.run(`UPDATE playlist_tracks SET position = -1 WHERE playlist_id = ? AND position = ?`, [playlistId, oldPos]);

                            if (oldPos > newPos) {
                                playlistDb.run(`UPDATE playlist_tracks SET position = position + 1 WHERE playlist_id = ? AND position >= ? AND position < ?`, [playlistId, newPos, oldPos]);
                            } else {
                                playlistDb.run(`UPDATE playlist_tracks SET position = position - 1 WHERE playlist_id = ? AND position > ? AND position <= ?`, [playlistId, oldPos, newPos]);
                            }
                            playlistDb.run(`UPDATE playlist_tracks SET position = ? WHERE playlist_id = ? AND position = -1`, [newPos, playlistId], (err) => {
                                if (err) return reject(err);
                                resolve({ status: 'sucesso' });
                            });
                        });
                    }
                );
            }
        );
    });
}

function criarPlaylist(userId, name) {
    return new Promise((resolve, reject) => {
        playlistDb.run(
            `INSERT INTO playlists (user_id, name) VALUES (?, ?)`,
            [userId, name],
            function (err) {
                if (err) {
                    if (err.message.includes('UNIQUE')) return resolve({ status: 'existe' });
                    return reject(err);
                }
                resolve({ status: 'criado' });
            }
        );
    });
}

function excluirPlaylist(userId, name) {
    return new Promise((resolve, reject) => {
        playlistDb.run(
            `DELETE FROM playlists WHERE user_id = ? AND name = ?`,
            [userId, name],
            function (err) {
                if (err) return reject(err);
                resolve(this.changes > 0);
            }
        );
    });
}

function renomearPlaylist(userId, oldName, newName) {
    return new Promise((resolve, reject) => {
        playlistDb.run(
            `UPDATE playlists SET name = ? WHERE user_id = ? AND name = ?`,
            [newName, userId, oldName],
            function (err) {
                if (err) {
                    if (err.message.includes('UNIQUE')) return resolve({ status: 'duplicado' });
                    return reject(err);
                }
                resolve({ status: this.changes > 0 ? 'sucesso' : 'nao_encontrada' });
            }
        );
    });
}

async function adicionarFaixaPlaylist(userId, playlistName, query) {
    const track = await getAudioMetadata(query);

    return new Promise((resolve, reject) => {
        playlistDb.get(
            `SELECT id FROM playlists WHERE user_id = ? AND name = ?`,
            [userId, playlistName],
            (err, playlist) => {
                if (err) return reject(err);
                if (!playlist) return resolve({ status: 'playlist_nao_encontrada' });

                const playlistId = playlist.id;

                playlistDb.get(
                    `SELECT id FROM playlist_tracks WHERE playlist_id = ? AND url = ?`,
                    [playlistId, track.url],
                    (err, existe) => {
                        if (err) return reject(err);
                        if (existe) return resolve({ status: 'ja_existe', title: track.title });

                        playlistDb.get(
                            `SELECT COALESCE(MAX(position), 0) as maxPos FROM playlist_tracks WHERE playlist_id = ?`,
                            [playlistId],
                            (err, row) => {
                                if (err) return reject(err);
                                const proximaPosicao = row.maxPos + 1;

                                playlistDb.run(
                                    `INSERT INTO playlist_tracks (playlist_id, title, url, thumbnail, uploader, position) VALUES (?, ?, ?, ?, ?, ?)`,
                                    [playlistId, track.title, track.url, track.thumbnail, track.uploader, proximaPosicao],
                                    (err) => {
                                        if (err) return reject(err);
                                        resolve({ status: 'adicionado', title: track.title, pos: proximaPosicao });
                                    }
                                );
                            }
                        );
                    }
                );
            }
        );
    });
}

function removerFaixaPlaylist(userId, playlistName, posicao) {
    return new Promise((resolve, reject) => {
        playlistDb.get(
            `SELECT id FROM playlists WHERE user_id = ? AND name = ?`,
            [userId, playlistName],
            (err, playlist) => {
                if (err) return reject(err);
                if (!playlist) return resolve({ status: 'playlist_nao_encontrada' });

                const playlistId = playlist.id;

                playlistDb.get(
                    `SELECT title FROM playlist_tracks WHERE playlist_id = ? AND position = ?`,
                    [playlistId, posicao],
                    (err, track) => {
                        if (err) return reject(err);
                        if (!track) return resolve({ status: 'posicao_invalida' });

                        playlistDb.serialize(() => {
                            playlistDb.run(`DELETE FROM playlist_tracks WHERE playlist_id = ? AND position = ?`, [playlistId, posicao]);
                            playlistDb.run(`UPDATE playlist_tracks SET position = position - 1 WHERE playlist_id = ? AND position > ?`, [playlistId, posicao]);
                        });

                        resolve({ status: 'removido', title: track.title });
                    }
                );
            }
        );
    });
}

function moverFaixaPlaylist(userId, playlistName, oldPos, newPos) {
    return new Promise((resolve, reject) => {
        playlistDb.get(
            `SELECT id FROM playlists WHERE user_id = ? AND name = ?`,
            [userId, playlistName],
            (err, playlist) => {
                if (err) return reject(err);
                if (!playlist) return resolve({ status: 'playlist_nao_encontrada' });

                const playlistId = playlist.id;

                playlistDb.get(
                    `SELECT COUNT(*) as total FROM playlist_tracks WHERE playlist_id = ?`,
                    [playlistId],
                    (err, row) => {
                        if (err) return reject(err);
                        if (oldPos < 1 || oldPos > row.total || newPos < 1 || newPos > row.total) {
                            return resolve({ status: 'fora_dos_limites', total: row.total });
                        }

                        if (oldPos === newPos) return resolve({ status: 'mesma_posicao' });
                        playlistDb.serialize(() => {
                            playlistDb.run(`UPDATE playlist_tracks SET position = -1 WHERE playlist_id = ? AND position = ?`, [playlistId, oldPos]);

                            if (oldPos > newPos) {
                                playlistDb.run(`UPDATE playlist_tracks SET position = position + 1 WHERE playlist_id = ? AND position >= ? AND position < ?`, [playlistId, newPos, oldPos]);
                            } else {
                                playlistDb.run(`UPDATE playlist_tracks SET position = position - 1 WHERE playlist_id = ? AND position > ? AND position <= ?`, [playlistId, oldPos, newPos]);
                            }
                            playlistDb.run(`UPDATE playlist_tracks SET position = ? WHERE playlist_id = ? AND position = -1`, [newPos, playlistId], (err) => {
                                if (err) return reject(err);
                                resolve({ status: 'sucesso' });
                            });
                        });
                    }
                );
            }
        );
    });
}

function listarPlaylist(userId, playlistName) {
    return new Promise((resolve, reject) => {
        playlistDb.get(
            `SELECT id FROM playlists WHERE user_id = ? AND name = ?`,
            [userId, playlistName],
            (err, playlist) => {
                if (err) return reject(err);
                if (!playlist) return resolve(null);

                playlistDb.all(
                    `SELECT title, position FROM playlist_tracks WHERE playlist_id = ? ORDER BY position ASC`,
                    [playlist.id],
                    (err, rows) => {
                        if (err) return reject(err);
                        resolve(rows);
                    }
                );
            }
        );
    });
}

function tocarPlaylist(message, userId, playlistName) {
    return new Promise((resolve, reject) => {
        playlistDb.get(
            `SELECT id FROM playlists WHERE user_id = ? AND name = ?`,
            [userId, playlistName],
            (err, playlist) => {
                if (err) return reject(err);
                if (!playlist) return resolve(false);
                playlistDb.all(
                    `SELECT * FROM playlist_tracks WHERE playlist_id = ? ORDER BY position ASC`,
                    [playlist.id],
                    async (err, tracks) => {
                        if (err) return reject(err);
                        if (tracks.length === 0) return resolve(false);
                        const primeiraFaixa = tracks.shift(); 
                        await play(message, primeiraFaixa.url); 
                        setTimeout(() => {
                            const guildId = message.guild.id;
                            const state = states.get(guildId);
                            
                            if (state) {
                                tracks.forEach(track => {
                                    state.queue.push({
                                        title: track.title,
                                        url: track.url,
                                        thumbnail: track.thumbnail,
                                        uploader: track.uploader,
                                        requestedBy: message.author.id
                                    });
                                });
                            }
                            resolve(true);
                        }, 1000);
                    }
                );
            }
        );
    });
}

function listarTodasPlaylists(userId) {
    return new Promise((resolve, reject) => {
        playlistDb.all(
            `SELECT p.name, COUNT(t.id) as total_musicas 
             FROM playlists p 
             LEFT JOIN playlist_tracks t ON p.id = t.playlist_id 
             WHERE p.user_id = ? 
             GROUP BY p.id`,
            [userId],
            (err, rows) => {
                if (err) return reject(err);
                resolve(rows); // Retorna um array de objetos: [{ name: 'Rock', total_musicas: 5 }]
            }
        );
    });
}

module.exports = { play, stop, skip, restart, playNow, criarPainelMusical, adicionarAosCurtidos, shuffleQueue,  criarPlaylist, excluirPlaylist, renomearPlaylist, adicionarFaixaPlaylist, removerFaixaPlaylist, moverFaixaPlaylist, tocarPlaylist, listarPlaylist, listarTodasPlaylists, states };
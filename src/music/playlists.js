// Grupo de playlists (e Curtidas) extraído de manager.js — mover verbatim,
// sem mudança de lógica. O manager injeta { play, states, MAX_QUEUE } via
// factory (criarModuloPlaylists) para evitar dependência circular: este
// módulo NÃO requer o manager. states é o MESMO Map do manager (nunca cópia).
// Requis diretos (sem circularidade): sqlite, resolver, spotify.
const { playlistDb } = require("../config/sqlite");
const { getAudioMetadata } = require("./resolver");
const { isSpotifyUrl, resolveSpotifyLink } = require("./spotify");

function criarModuloPlaylists({ play, states, MAX_QUEUE }) {
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
                if (trackExiste)
                  return resolve({ status: "existe", title: track.title });

                playlistDb.get(
                  `SELECT COALESCE(MAX(position), 0) as maxPos FROM playlist_tracks WHERE playlist_id = ?`,
                  [playlistId],
                  (err, row) => {
                    if (err) return reject(err);
                    const proximaPosicao = row.maxPos + 1;

                    playlistDb.run(
                      `INSERT INTO playlist_tracks (playlist_id, title, url, thumbnail, uploader, position) 
                                             VALUES (?, ?, ?, ?, ?, ?)`,
                      [
                        playlistId,
                        track.title,
                        track.url,
                        track.thumbnail || null,
                        track.uploader || null,
                        proximaPosicao,
                      ],
                      (err) => {
                        if (err) return reject(err);
                        resolve({ status: "adicionado", title: track.title });
                      },
                    );
                  },
                );
              },
            );
          },
        );
      },
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
          if (err.message.includes("UNIQUE"))
            return resolve({ status: "existe" });
          return reject(err);
        }
        resolve({ status: "criado" });
      },
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
      },
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
          if (err.message.includes("UNIQUE"))
            return resolve({ status: "duplicado" });
          return reject(err);
        }
        resolve({ status: this.changes > 0 ? "sucesso" : "nao_encontrada" });
      },
    );
  });
}

// 4. Adicionar Música na Playlist por Nome/URL
async function adicionarFaixaPlaylist(userId, playlistName, query) {
  // Link do Spotify: converte para "Título - Artista" e salva já resolvido no
  // YouTube (a busca real acontece aqui, uma vez só — não a cada !playlist tocar).
  if (isSpotifyUrl(query)) {
    const sp = await resolveSpotifyLink(query);
    if (sp.kind === "collection") {
      throw new Error(
        "❌ Esse link é uma coleção do Spotify (álbum/playlist/artista). Adicione faixas individuais ou use `!play <link>` para tocar a coleção.",
      );
    }
    const track = await getAudioMetadata(sp.query);
    query = track.url;
    return adicionarFaixaResolvida(userId, playlistName, track);
  }
  // Busca os metadados usando o resolvedor robusto do yt-dlp que arrumamos
  const track = await getAudioMetadata(query);
  return adicionarFaixaResolvida(userId, playlistName, track);
}

// Insere uma faixa já resolvida (metadados prontos) na playlist do usuário.
function adicionarFaixaResolvida(userId, playlistName, track) {
  return new Promise((resolve, reject) => {
    // Busca o ID da playlist
    playlistDb.get(
      `SELECT id FROM playlists WHERE user_id = ? AND name = ?`,
      [userId, playlistName],
      (err, playlist) => {
        if (err) return reject(err);
        if (!playlist) return resolve({ status: "playlist_nao_encontrada" });

        const playlistId = playlist.id;

        // Verifica se a música já existe nela
        playlistDb.get(
          `SELECT id FROM playlist_tracks WHERE playlist_id = ? AND url = ?`,
          [playlistId, track.url],
          (err, existe) => {
            if (err) return reject(err);
            if (existe)
              return resolve({ status: "ja_existe", title: track.title });

            // Pega a última posição para empurrar pro final da lista
            playlistDb.get(
              `SELECT COALESCE(MAX(position), 0) as maxPos FROM playlist_tracks WHERE playlist_id = ?`,
              [playlistId],
              (err, row) => {
                if (err) return reject(err);
                const proximaPosicao = row.maxPos + 1;

                playlistDb.run(
                  `INSERT INTO playlist_tracks (playlist_id, title, url, thumbnail, uploader, duration, position) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                  [
                    playlistId,
                    track.title,
                    track.url,
                    track.thumbnail,
                    track.uploader,
                    track.duration,
                    proximaPosicao,
                  ],
                  (err) => {
                    if (err) return reject(err);
                    resolve({
                      status: "adicionado",
                      title: track.title,
                      pos: proximaPosicao,
                    });
                  },
                );
              },
            );
          },
        );
      },
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
        if (!playlist) return resolve({ status: "playlist_nao_encontrada" });

        const playlistId = playlist.id;

        // Verifica se a música existe naquela posição
        playlistDb.get(
          `SELECT title FROM playlist_tracks WHERE playlist_id = ? AND position = ?`,
          [playlistId, posicao],
          (err, track) => {
            if (err) return reject(err);
            if (!track) return resolve({ status: "posicao_invalida" });

            // Encadeia via callbacks: só resolve DEPOIS que DELETE +
            // UPDATE terminarem (o código antigo resolvia antes).
            playlistDb.run(
              `DELETE FROM playlist_tracks WHERE playlist_id = ? AND position = ?`,
              [playlistId, posicao],
              (err) => {
                if (err) return reject(err);
                // Ajusta a posição de todas as músicas que vinham depois dela (-1) para não deixar buracos na numeração
                playlistDb.run(
                  `UPDATE playlist_tracks SET position = position - 1 WHERE playlist_id = ? AND position > ?`,
                  [playlistId, posicao],
                  (err) => {
                    if (err) return reject(err);
                    resolve({ status: "removido", title: track.title });
                  },
                );
              },
            );
          },
        );
      },
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
        if (!playlist) return resolve({ status: "playlist_nao_encontrada" });

        const playlistId = playlist.id;

        playlistDb.get(
          `SELECT COUNT(*) as total FROM playlist_tracks WHERE playlist_id = ?`,
          [playlistId],
          (err, row) => {
            if (err) return reject(err);
            if (
              oldPos < 1 ||
              oldPos > row.total ||
              newPos < 1 ||
              newPos > row.total
            ) {
              return resolve({ status: "fora_dos_limites", total: row.total });
            }

            if (oldPos === newPos) return resolve({ status: "mesma_posicao" });
            playlistDb.serialize(() => {
              playlistDb.run(
                `UPDATE playlist_tracks SET position = -1 WHERE playlist_id = ? AND position = ?`,
                [playlistId, oldPos],
              );

              if (oldPos > newPos) {
                playlistDb.run(
                  `UPDATE playlist_tracks SET position = position + 1 WHERE playlist_id = ? AND position >= ? AND position < ?`,
                  [playlistId, newPos, oldPos],
                );
              } else {
                playlistDb.run(
                  `UPDATE playlist_tracks SET position = position - 1 WHERE playlist_id = ? AND position > ? AND position <= ?`,
                  [playlistId, oldPos, newPos],
                );
              }
              playlistDb.run(
                `UPDATE playlist_tracks SET position = ? WHERE playlist_id = ? AND position = -1`,
                [newPos, playlistId],
                (err) => {
                  if (err) return reject(err);
                  resolve({ status: "sucesso" });
                },
              );
            });
          },
        );
      },
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
          },
        );
      },
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
            try {
              // Toca a 1ª faixa e espera a sessão existir antes de
              // enfileirar o resto — sem o setTimeout(1000) antigo,
              // que perdia faixas se o play() demorasse mais que isso.
              const [primeiraFaixa, ...resto] = tracks;
              await play(message, primeiraFaixa.url);

              const guildId = message.guild.id;
              const state = states.get(guildId);
              if (!state) return resolve(false);

              const espacoLivre = Math.max(0, MAX_QUEUE - state.queue.length);
              const paraAdicionar = resto.slice(0, espacoLivre);
              paraAdicionar.forEach((track) => {
                state.queue.push({
                  title: track.title,
                  url: track.url,
                  thumbnail: track.thumbnail,
                  uploader: track.uploader,
                  duration: track.duration,
                  isOpus: null,
                  query: track.url,
                  requestedBy: message.author.id,
                });
              });
              resolve(true);
            } catch (playErr) {
              reject(playErr);
            }
          },
        );
      },
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
      },
    );
  });
}

// Retorna todas as playlists do servidor agrupadas por user_id.
// Resultado: [{ user_id: '123', playlists: [{ name: 'Rock', total_musicas: 5 }, ...] }, ...]
function listarPlaylistsDoServidor() {
  return new Promise((resolve, reject) => {
    playlistDb.all(
      `SELECT p.user_id, p.name, COUNT(t.id) as total_musicas
             FROM playlists p
             LEFT JOIN playlist_tracks t ON p.id = t.playlist_id
             GROUP BY p.id
             ORDER BY p.user_id, p.name ASC`,
      [],
      (err, rows) => {
        if (err) return reject(err);
        // Agrupa por user_id
        const map = new Map();
        for (const row of rows) {
          if (!map.has(row.user_id)) map.set(row.user_id, []);
          map
            .get(row.user_id)
            .push({ name: row.name, total_musicas: row.total_musicas });
        }
        resolve(
          [...map.entries()].map(([user_id, playlists]) => ({
            user_id,
            playlists,
          })),
        );
      },
    );
  });
}


  return {
    adicionarAosCurtidos,
    criarPlaylist,
    excluirPlaylist,
    renomearPlaylist,
    adicionarFaixaPlaylist,
    removerFaixaPlaylist,
    moverFaixaPlaylist,
    listarPlaylist,
    tocarPlaylist,
    listarTodasPlaylists,
    listarPlaylistsDoServidor,
  };
}

module.exports = { criarModuloPlaylists };

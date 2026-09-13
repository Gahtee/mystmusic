const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");

// Caminhos para os arquivos de banco de dados
const logsDbPath = path.resolve(__dirname, "../../db/logs.db");
const playlistDbPath = path.resolve(__dirname, "../../db/playlists.db");

// Inicializa as conexões
const logsDb = new sqlite3.Database(logsDbPath);
const playlistDb = new sqlite3.Database(playlistDbPath);

// Carrega os schemas
const playLogsSchema = fs.readFileSync(
  path.resolve(__dirname, "../../db/play_logs.sql"),
  "utf-8",
);

const playlistSchema = fs.readFileSync(
  path.resolve(__dirname, "../../db/playlist.sql"),
  "utf-8",
);

// Executa os schemas nos respectivos bancos
logsDb.serialize(() => {
  logsDb.exec(playLogsSchema, (err) => {
    if (err) console.error("Erro ao criar tabela de logs:", err.message);
  });
});

playlistDb.serialize(() => {
  playlistDb.exec(playlistSchema, (err) => {
    if (err) console.error("Erro ao criar tabela de playlists:", err.message);
  });
  // Migração: adiciona a coluna "duration" em bancos criados antes dela existir.
  // ALTER TABLE ADD COLUMN dá erro se a coluna já existe — nesse caso é esperado, ignora.
  playlistDb.run(
    `ALTER TABLE playlist_tracks ADD COLUMN duration INTEGER`,
    (err) => {
      if (err && !/duplicate column name/i.test(err.message)) {
        console.error("Erro na migração da coluna 'duration':", err.message);
      }
    },
  );
});

// Exporta as duas instâncias para usar no restante do bot
module.exports = {
  logsDb,
  playlistDb,
};

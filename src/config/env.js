require("dotenv").config({
  path: process.env.DOTENV_FILE || ".env",
});

// Prefixo dos comandos de texto ("!" no principal, "." no segundo).
// Normaliza: vazio/espaço volta para "!". Aceita 1+ chars (ex: "!", ".", "m!").
function normalizePrefix(v) {
  if (v === undefined || v === null) return "!";
  const s = String(v).trim();
  return s.length > 0 ? s : "!";
}

function normalizeBool(v, def = true) {
  if (v === undefined || v === null || v === "") return def;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "sim", "on"].includes(s)) return true;
  if (["0", "false", "no", "nao", "não", "off"].includes(s)) return false;
  return def;
}

module.exports = {
  TOKEN: process.env.TOKEN,
  USER: process.env.USER,
  SECRET: process.env.SECRET,
  CLIENT: process.env.CLIENT,
  // IDs do Discord dos donos (separados por vírgula). Usado pelo SFX de entrada.
  // NÃO reaproveitar USER: no Linux $USER já existe (usuário do SO, ex: gahtee)
  // e o dotenv não sobrescreve variável de ambiente existente — chegaria errado.
  OWNER_IDS: process.env.OWNER_IDS || process.env.OWNER_ID || "",
  GUILDS: process.env.GUILDS
    ? process.env.GUILDS.split(",").map((id) => id.trim())
    : [],
  PREFIX: normalizePrefix(process.env.PREFIX),
  // Nome do processo no pm2 (usado pelo !botmorreu para reiniciar o CERTO).
  PM2_NAME: (process.env.PM2_NAME || "mystmusic").trim() || "mystmusic",
  // Segundo bot pode operar só no prefixo (evita resposta dupla nos /slash,
  // que são por bot e o Discord mostraria os dois).
  ENABLE_SLASH: normalizeBool(process.env.ENABLE_SLASH, true),
  // ── Spotify Web API (Client Credentials) ──
  // Sem isso o bot usa embed público (~50 faixas/playlist, ~10 top tracks/artista).
  // Com ID + SECRET, resolveSpotifyLink pode paginar /v1/playlists/{id}/tracks
  // (limit=100 + offset) e pegar playlists de qualquer tamanho.
  // Criar app em https://developer.spotify.com/dashboard → Client ID + Client Secret.
  SPOTIFY_CLIENT_ID: (process.env.SPOTIFY_CLIENT_ID || "").trim(),
  SPOTIFY_CLIENT_SECRET: (process.env.SPOTIFY_CLIENT_SECRET || "").trim(),
};

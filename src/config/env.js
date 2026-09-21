require("dotenv").config();

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
};

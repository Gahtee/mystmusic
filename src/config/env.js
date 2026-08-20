require("dotenv").config();

module.exports = {
  TOKEN: process.env.TOKEN,
  USER: process.env.USER,
  SECRET: process.env.SECRET,
  CLIENT: process.env.CLIENT,
  GUILDS: process.env.GUILDS
    ? process.env.GUILDS.split(",").map(id => id.trim())
    : []
};
// pm2: dois frontends dividindo o mesmo banco (db/*.db em WAL).
//   pm2 start ecosystem.config.js        # sobe mystmusic + mystmusic2
//   pm2 restart mystmusic                # só o principal (!)
//   pm2 restart mystmusic2               # só o segundo (.)
//   pm2 logs mystmusic --lines 30 --nostream
//
// Pré-requisito: crie o 2º app no Developer Portal e copie
// .env.bot2.example → .env.bot2 com TOKEN/CLIENT do bot 2.
module.exports = {
  apps: [
    {
      name: "mystmusic",
      script: "src/index.js",
      cwd: __dirname,
      env: {
        NODE_ENV: "production",
        DOTENV_FILE: ".env",
        PM2_NAME: "mystmusic",
      },
    },
    {
      name: "mystmusic2",
      script: "src/index.js",
      cwd: __dirname,
      env: {
        NODE_ENV: "production",
        DOTENV_FILE: ".env.bot2",
        PM2_NAME: "mystmusic2",
      },
    },
  ],
};

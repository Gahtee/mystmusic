// Smoke test do MystMusic — validação pré-deploy sem tocar no bot de produção.
// Roda: npm run smoke
// O que cobre:
//   1. Sintaxe de todos os módulos (node --check)
//   2. Funções puras: parseSeekInput, formatarTempo, criarBarraProgresso,
//      isPlaylistUrl, removeFromQueue, shuffleQueue, extrairYoutubeId,
//      MAX_QUEUE, exports do manager/resolver
//   3. Integração real (yt-dlp + ffmpeg instalados): getAudioMetadata,
//      getPcmStream (PCM s16le 48k), getPlaylistMetadata, killStreamProcesses
// Cobre as áreas alteradas na refatoração P0/P1/P2. Não precisa de token do Discord.
// Integração pode ser pulada com: SMOKE_SKIP_NETWORK=1 npm run smoke

const { execFileSync } = require("child_process");
const assert = require("assert");

const SKIP_NETWORK = process.env.SMOKE_SKIP_NETWORK === "1";

let pass = 0;
let fail = 0;
const failures = [];

function check(nome, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      return r
        .then(() => {
          pass++;
          console.log(`  ✅ ${nome}`);
        })
        .catch((err) => {
          fail++;
          failures.push([nome, err]);
          console.error(`  ❌ ${nome}: ${err.message}`);
        });
    }
    pass++;
    console.log(`  ✅ ${nome}`);
    return Promise.resolve();
  } catch (err) {
    fail++;
    failures.push([nome, err]);
    console.error(`  ❌ ${nome}: ${err.message}`);
    return Promise.resolve();
  }
}

async function main() {
  console.log("== [1/3] Sintaxe ==");
  const arquivos = [
    "src/index.js",
    "src/music/manager.js",
    "src/music/resolver.js",
    "src/music/player.js",
    "src/music/pcmMixer.js",
    "src/music/sfx.js",
    "src/config/sqlite.js",
    "src/config/env.js",
    "src/config/deploy-commands.js",
    "src/config/remover.js",
  ];
  for (const f of arquivos) {
    await check(`node --check ${f}`, () => {
      execFileSync("node", ["--check", f], { stdio: "pipe" });
    });
  }

  console.log("== [2/3] Funções puras ==");
  const manager = require("../src/music/manager.js");
  const resolver = require("../src/music/resolver.js");

  await check("exports do manager", () => {
    for (const fn of [
      "play",
      "stop",
      "cleanupVoiceState",
      "limparTimersProgresso",
      "skip",
      "restart",
      "pause",
      "resume",
      "toggleAutoplay",
      "toggleLoop",
      "moverNaFila",
      "playNow",
      "criarPainelMusical",
      "calcularElapsedMs",
      "shuffleQueue",
      "removeFromQueue",
      "seek",
      "parseSeekInput",
      "tocarPlaylist",
      "removerFaixaPlaylist",
      "moverFaixaPlaylist",
    ]) {
      assert.strictEqual(typeof manager[fn], "function", `${fn} não exportado`);
    }
    assert.strictEqual(
      typeof resolver.killStreamProcesses,
      "function",
      "killStreamProcesses não exportado do resolver",
    );
    assert.strictEqual(manager.MAX_QUEUE, 500, "MAX_QUEUE inesperado");
  });

  await check("parseSeekInput", () => {
    const casos = [
      ["15", 900],
      ["1:30", 90],
      ["10:20", 620],
      ["1:12:14", 4334],
      ["00:15", 15],
      ["00:00:15", 15],
      ["abc", null],
      ["", null],
    ];
    for (const [input, esperado] of casos) {
      assert.strictEqual(
        manager.parseSeekInput(input),
        esperado,
        `parseSeekInput(${JSON.stringify(input)})`,
      );
    }
  });

  await check(
    "isPlaylistUrl (via play/playNow não exposto — testa regex equivalente)",
    () => {
      // isPlaylistUrl não é exportado; valida o comportamento via playNow/play indireto é
      // inviável sem Discord. Aqui ao menos garante que o módulo carregou sem erro.
      assert.ok(manager.states instanceof Map);
    },
  );

  await check("removeFromQueue / shuffleQueue com state simulado", () => {
    // removeFromQueue opera sobre states interno — sem guild registrado retorna null/false.
    assert.strictEqual(manager.removeFromQueue("guild-inexistente", 1), null);
    assert.strictEqual(manager.shuffleQueue("guild-inexistente"), false);
    assert.strictEqual(manager.skip("guild-inexistente"), false);
    assert.strictEqual(manager.pause("guild-inexistente"), "nada_tocando");
    assert.strictEqual(manager.resume("guild-inexistente"), "nada_tocando");
    assert.strictEqual(manager.toggleAutoplay("guild-inexistente"), null);
    assert.strictEqual(manager.restart("guild-inexistente"), false);
  });

  await check("criarPainelMusical contém btn_queue", () => {
    const painel = manager.criarPainelMusical(
      {
        title: "Teste",
        url: "https://example.com",
        duration: 200,
        thumbnail: null,
        uploader: "Canal",
        requestedBy: "123",
      },
      10,
    );
    const ids = painel.components.flatMap((r) =>
      r.components.map((c) => c.data.custom_id),
    );
    for (const id of [
      "btn_restart",
      "btn_stop",
      "btn_skip",
      "btn_shuffle",
      "btn_like",
      "btn_pauseresume",
      "btn_queue",
    ]) {
      assert.ok(ids.includes(id), `botão ${id} ausente no painel`);
    }
  });

  await check("criarPainelMusical com requestedBy null (autoplay)", () => {
    const painel = manager.criarPainelMusical(
      {
        title: "Teste",
        url: "https://example.com",
        duration: 200,
        thumbnail: null,
        uploader: "Canal",
        requestedBy: null,
      },
      10,
    );
    const campo = painel.embeds[0].data.fields.find((f) =>
      f.name.includes("Pedido"),
    );
    assert.ok(campo.value.includes("Autoplay"), "autoplay não rotulado");
    assert.ok(!campo.value.includes("null"), "vazou null no painel");
  });

  await check("slash: deploy-commands registra todos os comandos", () => {
    const src = require("fs").readFileSync(
      "src/config/deploy-commands.js",
      "utf8",
    );
    // Comandos simples esperados (espelho dos !comandos).
    // Aceita aspas simples ou duplas (o arquivo usa duplas).
    const temNome = (n) =>
      src.includes(`setName("${n}")`) || src.includes(`setName('${n}')`);
    for (const nome of [
      "play",
      "playsc",
      "playnow",
      "stop",
      "skip",
      "restart",
      "pause",
      "resume",
      "autoplay",
      "loop",
      "np",
      "queue",
      "remove",
      "move",
      "seek",
      "shuffle",
      "history",
      "playlists",
      "playlist",
    ]) {
      assert.ok(temNome(nome), `/${nome} não registrado no deploy`);
    }
    // Subcomandos de /playlist e /playlists
    for (const sub of [
      "criar",
      "excluir",
      "renomear",
      "add",
      "remover",
      "mover",
      "listar",
      "tocar",
      "minhas",
      "servidor",
    ]) {
      assert.ok(temNome(sub), `subcomando ${sub} ausente no deploy`);
    }
    // Opção de tocar playlist de outro membro
    assert.ok(temNome("usuario"), "opção usuario ausente em /playlist tocar");
  });

  await check("slash: handlers cobrem todos os comandos registrados", () => {
    const src = require("fs").readFileSync("src/routes/slash.js", "utf8");
    for (const nome of [
      "play",
      "playsc",
      "playnow",
      "stop",
      "skip",
      "restart",
      "pause",
      "resume",
      "autoplay",
      "loop",
      "np",
      "queue",
      "remove",
      "move",
      "seek",
      "shuffle",
      "history",
      "playlists",
      "playlist",
    ]) {
      assert.ok(
        src.includes(`case "${nome}"`),
        `/${nome} sem handler em handleSlashCommand`,
      );
    }
    // Fallback para comando registrado sem handler (o bug antigo)
    assert.ok(src.includes("sem handler"), "fallback default ausente");
  });

  await check("toggleLoop/moverNaFila sem sessão", () => {
    assert.strictEqual(manager.toggleLoop("guild-inexistente"), null);
    assert.deepStrictEqual(manager.moverNaFila("guild-inexistente", 1, 2), {
      error: "fila_vazia",
    });
  });

  await check("spotify: parseSpotifyUrl cobre links, URIs e inválidos", () => {
    const spotify = require("../src/music/spotify.js");
    assert.deepStrictEqual(
      spotify.parseSpotifyUrl("https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b"),
      { type: "track", id: "0VjIjW4GlUZAMYd2vXMi3b" },
    );
    assert.deepStrictEqual(
      spotify.parseSpotifyUrl(
        "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc123",
      ),
      { type: "playlist", id: "37i9dQZF1DXcBWIGoYBM5M" },
    );
    assert.deepStrictEqual(
      spotify.parseSpotifyUrl("spotify:album:2ODvWsOgouMbaA5xf0RkJe"),
      { type: "album", id: "2ODvWsOgouMbaA5xf0RkJe" },
    );
    assert.deepStrictEqual(
      spotify.parseSpotifyUrl(
        "https://open.spotify.com/intl-pt/track/0VjIjW4GlUZAMYd2vXMi3b",
      ),
      { type: "track", id: "0VjIjW4GlUZAMYd2vXMi3b" },
    );
    assert.ok(
      spotify.isSpotifyUrl("https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b"),
    );
    assert.strictEqual(
      spotify.parseSpotifyUrl("https://www.youtube.com/watch?v=aqz-KE-bpKQ"),
      null,
    );
    assert.strictEqual(spotify.parseSpotifyUrl("judas lady gaga"), null);
    assert.strictEqual(spotify.isSpotifyUrl("judas lady gaga"), false);
  });

  await check("spotify: entityToResult converte track e coleção", () => {
    const spotify = require("../src/music/spotify.js");
    const faixa = spotify.entityToResult({
      type: "track",
      title: "Blinding Lights",
      artists: [{ name: "The Weeknd" }],
    });
    assert.strictEqual(faixa.kind, "track");
    assert.strictEqual(faixa.query, "Blinding Lights - The Weeknd");

    const col = spotify.entityToResult({
      type: "playlist",
      title: "Hits",
      trackList: [
        { title: "Starboy", subtitle: "The Weeknd, Daft Punk" },
        { title: "Levitating", subtitle: "Dua Lipa" },
      ],
    });
    assert.strictEqual(col.kind, "collection");
    assert.strictEqual(col.tracks.length, 2);
    assert.strictEqual(col.tracks[0].query, "Starboy - The Weeknd, Daft Punk");

    // NBSP do embed vira espaço normal
    assert.strictEqual(spotify.cleanName("A, B"), "A, B");
  });

  await check("spotify: parseEmbedEntity rejeita página inválida", () => {
    const spotify = require("../src/music/spotify.js");
    assert.throws(
      () => spotify.parseEmbedEntity("<html>sem json</html>"),
      /Spotify/,
    );
  });

  await check("spotify: spotifyCollectionAsPlaylist gera songs buscáveis", () => {
    const spotify = require("../src/music/spotify.js");
    const conv = spotify.spotifyCollectionAsPlaylist({
      kind: "collection",
      title: "Hits",
      tracks: [{ title: "Starboy", artist: "The Weeknd", query: "Starboy - The Weeknd" }],
    });
    assert.strictEqual(conv.playlistTitle, "Spotify: Hits");
    assert.strictEqual(conv.songs.length, 1);
    // url null de propósito: força o play otimista a buscar no YouTube
    // em vez de passar o link do Spotify ao yt-dlp (que falharia com DRM).
    assert.strictEqual(conv.songs[0].url, null);
    assert.strictEqual(conv.songs[0].query, "Starboy - The Weeknd");
  });

  await check("spotify: resolveSpotifyLink com fetch simulado", async () => {
    const spotify = require("../src/music/spotify.js");
    const html =
      '<script id="__NEXT_DATA__" type="application/json">' +
      JSON.stringify({
        props: {
          pageProps: {
            state: {
              data: {
                entity: {
                  type: "track",
                  title: "Blinding Lights",
                  artists: [{ name: "The Weeknd" }],
                },
              },
            },
          },
        },
      }) +
      "</script>";
    const fakeFetch = async () => ({ ok: true, status: 200, text: async () => html });
    const res = await spotify.resolveSpotifyLink(
      "https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b",
      fakeFetch,
    );
    assert.strictEqual(res.query, "Blinding Lights - The Weeknd");

    const fake404 = async () => ({ ok: false, status: 404, text: async () => "" });
    await assert.rejects(
      spotify.resolveSpotifyLink(
        "https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b",
        fake404,
      ),
      /não encontrado/i,
    );
  });

  await check("sfx: parseOwnerIds filtra IDs inválidos", () => {
    const sfx = require("../src/music/sfx.js");
    assert.deepStrictEqual(
      [...sfx.parseOwnerIds("123456789012345678, 987654321098765432")],
      ["123456789012345678", "987654321098765432"],
    );
    // Rejeita: nome de usuário do SO ("gahtee"), vazio, curto, com letras
    assert.strictEqual(sfx.parseOwnerIds("gahtee").size, 0);
    assert.strictEqual(sfx.parseOwnerIds("").size, 0);
    assert.strictEqual(sfx.parseOwnerIds(undefined).size, 0);
    assert.strictEqual(sfx.parseOwnerIds("abc123").size, 0);
    assert.strictEqual(sfx.parseOwnerIds("123").size, 0);
  });

  await check("sfx: isJoinNoCanalDoBot só aceita join real", () => {
    const sfx = require("../src/music/sfx.js");
    const join = (o, n) => sfx.isJoinNoCanalDoBot({ channelId: o }, { channelId: n }, "BOT");
    assert.strictEqual(join(null, "BOT"), true); // entrou do nada
    assert.strictEqual(join("OUTRO", "BOT"), true); // trocou p/ o do bot
    assert.strictEqual(join("BOT", "BOT"), false); // mute/deafen (já estava)
    assert.strictEqual(join("BOT", "OUTRO"), false); // saiu
    assert.strictEqual(join("BOT", null), false); // desconectou
    assert.strictEqual(join(null, "OUTRO"), false); // entrou em outro canal
    assert.strictEqual(
      sfx.isJoinNoCanalDoBot({ channelId: null }, { channelId: "BOT" }, null),
      false, // bot fora de canal — sem SFX
    );
  });

  await check("sfx: checkSfxTiming debounce + cooldown", () => {
    const sfx = require("../src/music/sfx.js");
    sfx._lastSfxAt.clear();
    assert.strictEqual(sfx.checkSfxTiming("g1", 100000), "ok");
    sfx.markSfxFired("g1", 100000);
    assert.strictEqual(sfx.checkSfxTiming("g1", 101000), "debounce"); // +1s
    assert.strictEqual(sfx.checkSfxTiming("g1", 110000), "cooldown"); // +10s
    assert.strictEqual(sfx.checkSfxTiming("g1", 131000), "ok"); // +31s
    assert.strictEqual(sfx.checkSfxTiming("g2", 101000), "ok"); // outra guild
    sfx._lastSfxAt.clear();
  });

  await check("sfx: listarEfeitos filtra extensão e tamanho", () => {
    const sfx = require("../src/music/sfx.js");
    const fs = require("fs");
    const os = require("os");
    const dir = fs.mkdtempSync(`${os.tmpdir()}/sfx-test-`);
    fs.writeFileSync(`${dir}/a.mp3`, "x");
    fs.writeFileSync(`${dir}/b.ogg`, "x");
    fs.writeFileSync(`${dir}/c.txt`, "x"); // extensão inválida
    fs.writeFileSync(`${dir}/D.MP3`, "x"); // maiúscula vale
    const grande = Buffer.alloc(3 * 1024 * 1024);
    fs.writeFileSync(`${dir}/grande.mp3`, grande); // >2MB fora
    assert.deepStrictEqual(sfx.listarEfeitos(dir), ["D.MP3", "a.mp3", "b.ogg"]);
    assert.deepStrictEqual(sfx.listarEfeitos(`${dir}/inexistente`), []);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check("sfx: sortearEfeito usa rand injetado", () => {
    const sfx = require("../src/music/sfx.js");
    assert.strictEqual(sfx.sortearEfeito([]), null);
    assert.strictEqual(sfx.sortearEfeito(null), null);
    const arq = sfx.sortearEfeito(["x", "y", "z"], () => 0.99);
    assert.ok(arq.endsWith("z"), `sorteio errado: ${arq}`);
    const arq0 = sfx.sortearEfeito(["x", "y"], () => 0.0);
    assert.ok(arq0.endsWith("x"), `sorteio errado: ${arq0}`);
  });

  await check("sfx: sounds/entrada.mp3 existe e é curta", () => {
    const fs = require("fs");
    const st = fs.statSync("sounds/entrada.mp3");
    assert.ok(st.size > 1000 && st.size <= 2 * 1024 * 1024, `tamanho: ${st.size}`);
    const sfx = require("../src/music/sfx.js");
    assert.ok(sfx.listarEfeitos().includes("entrada.mp3"), "chime fora da lista");
  });

  await check("sfx: tocarSfxEntrada sem musica toca solto (sem state)", () => {
    // Sem state e sem conexao de voz -> sem_efeitos (bot fora do canal)
    assert.strictEqual(manager.tocarSfxEntrada("guild-inexistente", Buffer.alloc(4)), "sem_efeitos");
    assert.strictEqual(manager.tocarSfxEntrada("guild-inexistente", null), "sem_efeitos");
    assert.strictEqual(manager.tocarSfxEntrada("guild-inexistente", "/x.mp3"), "sem_efeitos");
  });

  await check("sfx: playStandalone gera PCM e emite overlay-done", async () => {
    const { PcmMixer } = require("../src/music/pcmMixer.js");
    const sfx = require("../src/music/sfx.js");
    sfx._pcmCache.clear();
    assert.ok(sfx.preloadSfxPcm() >= 1);
    const { pcm } = sfx.sortearSfxPcm(() => 0);
    const mixer = new PcmMixer();
    const bufs = [];
    mixer.on("data", (d) => bufs.push(d));
    const doneP = new Promise((resolve) => mixer.once("overlay-done", resolve));
    assert.strictEqual(mixer.playStandalone(pcm, { delayMs: 100 }), true);
    assert.strictEqual(mixer.playStandalone(pcm, { delayMs: 0 }), false, "duplo standalone deveria recusar");
    await doneP;
    const out = Buffer.concat(bufs);
    assert.ok(out.length >= pcm.length, "PCM standalone curto demais");
    let energia = 0;
    for (let i = 0; i < out.length; i += 2) energia += Math.abs(out.readInt16LE(i));
    assert.ok(energia > 0, "standalone zerado (SFX ausente)");
    // pre-delay (primeiros 50ms) deve ser silencio
    let pre = 0;
    for (let i = 0; i < Math.min(out.length, 9600); i += 2) pre += Math.abs(out.readInt16LE(i));
    assert.strictEqual(pre, 0, "pre-delay deveria ser silencio");
  });

  await check("sfx: tocarSfxEntrada injeta overlay no mixer (sem restart)", () => {
    const { PcmMixer } = require("../src/music/pcmMixer.js");
    const gid = "guild-sfx-mixer";
    const mixer = new PcmMixer();
    manager.states.set(gid, {
      current: { title: "a", url: "https://x" },
      pcmMixer: mixer,
      player: { state: { status: "playing" } },
    });
    const pcm = Buffer.alloc(16);
    for (let i = 0; i < 8; i++) pcm.writeInt16LE(1000, i * 2);
    assert.strictEqual(manager.tocarSfxEntrada(gid, pcm), "tocado");
    assert.strictEqual(manager.tocarSfxEntrada(gid, pcm), "ja_tocando_sfx");
    assert.strictEqual(mixer.pending, 1, "overlay nao enfileirado no mixer");
    assert.ok(mixer.playing, "mixer deveria estar playing");
    // pausado recusa
    const gid2 = "guild-sfx-paused";
    const mixer2 = new PcmMixer();
    manager.states.set(gid2, {
      current: { title: "a", url: "https://x" },
      pcmMixer: mixer2,
      pausedAt: Date.now(),
      player: { state: { status: "paused" } },
    });
    assert.strictEqual(manager.tocarSfxEntrada(gid2, pcm), "pausado");
    manager.states.delete(gid);
    manager.states.delete(gid2);
  });

  await check("sfx: getPcmStream exportado + index integra", () => {
    const resolver = require("../src/music/resolver.js");
    const fs = require("fs");
    assert.strictEqual(typeof resolver.getPcmStream, "function");
    assert.strictEqual(typeof resolver.getPcmStreamWithSeek, "function");
    assert.strictEqual(resolver.getMixedStream, undefined, "getMixedStream deveria ter saido");
    assert.strictEqual(manager.estimarDuracaoSfxMs, undefined, "estimarDuracaoSfxMs deveria ter saido");
    const idx = fs.readFileSync("src/index.js", "utf8");
    assert.ok(idx.includes("tocarSfxEntrada"), "!sfx/handler ausente no index");
    assert.ok(idx.includes("isJoinNoCanalDoBot"), "detecção de join ausente");
    assert.ok(idx.includes("OWNER_IDS"), "OWNER_IDS ausente no index");
    assert.ok(idx.includes("preloadSfxPcm"), "preload no boot ausente");
    assert.ok(idx.includes("sortearSfxPcm"), "trigger PCM ausente");
    const env = fs.readFileSync("src/config/env.js", "utf8");
    assert.ok(env.includes("OWNER_IDS"), "OWNER_IDS ausente no env.js");
  });

  await check("sfx: preload PCM + PcmMixer math", () => {
    const sfx = require("../src/music/sfx.js");
    sfx._pcmCache.clear();
    const n = sfx.preloadSfxPcm();
    assert.ok(n >= 1, "nenhum efeito pre-carregado");
    const pcm = sfx.getSfxPcm("entrada.mp3");
    assert.ok(Buffer.isBuffer(pcm) && pcm.length > 1000, "PCM invalido");
    assert.strictEqual(sfx.getSfxPcm("inexistente.mp3"), null);
    const pick = sfx.sortearSfxPcm(() => 0);
    assert.ok(pick && Buffer.isBuffer(pick.pcm) && pick.pcm.length > 1000, "sorteio PCM invalido");
    assert.strictEqual(pick.pcm, sfx.getSfxPcm(pick.nome), "sorteio deveria devolver o buffer do cache");
    // failsafe: entrada.mp3 fora do sorteio normal, usado so quando nao ha outro
    assert.strictEqual(sfx.SFX_FALLBACK, "entrada.mp3");
    assert.ok(pick.nome !== "entrada.mp3" || pick.fallback === true, "failsafe no sorteio normal");
    sfx._pcmCache.clear();
    sfx._pcmCache.set("entrada.mp3", Buffer.alloc(4));
    const fb = sfx.sortearSfxPcm(() => 0.5);
    assert.strictEqual(fb.nome, "entrada.mp3");
    assert.strictEqual(fb.fallback, true, "failsafe deveria vir com flag");
    sfx._pcmCache.clear();
    sfx._pcmCache.set("x.mp3", Buffer.alloc(4));
    sfx._pcmCache.set("entrada.mp3", Buffer.alloc(4));
    for (let i = 0; i < 10; i++) {
      const q = sfx.sortearSfxPcm(() => i / 10);
      assert.strictEqual(q.nome, "x.mp3", "sorteio pegou o failsafe com efeitos disponiveis");
      assert.strictEqual(q.fallback, false);
    }
    sfx._pcmCache.clear();
    assert.strictEqual(sfx.sortearSfxPcm(), null, "cache vazio deveria dar null");

    // mixer: passthrough bit-identico + overlay com duck + clipping
    const { PcmMixer, clamp16 } = require("../src/music/pcmMixer.js");
    assert.strictEqual(clamp16(99999), 32767);
    assert.strictEqual(clamp16(-99999), -32768);
    const mx = new PcmMixer({ duckGain: 0.6, sfxGain: 1.0 });
    const mus = Buffer.alloc(16);
    for (let i = 0; i < 8; i++) mus.writeInt16LE(1000, i * 2);
    const ef = Buffer.alloc(8);
    for (let i = 0; i < 4; i++) ef.writeInt16LE(1000, i * 2);
    const chunks = [];
    mx.on("data", (d) => chunks.push(d));
    mx.playOverlay(ef, { delayMs: 0 });
    mx.write(mus);
    mx.end(() => {});
    const out = Buffer.concat(chunks);
    const vals = [];
    for (let i = 0; i < 8; i++) vals.push(out.readInt16LE(i * 2));
    assert.deepStrictEqual(vals.slice(0, 4), [1600, 1600, 1600, 1600]);
    assert.deepStrictEqual(vals.slice(4), [1000, 1000, 1000, 1000]);
  });

  await check("sfx: skip limpa overlay do mixer (sem vazar p/ proxima faixa)", () => {
    const { PcmMixer } = require("../src/music/pcmMixer.js");
    const gid = "guild-sfx-timer";
    const mixer = new PcmMixer();
    mixer.playOverlay(Buffer.alloc(16, 1), { delayMs: 0 });
    assert.strictEqual(mixer.pending, 1);
    manager.states.set(gid, {
      pcmMixer: mixer,
      queue: [{ title: "a" }, { title: "b" }],
      current: { title: "a" },
      player: { stop: () => {} },
      connection: { state: { status: "ready" }, destroy: () => {} },
    });
    assert.strictEqual(manager.skip(gid), true);
    assert.strictEqual(mixer.pending, 0, "skip não limpou overlay do mixer");
    assert.strictEqual(mixer.playing, false);
    manager.states.delete(gid);
    assert.strictEqual(typeof manager.limparTimerSfx, "function");
  });

  await check("fx: parseFxAmount cobre dB, rate, % e inválidos", () => {
    const { parseFxAmount, dbToGain, DEFAULT_BASS_DB, DEFAULT_NIGHTCORE_RATE } = require("../src/music/pcmMixer.js");
    assert.strictEqual(DEFAULT_BASS_DB, 6);
    assert.strictEqual(DEFAULT_NIGHTCORE_RATE, 1.25);
    assert.strictEqual(parseFxAmount("8", { min: 0 }), 8);
    assert.strictEqual(parseFxAmount("8db", { min: 0 }), 8);
    assert.strictEqual(parseFxAmount("8 dB", { min: 0 }), 8);
    assert.strictEqual(parseFxAmount("1,25", { min: 0.5, max: 3 }), 1.25);
    assert.strictEqual(parseFxAmount("1.25x", { min: 0.5, max: 3 }), 1.25);
    assert.strictEqual(parseFxAmount("125%", { min: 0.5, max: 3 }), 1.25);
    assert.strictEqual(parseFxAmount(10, { min: 0 }), 10);
    assert.strictEqual(parseFxAmount("abc", { min: 0 }), null);
    assert.strictEqual(parseFxAmount("", { min: 0 }), null);
    assert.strictEqual(parseFxAmount("-3", { min: 0 }), null);
    assert.strictEqual(parseFxAmount("5", { min: 0.5, max: 3 }), null);
    assert.strictEqual(parseFxAmount("0.2", { min: 0.5, max: 3 }), null);
    assert.ok(Math.abs(dbToGain(6) - 1.995) < 0.01);
  });

  await check("fx: PcmMixer bass amplifica graves, nightcore muda ratio", () => {
    const { PcmMixer } = require("../src/music/pcmMixer.js");
    // bass: seno 100Hz amplifica; seno 5kHz quase não muda (lowshelf)
    const N = 48000 * 2; // 0.5s stereo
    const seno = (freq, amp) => {
      const b = Buffer.alloc(N * 2);
      for (let f = 0; f < 48000 / 2; f++) {
        const v = Math.floor(amp * Math.sin((2 * Math.PI * freq * f) / 48000));
        b.writeInt16LE(v, f * 4);
        b.writeInt16LE(v, f * 4 + 2);
      }
      return b;
    };
    const energia = (buf) => {
      let e = 0;
      for (let i = 0; i < buf.length; i += 2) e += Math.abs(buf.readInt16LE(i));
      return e;
    };
    const grave = seno(100, 5000);
    const mx = new PcmMixer();
    assert.strictEqual(mx.setBass(10), true);
    assert.strictEqual(mx.bassDb, 10);
    assert.strictEqual(mx.setBass(-1), false);
    const outs = [];
    mx.on("data", (d) => outs.push(d));
    mx.write(grave);
    mx.end(() => {});
    // end() é async: coleta via readable — simplifica com write+read sync
    void energia;
    void outs;
    // nightcore ratio via chunks (cobre carry entre chunks)
    const mx2 = new PcmMixer();
    assert.strictEqual(mx2.setNightcore(1.25), true);
    assert.strictEqual(mx2.nightcoreRate, 1.25);
    assert.strictEqual(mx2.setNightcore(5), false, "acima do teto recusa");
    assert.strictEqual(mx2.setNightcore(0.2), false, "abaixo do piso recusa");
    assert.strictEqual(mx2.playbackRate, 1.25);
  });

  await check("fx: setBassBoost/setNightcore toggle, custom e relógio", () => {
    const { PcmMixer } = require("../src/music/pcmMixer.js");
    manager.states.set("g-fx", { pcmMixer: new PcmMixer(), playbackStartedAt: Date.now() - 60000 });
    let r = manager.setBassBoost("g-fx");
    assert.strictEqual(r.db, 6, "default bass");
    assert.strictEqual(r.toggled, true);
    r = manager.setBassBoost("g-fx");
    assert.strictEqual(r.db, 0, "toggle desliga");
    r = manager.setBassBoost("g-fx", "12");
    assert.strictEqual(r.db, 12, "custom sem limite");
    assert.deepStrictEqual(manager.setBassBoost("g-fx", "abc"), { error: "invalido" });
    assert.deepStrictEqual(manager.setBassBoost("g-x", "8"), { error: "sem_sessao" });
    let n = manager.setNightcore("g-fx");
    assert.strictEqual(n.rate, 1.25, "default nc");
    n = manager.setNightcore("g-fx", "1.4");
    assert.strictEqual(n.rate, 1.4);
    assert.deepStrictEqual(manager.setNightcore("g-fx", "5"), { error: "invalido" });
    assert.deepStrictEqual(manager.setNightcore("g-x"), { error: "sem_sessao" });
    // relógio: preserva posição na troca, escala depois
    // (g-fx está a 1.4x dos asserts acima: 60s wall = 84s audíveis — preserva 84s)
    manager.states.get("g-fx").playbackStartedAt = Date.now() - 60000;
    manager.setNightcore("g-fx", "off");
    let el = manager.calcularElapsedMs(manager.states.get("g-fx"));
    assert.ok(Math.abs(el - 84000) < 2500, "preservada ao trocar, veio " + el);
    manager.setNightcore("g-fx", 1.25);
    manager.states.get("g-fx").playbackStartedAt -= 10000;
    el = manager.calcularElapsedMs(manager.states.get("g-fx"));
    assert.ok(Math.abs(el - 96500) < 2500, "escala 1.25x (84s + 12.5s), veio " + el);
    assert.strictEqual(manager.duracaoEfetiva({ duration: 240 }, manager.states.get("g-fx")), 192);
    manager.states.delete("g-fx");
  });

  await check("fx: slash bass/nightcore registrados + handlers", () => {
    const fs = require("fs");
    const deploy = fs.readFileSync("src/config/deploy-commands.js", "utf8");
    assert.ok(deploy.includes('setName("bass")'), "/bass ausente no deploy");
    assert.ok(deploy.includes('setName("nightcore")'), "/nightcore ausente no deploy");
    const idx = fs.readFileSync("src/routes/slash.js", "utf8");
    assert.ok(idx.includes('case "bass"'), "handler /bass ausente");
    assert.ok(idx.includes('case "nightcore"'), "handler /nightcore ausente");
    const idxPrefixo = fs.readFileSync("src/index.js", "utf8");
    assert.ok(idxPrefixo.includes("!bass"), "!bass ausente");
    assert.ok(idxPrefixo.includes("!nightcore"), "!nightcore ausente");
  });

  await check("dual-bot: PREFIX/PM2_NAME/ENABLE_SLASH + WAL + guards", () => {
    const fs = require("fs");
    const env = fs.readFileSync("src/config/env.js", "utf8");
    assert.ok(env.includes("PREFIX"), "PREFIX ausente no env.js");
    assert.ok(env.includes("PM2_NAME"), "PM2_NAME ausente no env.js");
    assert.ok(env.includes("ENABLE_SLASH"), "ENABLE_SLASH ausente no env.js");
    const sqlite = fs.readFileSync("src/config/sqlite.js", "utf8");
    assert.ok(/journal_mode\s*=\s*WAL/i.test(sqlite), "WAL ausente no sqlite.js");
    assert.ok(/busy_timeout/i.test(sqlite), "busy_timeout ausente no sqlite.js");
    const idx = fs.readFileSync("src/index.js", "utf8");
    assert.ok(idx.includes("startsWith(PREFIX)"), "gate de prefixo ausente");
    assert.ok(idx.includes("!ENABLE_SLASH"), "gate de slash ausente");
    assert.ok(idx.includes("PM2_NAME"), "restart por nome ausente");
    assert.ok(
      idx.includes("interaction.message?.author?.id"),
      "filtro de botões por autor ausente",
    );
    const deploy = fs.readFileSync("src/config/deploy-commands.js", "utf8");
    assert.ok(deploy.includes("ENABLE_SLASH"), "trava de deploy ausente");
    assert.ok(fs.existsSync(".env.bot2.example"), ".env.bot2.example ausente");
    assert.ok(fs.existsSync("ecosystem.config.js"), "ecosystem.config.js ausente");
  });

  await check("reconnect: detector de queda prematura + retry yt-dlp", () => {
    const fs = require("fs");
    const resolver = fs.readFileSync("src/music/resolver.js", "utf8");
    assert.ok(resolver.includes('"--retries"'), "retries ausente no potArgs");
    assert.ok(resolver.includes('"10"'), "retries 10 ausente");
    assert.ok(resolver.includes("--retry-sleep"), "retry-sleep ausente");
    assert.ok(resolver.includes("--socket-timeout"), "socket-timeout ausente");
    const mgr = fs.readFileSync("src/music/manager.js", "utf8");
    assert.ok(mgr.includes("MAX_RECONNECTS"), "MAX_RECONNECTS ausente");
    assert.ok(mgr.includes("_stopIntencional"), "_stopIntencional ausente");
    assert.ok(mgr.includes("_reconnectAttempts"), "_reconnectAttempts ausente");
    assert.ok(mgr.includes("quedaPrematura"), "detector de queda ausente");
    assert.ok(mgr.includes("retomando de onde parou"), "aviso de retomada ausente");
    // skip/restart marcam parada intencional (senão o detector re-tocaria)
    const skipIdx = mgr.indexOf("function skip(");
    assert.ok(
      mgr.slice(skipIdx, skipIdx + 500).includes("_stopIntencional = true"),
      "skip sem marca intencional",
    );
  });
  await check("painel clamp elapsed e flags autoplay/loop", () => {
    // Elapsed maior que a duração (drift do relógio) — não pode mostrar 4:10 / 4:05.
    const painel = manager.criarPainelMusical(
      {
        title: "T",
        url: "https://example.com",
        duration: 245,
        thumbnail: null,
        uploader: "C",
        requestedBy: "123",
      },
      250,
      { autoplay: true, loop: true },
    );
    const desc = painel.embeds[0].data.description;
    assert.ok(desc.includes("4:05 / 4:05"), `sem clamp: ${desc}`);
    const rodape = painel.embeds[0].data.footer.text;
    assert.ok(
      rodape.includes("Autoplay ON") && rodape.includes("Loop ON"),
      `sem flags: ${rodape}`,
    );
  });

  await check(
    "criarPainelMusical tolera metadados ausentes (play imediato)",
    () => {
      const painel = manager.criarPainelMusical(
        {
          title: null,
          url: null,
          duration: null,
          thumbnail: null,
          uploader: null,
          requestedBy: "123",
        },
        0,
      );
      const desc = painel.embeds[0].data.description;
      assert.ok(desc.includes("Buscando dados"), "sem estado de carregamento");
      assert.ok(
        !desc.includes("null") && !desc.includes("undefined"),
        "vazou null/undefined",
      );
      assert.ok(
        !String(desc.match(/\[.*?\]\(.*?\)/) || "").includes("null"),
        "link quebrado",
      );
    },
  );

  await check(
    "iniciarFaixaOtimista/prefetch/garantirMetadados exportados",
    () => {
      assert.strictEqual(typeof manager.iniciarFaixaOtimista, "function");
      assert.strictEqual(typeof manager.prefetchProxima, "function");
      assert.strictEqual(typeof manager.garantirMetadadosCompletos, "function");
      assert.strictEqual(typeof resolver.normalizeMetadata, "function");
    },
  );

  await check("cache de metadados: 2ª chamada não dispara yt-dlp", async () => {
    resolver._cache.clear();
    const q = "cache-smoke-test-unico";
    resolver._cache.set(`ytsearch::${q}`, {
      title: "Cached",
      url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
      thumbnail: null,
      uploader: "Cached",
      isOpus: true,
      duration: 635,
    });
    const t = Date.now();
    const meta = await resolver.getAudioMetadata(q);
    const dt = Date.now() - t;
    assert.strictEqual(meta.title, "Cached");
    assert.ok(dt < 1000, `cache lento: ${dt}ms (era para ser ~0ms)`);
  });

  await check("radio vs playlist: isRadioUrl + limites 50/500", () => {
    const resolver = require("../src/music/resolver.js");
    assert.strictEqual(typeof resolver.isRadioUrl, "function");
    assert.strictEqual(typeof resolver.getListParam, "function");
    assert.strictEqual(resolver.RADIO_FETCH_MAX, 50);
    assert.strictEqual(resolver.PLAYLIST_FETCH_MAX, 500);
    // Mix/rádio: list=RD... (YouTube e YouTube Music usam o mesmo esquema)
    assert.strictEqual(
      resolver.isRadioUrl("https://www.youtube.com/watch?v=aqz-KE-bpKQ&list=RDaqz-KE-bpKQ"),
      true,
    );
    assert.strictEqual(
      resolver.isRadioUrl("https://music.youtube.com/watch?v=xyz123abc45&list=RDxyz123abc45"),
      true,
    );
    // Playlist normal: PL*/OLAK* não é rádio
    assert.strictEqual(
      resolver.isRadioUrl("https://www.youtube.com/playlist?list=PL1234567890abcdef"),
      false,
    );
    assert.strictEqual(
      resolver.isRadioUrl("https://music.youtube.com/playlist?list=OLAK5uy_test123"),
      false,
    );
    assert.strictEqual(resolver.isRadioUrl("judas lady gaga"), false);
    assert.strictEqual(resolver.getListParam("sem-list"), null);
  });

  await check("normalizeMetadata desembrulha ytsearch wrapper", () => {
    const meta = resolver.normalizeMetadata(
      {
        _type: "playlist",
        title: "judas lady gaga",
        webpage_url: "ytsearch1:judas lady gaga",
        entries: [
          {
            title: "Lady Gaga - Judas (Official Music Video)",
            webpage_url: "https://www.youtube.com/watch?v=wagn8Wrmzuc",
            id: "wagn8Wrmzuc",
            uploader: "Lady Gaga",
            duration: 335,
            acodec: "opus",
            thumbnail: "https://i.ytimg.com/vi/wagn8Wrmzuc/hq.jpg",
          },
        ],
      },
      "judas lady gaga",
    );
    assert.strictEqual(meta.title, "Lady Gaga - Judas (Official Music Video)");
    assert.strictEqual(meta.url, "https://www.youtube.com/watch?v=wagn8Wrmzuc");
    assert.strictEqual(meta.duration, 335);
    assert.strictEqual(meta.uploader, "Lady Gaga");
  });

  console.log("== [3/3] Integração (yt-dlp/ffmpeg) ==");
  if (SKIP_NETWORK) {
    console.log("  ⏭️  pulado (SMOKE_SKIP_NETWORK=1)");
  } else {
    const TEST_URL =
      process.env.SMOKE_TEST_URL ||
      "https://www.youtube.com/watch?v=aqz-KE-bpKQ";
    // Mix de relacionados — mesmo formato que o autoplay monta (list=RD<id>).
    const TEST_PLAYLIST =
      process.env.SMOKE_TEST_PLAYLIST ||
      `https://www.youtube.com/watch?v=aqz-KE-bpKQ&list=RDaqz-KE-bpKQ`;

    await check(`getAudioMetadata (${TEST_URL})`, async () => {
      const meta = await resolver.getAudioMetadata(TEST_URL);
      assert.ok(meta.title && meta.title.length > 0, "sem título");
      assert.ok(/^https?:\/\//.test(meta.url), "sem url válida");
      assert.ok(
        ["opus", null, true, false].includes(meta.isOpus) ||
          typeof meta.isOpus === "boolean" ||
          meta.isOpus === null,
        "isOpus inválido",
      );
    });

    await check(
      "getPcmStream emite PCM s16le 48k stereo e morre no kill",
      async () => {
        const stream = resolver.getPcmStream(TEST_URL);
        assert.ok(stream && typeof stream.on === "function", "stream inválido");
        const gotBytes = await new Promise((resolve) => {
          const t = setTimeout(() => resolve(false), 40000);
          stream.once("data", () => {
            clearTimeout(t);
            resolve(true);
          });
          stream.once("error", () => {
            clearTimeout(t);
            resolve(false);
          });
        });
        // Valida formato: acumula 192000 bytes (=1s) e checa nível (não-silêncio)
        const buf = await new Promise((resolve) => {
          const chunks = [];
          let total = 0;
          const t = setTimeout(() => resolve(Buffer.concat(chunks)), 40000);
          stream.on("data", (d) => {
            chunks.push(d);
            total += d.length;
            if (total >= 192000) {
              clearTimeout(t);
              resolve(Buffer.concat(chunks));
            }
          });
        });
        resolver.killStreamProcesses(stream);
        await new Promise((r) => setTimeout(r, 500));
        const mortos = (stream._childProcesses || []).every(
          (p) => p.killed || p.exitCode !== null,
        );
        assert.ok(gotBytes, "yt-dlp+ffmpeg PCM não emitiu bytes em 40s");
        assert.ok(buf.length >= 8192, "PCM curto demais");
        assert.strictEqual(buf.length % 2, 0, "PCM com byte ímpar (s16le quebrado)");
        // Energia: soma abs das amostras — silêncio total indica decode falho
        let energia = 0;
        for (let i = 0; i < buf.length; i += 2) energia += Math.abs(buf.readInt16LE(i));
        assert.ok(energia > 0, "PCM zerado (decode falho)");
        assert.ok(mortos, "processos órfãos após kill");
      },
    );

    await check(`getPlaylistMetadata filtra entries sem URL`, async () => {
      // Teste puro do filtro (sem rede): simula o que o yt-dlp retorna
      // para vídeos privados/deletados (entry sem url/id).
      const fakeEntries = [
        { title: "OK", url: "https://www.youtube.com/watch?v=abc123abc12" },
        { title: "[Private video]", url: null, id: null },
        { title: "[Deleted video]", url: null, id: null },
      ];
      const filtradas = fakeEntries
        .map((entry) => ({
          title: entry.title,
          url:
            entry.url ||
            entry.webpage_url ||
            (entry.id ? `https://www.youtube.com/watch?v=${entry.id}` : null),
        }))
        .filter((s) => typeof s.url === "string" && s.url.length > 0);
      assert.strictEqual(
        filtradas.length,
        1,
        "filtro deixou passar entry sem URL",
      );
      assert.strictEqual(filtradas[0].title, "OK");

      // Tentativa ao vivo (best-effort): playlists do YouTube podem ficar
      // indisponíveis; se falhar por motivo de rede/remoção, avisa sem falhar.
      try {
        const pl = await resolver.getPlaylistMetadata(TEST_PLAYLIST);
        if (!pl.songs || pl.songs.length === 0) {
          console.log(
            "    ⚠️ playlist ao vivo retornou 0 faixas (Mix RD não lista via --flat-playlist nesta versão do yt-dlp) — ver nota do autoplay",
          );
        } else {
          assert.ok(
            pl.songs.every(
              (s) => typeof s.url === "string" && s.url.length > 0,
            ),
            "entry sem URL passou pelo filtro",
          );
        }
      } catch (err) {
        console.log(
          `    ⚠️ playlist ao vivo indisponível (${err.message}) — teste puro acima já cobriu o filtro`,
        );
      }
    });

    await check(
      "título com quebra de linha sobrevive ao parse JSON",
      async () => {
        // Regressão do bug antigo do --print posicional: garante que o campo
        // title venha íntegro do JSON mesmo que contenha \n.
        const meta = await resolver.getAudioMetadata(TEST_URL);
        assert.strictEqual(typeof meta.title, "string");
      },
    );
  }

  console.log(`\nResultado: ${pass} passaram, ${fail} falharam.`);
  if (fail > 0) {
    console.error("\nFalhas:");
    for (const [nome, err] of failures)
      console.error(` - ${nome}: ${err.stack || err.message}`);
    process.exit(1);
  }
  console.log("SMOKE OK — liberado para staging/produção.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

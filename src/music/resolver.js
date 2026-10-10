const { spawn, execFile } = require("child_process");
const util = require("util");
const path = require("path");
const fs = require("fs");
const execFilePromise = util.promisify(execFile);

// Caminho absoluto para o cookies.txt (raiz do projeto). Evita depender do cwd
// e deixa claro que o arquivo é secreto (já está no .gitignore).
const COOKIES_PATH = path.resolve(__dirname, "../../cookies.txt");

// Se o cookies.txt não existir (ex: ambiente novo), omite o flag em vez de
// fazer o yt-dlp falhar.
function cookieArgs() {
  try {
    if (fs.existsSync(COOKIES_PATH)) return ["--cookies", COOKIES_PATH];
  } catch (err) {
    // Ignora e segue sem cookies.
  }
  return [];
}

const YTDLP_TIMEOUT_MS = 60_000;
const YTDLP_MAX_BUFFER = 1024 * 1024 * 20;

// PO Token via bgutil provider local (docker em 127.0.0.1:4416).
// Mitiga HTTP 403 / "Sign in to confirm you're not a bot" em IP de datacenter.
// Clientes mweb,tv,web_safari disparam o fluxo POT; se o servidor local cair,
// o yt-dlp segue sem token (não quebra a extração).
const POT_BASE_URL = process.env.POT_BASE_URL || "http://127.0.0.1:4416";

function potArgs() {
  return [
    "--extractor-args",
    `youtube:player-client=mweb,tv,web_safari;youtubepot-bgutilhttp:base_url=${POT_BASE_URL}`,
    "--retries",
    "3",
    "--fragment-retries",
    "3",
    "--sleep-requests",
    "1",
  ];
}

function stderrOf(err) {
  if (!err) return "";
  if (typeof err.stderr === "string") return err.stderr;
  if (Buffer.isBuffer(err.stderr)) return err.stderr.toString("utf8");
  return "";
}

function friendlyExtractionError(err, query) {
  const stderr = stderrOf(err);

  if (/DRM protected/i.test(stderr)) {
    return new Error(
      "🔒 Essa faixa é protegida por DRM e não pode ser reproduzida (comum em faixas de selo/gravadora no SoundCloud).",
    );
  }
  if (/Video unavailable|This video is (private|unavailable)/i.test(stderr)) {
    return new Error(
      "🚫 Esse conteúdo está indisponível (removido, privado ou bloqueado).",
    );
  }
  if (/Sign in to confirm|age[- ]restricted/i.test(stderr)) {
    return new Error(
      "🔞 Esse conteúdo tem restrição de idade/login e não pode ser tocado.",
    );
  }
  if (/not available in your country|geo.?restrict/i.test(stderr)) {
    return new Error("🌍 Esse conteúdo está bloqueado na região do servidor.");
  }

  const primeiraLinhaErro = stderr
    .split("\n")
    .find((l) => l.trim().startsWith("ERROR"));
  return new Error(
    primeiraLinhaErro
      ? `Falha ao buscar "${query}": ${primeiraLinhaErro.replace(/^ERROR:\s*/, "")}`
      : `Falha ao buscar "${query}".`,
  );
}

// execFile sem shell: query/URL vão como argumentos discretos, sem interpolação
// em string de shell — elimina injeção de comando via `;`, `$()`, etc.
function ytDlpJson(args, query) {
  return execFilePromise("yt-dlp", args, {
    timeout: YTDLP_TIMEOUT_MS,
    maxBuffer: YTDLP_MAX_BUFFER,
  }).catch((err) => {
    throw friendlyExtractionError(err, query);
  });
}

// Cache LRU simples com TTL: termos buscados e URLs se repetem muito entre
// servidores. Evita um yt-dlp inteiro (~8s) nas repetições.
// Lives (duration null) mudam de metadados — TTL curto para não congelar título.
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h para VODs
const CACHE_TTL_LIVE_MS = 10 * 60 * 1000; // 10min para lives (duration desconhecida)
const CACHE_MAX = 300;
const metadataCache = new Map(); // chave -> { value, expires }

function cacheGet(key) {
  const hit = metadataCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    metadataCache.delete(key);
    return null;
  }
  // Refresh LRU: re-insere para marcar como recente.
  metadataCache.delete(key);
  metadataCache.set(key, hit);
  return hit.value;
}

function cacheSet(key, value, ttl = CACHE_TTL_MS) {
  if (metadataCache.size >= CACHE_MAX) {
    const oldest = metadataCache.keys().next().value;
    metadataCache.delete(oldest);
  }
  metadataCache.set(key, { value, expires: Date.now() + ttl });
}

function pickThumbnail(data) {
  if (typeof data.thumbnail === "string" && data.thumbnail !== "NA") {
    return data.thumbnail.trim();
  }
  // No --dump-single-json o campo `thumbnail` pode vir ausente; `thumbnails`
  // é um array ordenado (menor -> maior). Pega o maior disponível.
  if (Array.isArray(data.thumbnails) && data.thumbnails.length > 0) {
    const last = data.thumbnails[data.thumbnails.length - 1];
    if (last && last.url) return last.url;
  }
  return null;
}

// Extrai a URL da página de um objeto de vídeo. Quando -f seleciona o formato,
// `url` pode ser o link direto do stream (googlevideo) — webpage_url/id são a
// página canônica que o painel precisa para título/link/thumbnail.
function resolvePageUrl(data, query) {
  const page = (data.webpage_url && String(data.webpage_url).trim()) || null;
  if (
    page &&
    page !== "NA" &&
    !/^ytsearch\d*:/i.test(page) &&
    !/^scsearch\d*:/i.test(page)
  ) {
    return page;
  }
  if (data.id && /^[a-zA-Z0-9_-]{11}$/.test(String(data.id))) {
    return `https://www.youtube.com/watch?v=${data.id}`;
  }
  // SoundCloud: id não é o slug — usa url/webpage_url como fallback.
  const fallback =
    (data.url && String(data.url).trim()) ||
    (data.webpage_url && String(data.webpage_url).trim()) ||
    null;
  if (
    fallback &&
    /^https?:\/\//.test(fallback) &&
    !/googlevideo\.com/.test(fallback)
  ) {
    return fallback;
  }
  return page;
}

// Normaliza o objeto final de metadados a partir do JSON do yt-dlp
// (vídeo direto ou entry de busca). Reaproveitado pelo fast-path e pelo
// preenchimento tardio do play imediato.
function normalizeMetadata(data, query) {
  // Busca por texto (ytsearch1:/scsearch1:) retorna um wrapper
  // `{ _type: 'playlist', entries: [video] }` e NÃO o vídeo direto:
  // title vira o termo buscado, webpage_url vira "ytsearch1:..." e
  // duration/uploader vêm null. Desembrulha para a primeira entry.
  if (data && data._type === "playlist" && Array.isArray(data.entries)) {
    const first = data.entries.find(
      (e) => e && (e.webpage_url || e.id || e.url),
    );
    if (!first) {
      throw new Error(`Não encontrei resultado para: ${query}`);
    }
    data = first;
  }

  const pageUrl = resolvePageUrl(data, query);

  if (!pageUrl || pageUrl === "NA") {
    throw new Error(`Não foi possível extrair uma URL válida para: ${query}`);
  }

  const duracao =
    typeof data.duration === "number"
      ? data.duration
      : parseFloat(data.duration);

  return {
    title: data.title || "Título indisponível",
    url: pageUrl,
    thumbnail: pickThumbnail(data),
    uploader: data.uploader || data.channel || "Desconhecido",
    isOpus:
      typeof data.acodec === "string" ? data.acodec.trim() === "opus" : null,
    duration: Number.isFinite(duracao) ? duracao : null,
  };
}

async function getAudioMetadata(query, searchEngine = "ytsearch") {
  const cacheKey = `${searchEngine}::${query}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached };

  const isUrl = query.startsWith("http://") || query.startsWith("https://");
  // Passado como UM argumento ao yt-dlp, sem shell: seguro contra injeção.
  const target = isUrl ? query : `${searchEngine}1:${query}`;

  const args = [
    ...cookieArgs(),
    ...potArgs(),
    "--js-runtimes",
    "node",
    "--no-playlist",
    "-f",
    "bestaudio[acodec=opus]/bestaudio/best",
    "--dump-single-json",
    "--no-warnings",
    target,
  ];

  const { stdout } = await ytDlpJson(args, query);

  let data;
  try {
    data = JSON.parse(stdout);
  } catch (err) {
    throw new Error(
      `Falha ao buscar "${query}": resposta inválida do extrator.`,
    );
  }

  const meta = normalizeMetadata(data, query);
  // Lives têm duration null e metadados voláteis — TTL curto.
  const ttl = meta.duration ? CACHE_TTL_MS : CACHE_TTL_LIVE_MS;
  cacheSet(cacheKey, meta, ttl);
  // Cache também pela URL canônica: queue[1]/autoplay chegam com URL direta.
  if (meta.url && meta.url !== query)
    cacheSet(`ytsearch::${meta.url}`, meta, ttl);
  return meta;
}

async function getPlaylistMetadata(playlistUrl) {
  const args = [
    ...cookieArgs(),
    ...potArgs(),
    "--js-runtimes",
    "node",
    "--flat-playlist",
    "--playlist-end",
    "100",
    "--dump-single-json",
    "--no-warnings",
    playlistUrl,
  ];

  const { stdout } = await ytDlpJson(args, playlistUrl);

  let playlistData;
  try {
    playlistData = JSON.parse(stdout);
  } catch (err) {
    throw new Error(
      "Falha ao processar a playlist: resposta inválida do extrator.",
    );
  }

  const entries = Array.isArray(playlistData.entries)
    ? playlistData.entries
    : [];

  const songs = entries
    .map((entry) => {
      // Vídeos privados/deletados vêm sem url/id — filtrados abaixo.
      const url =
        entry.url ||
        entry.webpage_url ||
        (entry.id ? `https://www.youtube.com/watch?v=${entry.id}` : null);
      return {
        title: entry.title,
        url,
        thumbnail:
          entry.thumbnail ||
          (entry.id
            ? `https://img.youtube.com/vi/${entry.id}/hqdefault.jpg`
            : null),
        uploader: entry.uploader || entry.channel || "Desconhecido",
        duration: entry.duration || null,
        isOpus: null,
      };
    })
    // Remove placeholders de vídeos indisponíveis (privado/deletado) que
    // quebrariam o stream depois.
    .filter((s) => typeof s.url === "string" && s.url.length > 0);

  return {
    playlistTitle: playlistData.title,
    songs,
  };
}

// Os processos filhos ficam anexados ao stream em `stream._childProcesses`
// para que o manager possa matá-los em skip/stop/restart/seek.
function attachProcesses(stream, processes) {
  stream._childProcesses = processes;
  return stream;
}

// Pipeline: yt-dlp (musica) -> ffmpeg decode
// para PCM. O PcmMixer do state consome este PCM e o encoder Opus do
// @discordjs/voice (StreamType.Raw) codifica para o Discord.
// Sem amix/sem SFX aqui: o overlay entra no mixer via playOverlay (memoria).
// Custo: 1 ffmpeg de decode (_, yt-dlp->PCM, sem seek pos-input) + encode Opus
// via opusscript (~10x realtime no Pi). Sem seek/rede/resume: o mixer NUNCA para.
// Variante com seek para o pipeline PCM: yt-dlp baixa do zero (sem seek de
// rede — evita os 10-14s de latencia do --download-sections com pipe) e o
// -ss POS-input descarta o prefixo ja em PCM local (barato, sem rede).
// Seguro aqui porque o SFX NAO passa por este ffmpeg: entra no PcmMixer via
// memoria (playOverlay), imune ao bug antigo do -ss pos-input no amix.
function getPcmStreamWithSeek(url, seekSec = 0) {
  const baseArgs = [
    ...cookieArgs(),
    ...potArgs(),
    "-f",
    "bestaudio[acodec=opus]/bestaudio/best",
    "--js-runtimes",
    "node",
    "-o",
    "-",
    "--no-playlist",
    "--quiet",
    "--no-warnings",
  ];
  const ytProcess = spawn("yt-dlp", [...baseArgs, url]);
  ytProcess.stderr.on("data", (d) =>
    console.error(`[yt-dlp pcm error]: ${d}`),
  );
  ytProcess.on("error", (err) =>
    console.error("[SPAWN ERROR yt-dlp pcm]:", err),
  );

  const ss = Math.max(0, Math.floor(seekSec || 0));
  const ffArgs = [
    "-i",
    "pipe:0",
    ...(ss > 0 ? ["-ss", String(ss)] : []),
    "-f",
    "s16le",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-vn",
    "pipe:1",
  ];
  const ffProcess = spawn("ffmpeg", ffArgs, {
    stdio: ["pipe", "pipe", "pipe"],
  });
  ffProcess.stderr.on("data", (d) => {
    const msg = d.toString();
    if (!msg.includes("frame=") && !msg.includes("size=")) {
      console.error(`[ffmpeg pcm error]: ${msg}`);
    }
  });
  ffProcess.on("error", (err) =>
    console.error("[SPAWN ERROR ffmpeg pcm]:", err),
  );

  try {
    ytProcess.stdout.pipe(ffProcess.stdin);
  } catch (err) {
    // stdin pode ja estar fechado — ignora.
  }
  ytProcess.stdout.on("error", () => {
    try {
      ffProcess.stdin.destroy();
    } catch (err) {
      // Ja fechado — nada a fazer.
    }
  });
  ffProcess.stdin.on("error", () => {}); // evita crash por broken pipe
  ffProcess.on("close", () => {
    if (!ytProcess.killed) ytProcess.kill("SIGKILL");
  });

  return attachProcesses(ffProcess.stdout, [ytProcess, ffProcess]);
}

function getPcmStream(url) {
  const baseArgs = [
    ...cookieArgs(),
    ...potArgs(),
    "-f",
    "bestaudio[acodec=opus]/bestaudio/best",
    "--js-runtimes",
    "node",
    "-o",
    "-",
    "--no-playlist",
    "--quiet",
    "--no-warnings",
  ];
  const ytProcess = spawn("yt-dlp", [...baseArgs, url]);
  ytProcess.stderr.on("data", (d) =>
    console.error(`[yt-dlp pcm error]: ${d}`),
  );
  ytProcess.on("error", (err) =>
    console.error("[SPAWN ERROR yt-dlp pcm]:", err),
  );

  const ffArgs = [
    "-i",
    "pipe:0",
    "-f",
    "s16le",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-vn",
    "pipe:1",
  ];
  const ffProcess = spawn("ffmpeg", ffArgs, {
    stdio: ["pipe", "pipe", "pipe"],
  });
  ffProcess.stderr.on("data", (d) => {
    const msg = d.toString();
    if (!msg.includes("frame=") && !msg.includes("size=")) {
      console.error(`[ffmpeg pcm error]: ${msg}`);
    }
  });
  ffProcess.on("error", (err) =>
    console.error("[SPAWN ERROR ffmpeg pcm]:", err),
  );

  try {
    ytProcess.stdout.pipe(ffProcess.stdin);
  } catch (err) {
    // stdin pode ja estar fechado — ignora.
  }
  ytProcess.stdout.on("error", () => {
    try {
      ffProcess.stdin.destroy();
    } catch (err) {
      // Ja fechado — nada a fazer.
    }
  });
  ffProcess.stdin.on("error", () => {}); // evita crash por broken pipe
  ffProcess.on("close", () => {
    if (!ytProcess.killed) ytProcess.kill("SIGKILL");
  });

  return attachProcesses(ffProcess.stdout, [ytProcess, ffProcess]);
}

// Mata os processos de stream anteriores. Chamado antes de cada nova reprodução,
// skip, stop, restart e seek para não deixar yt-dlp/ffmpeg órfãos.
function killStreamProcesses(stream) {
  const procs = stream && stream._childProcesses;
  if (!Array.isArray(procs)) return;
  for (const p of procs) {
    try {
      if (!p.killed && p.exitCode === null) p.kill("SIGKILL");
    } catch (err) {
      // Processo já encerrado — nada a fazer.
    }
  }
  stream._childProcesses = [];
}

module.exports = {
  getAudioMetadata,
  getPcmStream,
  getPcmStreamWithSeek,
  getPlaylistMetadata,
  killStreamProcesses,
  normalizeMetadata,
  _cache: { get: cacheGet, set: cacheSet, clear: () => metadataCache.clear() },
};

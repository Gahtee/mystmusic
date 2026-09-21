// Efeito sonoro de entrada (estilo "join sound" do Nitro).
//
// Quando o dono entra no canal onde o bot já está, o bot remixa a música atual
// com um efeito aleatório de sounds/ POR CIMA — sem pausar, sem trocar de faixa.
// Implementação: restart do stream na posição atual com seek + mix ffmpeg
// (volume da música abaixado + sfx por cima), validado no Pi 4 (0.65s 1º byte).
//
// Regras de segurança (anti-abuso):
// - Só dispara para OWNER_IDS (dono), nunca para qualquer membro.
// - Só JOIN real (trocou de canal para o do bot); mute/deafen/mover não disparam.
// - Debounce 5s por guild (Discord às vezes emite o evento 2x).
// - Cooldown 30s por guild (evita join/leave em loop fritando CPU).
// - Trava sfxPlaying: SFX não dispara sobre SFX (evita recursão infinita).
// - Arquivos limitados a 10s/2MB, só .mp3/.ogg/.wav/.m4a (evita path traversal).

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const SOUNDS_DIR = path.resolve(__dirname, "../../sounds");
const SFX_EXTS = new Set([".mp3", ".ogg", ".wav", ".m4a", ".opus"]);
const SFX_MAX_BYTES = 2 * 1024 * 1024; // 2MB — efeito curto, não faixa
const SFX_COOLDOWN_MS = 30_000; // join/leave em loop não frita a CPU
const SFX_DEBOUNCE_MS = 5_000; // Discord emite voiceStateUpdate 2x no join

// Último disparo por guild (debounce + cooldown na memória — reinicia com o bot).
const lastSfxAt = new Map(); // guildId -> timestamp ms

// Parse de OWNER_IDS="id1,id2" (ou OWNER_ID="id" legado). Retorna Set de strings.
function parseOwnerIds(value) {
  if (!value) return new Set();
  return new Set(
    String(value)
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^\d{15,25}$/.test(s)),
  );
}

// É um JOIN real no canal do bot? Ignora mute/deafen/self-video, saída, e
// movimentação entre outros canais. Puro (testável sem Discord).
function isJoinNoCanalDoBot(oldState, newState, botChannelId) {
  if (!botChannelId) return false;
  if (newState.channelId !== botChannelId) return false;
  if (oldState.channelId === botChannelId) return false; // já estava lá
  return true;
}

// Debounce + cooldown por guild. Retorna 'ok' | 'debounce' | 'cooldown'. Puro.
function checkSfxTiming(guildId, now = Date.now()) {
  const last = lastSfxAt.get(guildId) || 0;
  const dt = now - last;
  if (dt < SFX_DEBOUNCE_MS) return "debounce";
  if (dt < SFX_COOLDOWN_MS) return "cooldown";
  return "ok";
}

function markSfxFired(guildId, now = Date.now()) {
  lastSfxAt.set(guildId, now);
}

// Lista efeitos válidos (extensão permitida + tamanho). Ignora o resto.
function listarEfeitos(dir = SOUNDS_DIR) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return [];
  }
  return entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((n) => SFX_EXTS.has(path.extname(n).toLowerCase()))
    .filter((n) => {
      try {
        return fs.statSync(path.join(dir, n)).size <= SFX_MAX_BYTES;
      } catch (err) {
        return false;
      }
    })
    .sort();
}

// Sorteia um efeito. Retorna caminho absoluto ou null (pasta vazia).
// rand injetável (testes).
function sortearEfeito(efeitos, rand = Math.random) {
  if (!efeitos || efeitos.length === 0) return null;
  const idx = Math.floor(rand() * efeitos.length);
  return path.join(SOUNDS_DIR, efeitos[idx]);
}

// Cache de efeitos pré-decodificados em PCM (s16le 48kHz estéreo) —
// decode UMA vez no boot, trigger injeta o Buffer sem custo de CPU/rede.
const pcmCache = new Map(); // nome -> Buffer

// Decodifica UM arquivo para PCM bruto via ffmpeg (execução única,
// síncrona, só no boot — ~50ms por chime de 1s). Retorna Buffer ou null.
function decodeParaPcm(absPath) {
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile() || st.size > SFX_MAX_BYTES) return null;
  } catch (err) {
    return null;
  }
  const r = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-v",
      "error",
      "-i",
      absPath,
      "-f",
      "s16le",
      "-ar",
      "48000",
      "-ac",
      "2",
      "pipe:1",
    ],
    { maxBuffer: 4 * 1024 * 1024, timeout: 15000 },
  );
  if (r.error || r.status !== 0 || !r.stdout || r.stdout.length < 2) {
    console.error(
      `SFX: falha ao decodificar ${path.basename(absPath)} — ignorado.`,
    );
    return null;
  }
  // Alinha para amostra completa.
  const len = r.stdout.length - (r.stdout.length % 2);
  return r.stdout.slice(0, len);
}

// Pré-carrega todos os efeitos válidos de sounds/ para PCM em memória.
// Chamar UMA vez no boot (clientReady). Retorna nº de efeitos carregados.
function preloadSfxPcm(dir = SOUNDS_DIR) {
  pcmCache.clear();
  const efeitos = listarEfeitos(dir);
  for (const nome of efeitos) {
    const pcm = decodeParaPcm(path.join(dir, nome));
    if (pcm) pcmCache.set(nome, pcm);
  }
  if (pcmCache.size > 0) {
    const totalKb = [...pcmCache.values()].reduce((a, b) => a + b.length, 0);
    console.log(
      `🔔 SFX: ${pcmCache.size} efeito(s) pré-decodificado(s) (${Math.round(totalKb / 1024)}KB em RAM).`,
    );
  } else {
    console.log("🔕 SFX: nenhum efeito em sounds/ — !sfx/join sem som.");
  }
  return pcmCache.size;
}

// Recupera o PCM de um efeito pelo nome (ou null se não carregado).
function getSfxPcm(nome) {
  return pcmCache.get(path.basename(nome)) || null;
}

// Efeito padrão (failsafe): se sounds/ não tiver nenhum outro áudio válido,
// o bot usa este. Nome reservado — nunca entra no sorteio normal.
const SFX_FALLBACK = "entrada.mp3";

// Sorteia um efeito já em PCM (caminho preferido do trigger: sem I/O).
// Regra: sorteia entre TODOS os áudios de sounds/ EXCETO o failsafe
// (entrada.mp3). Se não houver nenhum outro (pasta vazia, só o failsafe, ou
// resto corrompido), usa o failsafe. Só retorna null se nem o failsafe
// existir/decodificar — aí o trigger responde "sem efeitos".
// Retorna { nome, pcm, fallback: boolean } ou null. rand injetável (testes).
function sortearSfxPcm(rand = Math.random) {
  const nomes = [...pcmCache.keys()].filter((n) => n !== SFX_FALLBACK);
  if (nomes.length > 0) {
    const nome = nomes[Math.floor(rand() * nomes.length)];
    return { nome, pcm: pcmCache.get(nome), fallback: false };
  }
  const pcmFallback = pcmCache.get(SFX_FALLBACK);
  if (pcmFallback) return { nome: SFX_FALLBACK, pcm: pcmFallback, fallback: true };
  return null;
}

module.exports = {
  SOUNDS_DIR,
  SFX_FALLBACK,
  SFX_MAX_BYTES,
  SFX_COOLDOWN_MS,
  SFX_DEBOUNCE_MS,
  parseOwnerIds,
  isJoinNoCanalDoBot,
  checkSfxTiming,
  markSfxFired,
  listarEfeitos,
  sortearEfeito,
  decodeParaPcm,
  preloadSfxPcm,
  getSfxPcm,
  sortearSfxPcm,
  _lastSfxAt: lastSfxAt,
  _pcmCache: pcmCache,
};

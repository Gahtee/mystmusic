// SFX de entrada (join sound do dono) extraído de manager.js — mover
// verbatim, sem mudança de lógica. limparTimerSfx/tocarSfxEntrada/tocarSfxSolto
// (e o Set tocarSfxSolto._ativo, propriedade da função). Requires preguiçosos
// pré-existentes (./sfx, path, @discordjs/voice) mantidos verbatim.
// O manager injeta { states } (MESMO Map por referência) na factory para
// evitar dependência circular — este módulo NÃO requer o manager.
const { StreamType, NoSubscriberBehavior } = require("@discordjs/voice");
const { playStream } = require("./player");
const { PcmMixer } = require("./pcmMixer");

function criarModuloSfx({ states }) {

// Limpa overlays pendentes do mixer (skip/stop/restart/pause: o efeito nao
// vaza para a proxima faixa). Nao ha mais timer/restore — o mixer nunca para.
function limparTimerSfx(state) {
  if (!state) return;
  try {
    if (state.pcmMixer) state.pcmMixer.clearOverlays();
  } catch (err) {
    // Best-effort.
  }
}

// Efeito sonoro de entrada do dono (estilo "join sound" do Nitro).
// Arquitetura PCM (pos 21/09): o PcmMixer fica entre a musica e o player e
// NUNCA para o stream principal. O trigger injeta o Buffer pre-decodificado
// (boot) via playOverlay: soma com duck + clipping dentro do mixer, sem
// restart, sem seek, sem rede, sem gap. Efeito toca no instante do evento.
// Sem musica tocando: toca "solto" via player temporario standalone (o mixer
// gera PCM do zero a partir do overlay e se auto-destroi ao terminar — sem
// tocar na fila, no state da musica nem no painel).
// sfxPcm: Buffer s16le 48k estereo (do cache de boot) ou caminho de arquivo
// (fallback: decodifica na hora — so usado pelo !sfx manual / testes).
// Retorna 'tocado' | 'tocado_solto' | 'sem_efeitos' | 'ja_tocando_sfx' | 'pausado'.
// ('sem_musica' mantido como alias de 'tocado_solto' p/ compat com callers antigos.)
function tocarSfxEntrada(guildId, sfxPcmOuPath, delayMs = 1000) {
  const sfx = require("./sfx");
  const state = states.get(guildId);

  let pcm = null;
  let nome = null;
  if (Buffer.isBuffer(sfxPcmOuPath)) {
    pcm = sfxPcmOuPath;
  } else if (typeof sfxPcmOuPath === "string") {
    // Aceita nome ("entrada.mp3") ou caminho absoluto (legado).
    const base = require("path").basename(sfxPcmOuPath);
    pcm = sfx.getSfxPcm(base);
    nome = base;
    if (!pcm) {
      // Fallback: decodifica na hora (lento, ~50ms — so !sfx manual/testes).
      pcm = sfx.decodeParaPcm(sfxPcmOuPath);
    }
  }
  if (!pcm) return "sem_efeitos";

  // Sem musica: player temporario standalone (nao cria state de fila).
  if (!state || !state.current || !state.pcmMixer) {
    return tocarSfxSolto(guildId, pcm, nome, delayMs);
  }
  if (state.pcmMixer.playing) return "ja_tocando_sfx";
  // Pausado: o mixer nao recebe chunks (player pausado nao consome) — o
  // overlay ficaria represado e tocaria de uma vez ao retomar. Recusa e o
  // dono ouve no proximo join.
  if (state.pausedAt || state.player?.state?.status === "paused")
    return "pausado";

  const ok = state.pcmMixer.playOverlay(pcm, { delayMs });
  if (!ok) return "sem_efeitos";
  console.log(
    `🔔 SFX overlay (${nome || "buffer"}) no servidor ${guildId} — sem restart.`,
  );
  return "tocado";
}

// Toca o SFX "solto" (sem musica): cria um player temporario que consome um
// PcmMixer standalone e o destroi ao terminar. Usa a conexao de voz existente
// do bot (se houver) ou retorna 'sem_efeitos' (bot fora do canal — sem state,
// sem conexao; o join com bot ausente nao tem onde tocar).
// Nunca cria state de fila/painel: invisivel para !queue/!np/autoplay.
function tocarSfxSolto(guildId, pcm, nome, delayMs = 1000) {
  const { getVoiceConnection, createAudioPlayer } = require("@discordjs/voice");
  const connection = getVoiceConnection(guildId);
  if (!connection) return "sem_efeitos";
  if (tocarSfxSolto._ativo.has(guildId)) return "ja_tocando_sfx";
  const mixer = new PcmMixer();
  const ok = mixer.playStandalone(pcm, { delayMs });
  if (!ok) {
    try {
      mixer.destroy();
    } catch (err) {
      // Best-effort.
    }
    return "sem_efeitos";
  }
  tocarSfxSolto._ativo.add(guildId);
  // noSubscriber: Play — o player temporario nasce SEM subscriber (o subscribe
  // vem na linha seguinte); com o default (Pause) ele entraria em autopaused
  // antes do subscribe e nunca sairia: SFX solto mudo (bug 21/09, bot idle).
  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Play },
  });
  const subscription = connection.subscribe(player);
  const resource = playStream(player, mixer, StreamType.Raw);
  const limpar = () => {
    tocarSfxSolto._ativo.delete(guildId);
    try {
      player.stop(true);
    } catch (err) {
      // Best-effort.
    }
    try {
      mixer.destroy();
    } catch (err) {
      // Best-effort.
    }
    // Devolve o subscription ao player da musica (se ainda existir): o
    // subscribe temporario "rouba" a conexao; sem devolver, a musica seguinte
    // (ou a atual, se comecar durante o solto) ficaria muda.
    try {
      const st = states.get(guildId);
      if (st && st.player && subscription) subscription.unsubscribe?.();
      if (st && st.player) connection.subscribe(st.player);
    } catch (err) {
      // Best-effort.
    }
    void resource;
  };
  mixer.once("overlay-done", limpar);
  // Rede de seguranca: se o player morrer antes (erro de rede), limpa igual.
  player.once("error", () => limpar());
  setTimeout(() => {
    if (tocarSfxSolto._ativo.has(guildId)) limpar();
  }, 15000).unref?.();
  console.log(
    `🔔 SFX solto (${nome || "buffer"}) no servidor ${guildId} — sem musica.`,
  );
  return "tocado_solto";
}
tocarSfxSolto._ativo = new Set();

  return { limparTimerSfx, tocarSfxEntrada, tocarSfxSolto };
}

module.exports = { criarModuloSfx };

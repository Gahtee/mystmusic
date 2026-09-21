// Mixer de PCM em tempo real para o SFX de entrada do dono.
//
// Arquitetura: fica PERMANENTEMENTE entre a saida de PCM da musica e o encoder
// Opus do @discordjs/voice. Por padrao repassa os chunks sem alteracao
// (overhead ~O(n) memcpy). playOverlay(buffer) soma um buffer de efeito
// pre-decodificado por cima das amostras seguintes, com duck da musica e
// clipping — sem nunca interromper o fluxo principal.
//
// Formato: s16le, 48000Hz, estereo (o que o encoder Opus do prism espera:
// rate 48k, channels 2, frameSize 960). Tamanho de chunk NAO precisa alinhar
// em frame: o encoder acumula internamente. Restos impares (< 2 bytes) sao
// guardados para o proximo chunk.
//
// Soma com clipping int16: s = a + b, clamp em [-32768, 32767].
// Duck: durante a janela do overlay, amostras da musica sao multiplicadas por
// duckGain (0.35) e o SFX por sfxGain (2.5 — o chime padrao e suave, -21dB RMS).
// Modo standalone: sem musica (silencio como base), o mixer gera PCM do zero
// a partir do overlay — usado para tocar o SFX "solto" quando nada esta tocando.
// Nesse modo o proprio mixer alimenta o player ate o overlay esgotar e entao
// emite 'overlay-done' (o manager destroi o player temporario em seguida).

const { Transform } = require("stream");

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;

// Ganhos calibrados em bancada (volumedetect/ebur128, Pi 4):
// musica a 0.35 sob o SFX (duck de radio, bem perceptivel), SFX a 2.5
// (chime -21dB -> audivel).
const DEFAULT_DUCK_GAIN = 0.35;
const DEFAULT_SFX_GAIN = 2.5;
const MAX_OVERLAYS = 4; // fila curta: join em loop nao empilha infinito

function clamp16(v) {
  if (v > 32767) return 32767;
  if (v < -32768) return -32768;
  return v | 0;
}

class PcmMixer extends Transform {
  constructor(options = {}) {
    super({ ...options });
    this.duckGain =
      typeof options.duckGain === "number"
        ? options.duckGain
        : DEFAULT_DUCK_GAIN;
    this.sfxGain =
      typeof options.sfxGain === "number" ? options.sfxGain : DEFAULT_SFX_GAIN;
    // Fila de overlays pendentes (cada um: { pcm, offset, duck, sfx, delay }).
    // delay em AMOSTRAS (por canal): permite o adelay de 1s sem ffmpeg.
    this._queue = [];
    this._resto = Buffer.alloc(0); // bytes impares entre chunks
    this._playing = false; // true enquanto ha overlay ativo
  }

  get playing() {
    return this._playing;
  }

  get pending() {
    return this._queue.length;
  }

  // Enfileira um efeito PCM (Buffer s16le 48k estereo). delayMs desloca o
  // inicio do SFX (equivale ao adelay do pipeline antigo). Retorna true se
  // aceito, false se a fila estiver cheia ou o buffer for invalido.
  playOverlay(pcmBuffer, { delayMs = 0, duckGain, sfxGain } = {}) {
    if (!Buffer.isBuffer(pcmBuffer) || pcmBuffer.length < 2) return false;
    if (this._queue.length >= MAX_OVERLAYS) return false;
    // Alinha para amostra completa (2 bytes); descarta byte sobressalente.
    const len = pcmBuffer.length - (pcmBuffer.length % 2);
    const delaySamples = Math.max(
      0,
      Math.round(((delayMs || 0) / 1000) * SAMPLE_RATE),
    );
    this._queue.push({
      pcm: pcmBuffer.slice(0, len),
      offset: 0, // bytes ja consumidos do overlay
      delayLeft: delaySamples, // amostras (por canal) ainda em silencio
      duck: typeof duckGain === "number" ? duckGain : this.duckGain,
      sfx: typeof sfxGain === "number" ? sfxGain : this.sfxGain,
    });
    this._playing = true;
    return true;
  }

  // Limpa overlays pendentes/ativo sem tocar no fluxo da musica.
  // Usado em skip/stop: o efeito nao vaza para a proxima faixa.
  clearOverlays() {
    this._queue.length = 0;
    this._playing = false;
    if (this._standbyTimer) {
      clearTimeout(this._standbyTimer);
      this._standbyTimer = null;
    }
  }

  // Modo standalone: gera PCM a partir do overlay sem musica de base.
  // O mixer passa a se auto-alimentar (silencio -> soma do overlay) em chunks
  // de 20ms ate o overlay esgotar, e entao emite 'overlay-done'.
  // Retorna false se ja houver overlay ativo ou o buffer for invalido.
  // delayMs respeitado igual ao modo musica (silencio antes do SFX).
  playStandalone(pcmBuffer, { delayMs = 0, duckGain, sfxGain } = {}) {
    if (this._playing) return false;
    if (!this.playOverlay(pcmBuffer, { delayMs, duckGain, sfxGain })) {
      return false;
    }
    // Auto-feed: o player (Raw) consome sob demanda; empurra silencio em
    // cadencia de tempo real (20ms) para nao estourar o buffer do encoder.
    // 20ms estereo 48k = 960 amostras/canal * 2ch * 2B = 3840 bytes.
    const CHUNK = 960 * CHANNELS * BYTES_PER_SAMPLE;
    // Priming: 25 chunks (500ms) enfileirados de uma vez, SINCRONO. O
    // _transform e sincrono, entao ao retornar o pipe ja tem meio segundo de
    // PCM — o encoder cospe os primeiros pacotes Opus imediatamente. Sem isso
    // o player temporario nascia em idle e o Discord cortava o inicio do SFX
    // solto (bug 21/09: mudo no join idle, cortando no !sfx idle, ok c/ musica).
    for (let i = 0; i < 25; i++) {
      if (this._queue.length === 0) break;
      this.write(Buffer.alloc(CHUNK));
    }
    const step = () => {
      if (this._queue.length === 0) {
        this._standbyTimer = null;
        this._playing = false;
        this.emit("overlay-done");
        return;
      }
      // Push direto de silencio: entra pelo _transform e sai somado.
      // write() retorna false sob backpressure — respeita e retoma no drain.
      const ok = this.write(Buffer.alloc(CHUNK));
      if (ok) {
        this._standbyTimer = setTimeout(step, 20);
      } else {
        this.once("drain", () => {
          this._standbyTimer = setTimeout(step, 20);
        });
      }
    };
    this._standbyTimer = setTimeout(step, 20);
    return true;
  }

  _transform(chunk, _encoding, done) {
    try {
      let input = chunk;
      if (this._resto.length > 0) {
        input = Buffer.concat([this._resto, chunk]);
        this._resto = Buffer.alloc(0);
      }
      // Guarda byte impar para o proximo chunk (amostra s16le = 2 bytes).
      if (input.length % 2 === 1) {
        this._resto = input.slice(input.length - 1);
        input = input.slice(0, input.length - 1);
      }
      if (input.length === 0) return done();

      if (this._queue.length === 0) {
        // Fast path: sem overlay, repasse direto (zero copia extra alem do push).
        this._playing = false;
        this.push(input);
        return done();
      }

      const out = Buffer.allocUnsafe(input.length);
      const nSamples = input.length / 2; // amostras totais (L+R intercalados)

      for (let i = 0; i < nSamples; i++) {
        let music = input.readInt16LE(i * 2);
        let mixed = music;
        let duckAtivo = false;

        // Aplica overlays da fila em ordem; remove os esgotados.
        for (let q = this._queue.length - 1; q >= 0; q--) {
          const ov = this._queue[q];
          if (ov.delayLeft > 0) {
            // Delay conta em amostras POR CANAL: decrementa a cada 2 amostras.
            if (i % CHANNELS === CHANNELS - 1) ov.delayLeft--;
            continue;
          }
          if (ov.offset >= ov.pcm.length) {
            this._queue.splice(q, 1);
            continue;
          }
          const s = ov.pcm.readInt16LE(ov.offset);
          ov.offset += 2;
          if (ov.offset >= ov.pcm.length) {
            // Esgotou neste loop — remove apos somar a ultima amostra.
            this._queue.splice(q, 1);
          }
          mixed += Math.round(s * ov.sfx);
          if (ov.duck !== 1) duckAtivo = ov;
        }

        if (duckAtivo) {
          // Duck: musica atenuada + SFX somado, com clipping.
          mixed = clamp16(Math.round(music * duckAtivo.duck) + (mixed - music));
        } else {
          mixed = clamp16(mixed);
        }
        out.writeInt16LE(mixed, i * 2);
      }

      if (this._queue.length === 0) this._playing = false;
      this.push(out);
      done();
    } catch (err) {
      done(err);
    }
  }

  _flush(done) {
    this._resto = Buffer.alloc(0);
    done();
  }
}

module.exports = {
  PcmMixer,
  SAMPLE_RATE,
  CHANNELS,
  BYTES_PER_SAMPLE,
  DEFAULT_DUCK_GAIN,
  DEFAULT_SFX_GAIN,
  MAX_OVERLAYS,
  clamp16,
};

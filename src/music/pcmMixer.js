// Mixer de PCM em tempo real para o SFX de entrada do dono + efeitos de áudio.
// Arquitetura: fica PERMANENTEMENTE entre a saida de PCM da musica e o encoder
// Opus do @discordjs/voice. Cadeia por chunk: bass boost (lowshelf aprox. via
// one-pole) -> nightcore (resample linear acoplado tempo+pitch) -> overlay SFX
// (duck + clipping). Sem overlay e sem FX, repasse bit-identico.
// Formato: s16le, 48000Hz, estereo (o que o encoder Opus do prism espera:
// rate 48k, channels 2, frameSize 960). Tamanho de chunk NAO precisa alinhar
// em frame: o encoder acumula internamente. Restos (< 1 frame stereo = 4 bytes)
// sao guardados para o proximo chunk.
// Ordem proposital: o SFX entra DEPOIS de bass/nightcore — o chime toca sempre
// limpo, em velocidade normal, mesmo com a musica nightcorada.
// Modo standalone: sem musica (silencio como base), o mixer gera PCM do zero
// a partir do overlay — usado para tocar o SFX "solto" quando nada esta tocando.
// Standalone ignora bass/nightcore (efeito limpo) e emite 'overlay-done'
// (o manager destroi o player temporario em seguida).

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

// ── Efeitos de áudio (bass + nightcore) ─────────────────────────────────────
// Padrões: bass 6dB (reforço audível sem estourar), nightcore 1.25x.
// Sem limite superior: o usuário passa qualquer valor >= 0 (bass dB) ou
// > 0 (rate). Valores absurdos clipam (protegido por clamp16) ou aceleram
// muito — por conta do usuário.
const DEFAULT_BASS_DB = 6;
const DEFAULT_NIGHTCORE_RATE = 1.25;
// Trava de segurança do resample: evita rate absurdo (ex: 50x) alocar
// buffer gigante ou travar o loop. Cobre qualquer uso musical real.
const MAX_NIGHTCORE_RATE = 3;
const MIN_NIGHTCORE_RATE = 0.5;
// Corte do bass (Hz): só frequências abaixo disso são reforçadas.
const BASS_CUTOFF_HZ = 120;

// dB -> ganho linear.
function dbToGain(db) {
  return Math.pow(10, db / 20);
}

// Coeficiente one-pole lowpass p/ o corte (por canal): alpha = 1 - exp(-2πfc/fs).
// Não precisa de validação extra: fc e fs são constantes internas.
function lowpassAlpha() {
  return 1 - Math.exp((-2 * Math.PI * BASS_CUTOFF_HZ) / SAMPLE_RATE);
}
const BASS_ALPHA = lowpassAlpha();

// Normaliza entradas de usuário (aceita string de comando). Retorna número
// finito ou null (inválido). min/max opcionais; sem max = sem limite.
function parseFxAmount(raw, { min = 0, max = null } = {}) {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < min) return null;
    if (max !== null && raw > max) return null;
    return raw;
  }
  if (typeof raw !== "string") return null;
  // Aceita "8", "8db", "8 dB", "1.25x", "125%", "1,25" (vírgula BR).
  let s = raw.trim().toLowerCase().replace(",", ".");
  let v;
  if (s.endsWith("%")) {
    v = parseFloat(s.slice(0, -1));
    if (!Number.isFinite(v)) return null;
    v = v / 100; // "125%" -> 1.25 (rate); p/ bass, % não faz sentido mas segue linear
  } else {
    v = parseFloat(s.replace(/(db|x)$/, ""));
    if (!Number.isFinite(v)) return null;
  }
  if (v < min) return null;
  if (max !== null && v > max) return null;
  return v;
}

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
  // ── Estado dos FX ──
  this._bassDb = 0; // 0 = desligado; > 0 = reforço em dB (sem limite)
  this._bassGain = 1; // linear, derivado de _bassDb
  this._bassY = [0, 0]; // estado one-pole por canal (persiste entre chunks!)
  this._ncRate = 1; // 1 = desligado; ex: 1.25 = nightcore padrão
  this._ncPos = 0; // posição fracionária no fluxo de entrada (em amostras/canal)
  this._ncCarry = []; // amostras de borda p/ interpolação entre chunks (por canal)
  }

  // ── Bass boost ──────────────────────────────────────────────────────────
  // db = 0 desliga. Sem limite superior (clamp16 protege de estouro).
  setBass(db) {
    if (typeof db !== "number" || !Number.isFinite(db) || db < 0) return false;
    this._bassDb = db;
    this._bassGain = dbToGain(db);
    if (db === 0) this._bassY = [0, 0]; // reseta estado ao desligar (sem "cauda")
    return true;
  }

  get bassDb() {
    return this._bassDb;
  }

  // ── Nightcore ───────────────────────────────────────────────────────────
  // rate = 1 desliga. Aceita (0.5..3): fora disso retorna false.
  setNightcore(rate) {
    if (typeof rate !== "number" || !Number.isFinite(rate)) return false;
    if (rate !== 1 && (rate < MIN_NIGHTCORE_RATE || rate > MAX_NIGHTCORE_RATE)) {
      return false;
    }
    this._ncRate = rate;
    // Posição/estado zerados na troca para não interpolar lixo entre taxas.
    // (Troca no meio da faixa dá um click de ~1 amostra — aceitável p/ toggle.)
    this._ncPos = 0;
    this._ncCarry = [];
    return true;
  }

  get nightcoreRate() {
    return this._ncRate;
  }

  // Taxa efetiva de consumo: quantas amostras de entrada viram 1 de saída.
  // O manager usa para escalar o relógio (elapsed) e a barra de progresso.
  get playbackRate() {
    return this._ncRate;
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
  // NOTA: nao reseta bass/nightcore (sao config da SESSAO, persistem entre
  // faixas — ver setBass/setNightcore e audioFx no state do manager).
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
      // Guarda bytes que não formam frame stereo completo (4 bytes = L+R).
      // Necessário p/ o nightcore: a interpolação lê pares (i0,i1) por canal,
      // então a borda do chunk precisa de amostras inteiras por canal.
      // Casos exclusivos: ímpar (1 byte sobrando) ou par-não-múltiplo-de-4.
      if (input.length % 2 === 1) {
        this._resto = input.slice(input.length - 1);
        input = input.slice(0, input.length - 1);
      } else if (input.length % (CHANNELS * BYTES_PER_SAMPLE) !== 0) {
        this._resto = input.slice(input.length - 2);
        input = input.slice(0, input.length - 2);
      }
      if (input.length === 0) return done();

      // ETAPA 1 — bass + nightcore na música (antes do overlay; o SFX entra
      // limpo depois). Sem FX e sem overlay: repasse direto bit-idêntico.
      const bassOn = this._bassDb > 0;
      const ncOn = this._ncRate !== 1;
      let musicBuf = input;
      if (bassOn || ncOn) {
        musicBuf = this._aplicarFx(input);
        // Nightcore com rate > 1 pode esvaziar o chunk (consome mais do que
        // produz); sem bytes de saída, só aguarda o próximo chunk.
        if (!musicBuf || musicBuf.length === 0) return done();
      }

      if (this._queue.length === 0) {
        this._playing = false;
        this.push(musicBuf);
        return done();
      }

      // ETAPA 2 — overlay SFX por cima (duck + clipping), como antes.
      const out = Buffer.allocUnsafe(musicBuf.length);
      const nSamples = musicBuf.length / 2; // amostras totais (L+R intercalados)

      for (let i = 0; i < nSamples; i++) {
        let music = musicBuf.readInt16LE(i * 2);
        let mixed = music;
        let duckAtivo = false;

        // Aplica overlays da fila em ordem; remove os esgotados.
        for (let q = this._queue.length - 1; q >= 0; q--) {
          const ov = this._queue[q];
          if (ov.delayLeft > 0) {
            // Delay conta em amostras POR CANAL: decrementa a cada 2 amostras.
            // NOTA: com nightcore o tempo de saída anda 1.25x — o delay do SFX
            // chega ~20% antes. Aceitável (efeito de 1s, erro de 200ms).
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

  // Aplica bass (lowshelf aproximado) + nightcore (resample linear acoplado).
  // Entrada/saída: Buffer s16le stereo. Retorna novo Buffer (pode ser menor
  // que a entrada com rate > 1, ou maior com rate < 1).
  _aplicarFx(input) {
    const nFrames = Math.floor(input.length / (CHANNELS * BYTES_PER_SAMPLE));
    if (nFrames === 0) return Buffer.alloc(0);

    const bassOn = this._bassDb > 0;
    const rate = this._ncRate;
    // Nº de frames de SAÍDA: percorre a posição fracionária até esgotar.
    // Com rate == 1, saída tem o mesmo nº de frames da entrada.
    let outFrames;
    if (rate === 1) {
      outFrames = nFrames;
    } else {
      // Amostras de entrada disponíveis (inclui carry de borda do chunk anterior).
      const carryFrames = Math.floor(this._ncCarry.length / CHANNELS);
      const totalIn = carryFrames + nFrames;
      outFrames = Math.max(
        0,
        Math.floor((totalIn - this._ncPos - 1) / rate) + 1,
      );
      if (outFrames <= 0) {
        // Entrada insuficiente p/ 1 frame de saída: acumula no carry e espera.
        this._acumularCarry(input);
        return Buffer.alloc(0);
      }
    }

    const out = Buffer.allocUnsafe(outFrames * CHANNELS * BYTES_PER_SAMPLE);
    // Monta janela de leitura: carry (borda anterior) + input atual, como
    // Int16 por canal para interpolação.
    let janela = null;
    if (rate !== 1) {
      janela = this._montarJanela(input, nFrames);
    }

    for (let f = 0; f < outFrames; f++) {
      for (let c = 0; c < CHANNELS; c++) {
        let v;
        if (rate === 1) {
          v = input.readInt16LE((f * CHANNELS + c) * BYTES_PER_SAMPLE);
        } else {
          const pos = this._ncPos + f * rate;
          const i0 = Math.floor(pos);
          const frac = pos - i0;
          const a = janela[i0 * CHANNELS + c];
          const b =
            i0 + 1 < janela.length / CHANNELS
              ? janela[(i0 + 1) * CHANNELS + c]
              : a; // borda: repete (evita clique)
          v = Math.round(a + (b - a) * frac);
        }
        if (bassOn) {
          // Lowshelf aproximado: lowpass one-pole do sinal + reforço.
          // y += alpha*(x - y); out = x + (gain-1)*y
          const y =
            this._bassY[c] + BASS_ALPHA * (v - this._bassY[c]);
          this._bassY[c] = y;
          v = Math.round(v + (this._bassGain - 1) * y);
        }
        out.writeInt16LE(clamp16(v), (f * CHANNELS + c) * BYTES_PER_SAMPLE);
      }
    }

    if (rate !== 1) {
      // Avança a posição e guarda a cauda não consumida como carry (até 2
      // frames de borda p/ a interpolação do próximo chunk).
      const consumidos = this._ncPos + (outFrames - 1) * rate;
      const primeiroNaoConsumido = Math.floor(consumidos) + 1;
      const carryFrames = Math.floor(this._ncCarry.length / CHANNELS);
      const totalFrames = carryFrames + nFrames;
      // Reconstrói os valores da janela p/ guardar a cauda (janela[] local).
      const resto = totalFrames - primeiroNaoConsumido;
      const guardar = Math.min(Math.max(resto, 0), 2);
      const novoCarry = [];
      for (let f = totalFrames - guardar; f < totalFrames; f++) {
        for (let c = 0; c < CHANNELS; c++) {
          novoCarry.push(janela[f * CHANNELS + c]);
        }
      }
      this._ncCarry = novoCarry;
      this._ncPos = consumidos - Math.floor(consumidos);
    }
    return out;
  }

  // Acumula input no carry quando não há dados suficientes p/ 1 frame de saída.
  _acumularCarry(input) {
    const nFrames = Math.floor(input.length / (CHANNELS * BYTES_PER_SAMPLE));
    // Cap: carry nunca passa de 4 frames (evita crescimento com rate absurdo).
    const espaco = Math.max(0, 4 - Math.floor(this._ncCarry.length / CHANNELS));
    const usar = Math.min(nFrames, espaco);
    for (let f = nFrames - usar; f < nFrames; f++) {
      for (let c = 0; c < CHANNELS; c++) {
        this._ncCarry.push(
          input.readInt16LE((f * CHANNELS + c) * BYTES_PER_SAMPLE),
        );
      }
    }
    // Se o input tinha MAIS que o espaço (chunk grande + rate alto), descarta
    // o excedente antigo (mantém só a cauda): evita drift de latência.
    while (this._ncCarry.length > 4 * CHANNELS) {
      this._ncCarry.splice(0, CHANNELS);
    }
  }

  // Monta a janela de leitura [carry + input] como array plano de Int16.
  _montarJanela(input, nFrames) {
    const carryFrames = Math.floor(this._ncCarry.length / CHANNELS);
    const total = carryFrames + nFrames;
    const janela = new Array(total * CHANNELS);
    for (let i = 0; i < this._ncCarry.length; i++) janela[i] = this._ncCarry[i];
    for (let f = 0; f < nFrames; f++) {
      for (let c = 0; c < CHANNELS; c++) {
        janela[(carryFrames + f) * CHANNELS + c] = input.readInt16LE(
          (f * CHANNELS + c) * BYTES_PER_SAMPLE,
        );
      }
    }
    return janela;
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
  DEFAULT_BASS_DB,
  DEFAULT_NIGHTCORE_RATE,
  MAX_NIGHTCORE_RATE,
  MIN_NIGHTCORE_RATE,
  BASS_CUTOFF_HZ,
  clamp16,
  dbToGain,
  parseFxAmount,
};

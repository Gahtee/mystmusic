function formatarTempo(segundos) {
  if (segundos === null || segundos === undefined || !Number.isFinite(segundos))
    return "--:--";
  const m = Math.floor(segundos / 60);
  const s = Math.floor(segundos % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function criarBarraProgresso(elapsedSec, totalSec, tamanho = 20) {
  if (!totalSec || totalSec <= 0) return "▬".repeat(tamanho);
  const proporcao = Math.max(0, Math.min(elapsedSec / totalSec, 1));
  const posicao = Math.min(tamanho - 1, Math.round(proporcao * (tamanho - 1)));
  return "▬".repeat(posicao) + "🔵" + "▬".repeat(tamanho - posicao - 1);
}

// Formata número de FX sem zeros à toa (6 -> "6", 1.25 -> "1.25").
function formatarFx(v) {
  return String(Number(Number(v).toFixed(2)));
}

// Converte string de tempo para segundos.
// Formatos aceitos:
//   "15"         → 15 min (sem separador = minutos por convenção do bot)
//   "1:30"       → 1 min 30 s   (MM:SS ou H:MM dependendo do contexto)
//   "10:20"      → 10 min 20 s
//   "1:12:14"    → 1 h 12 min 14 s
//   "00:15"      → 15 s   (zero à esquerda indica segundos)
//   "00:00:15"   → 15 s
//
// Regra para dois segmentos (A:B):
//   Se A === 0  → resultado = B segundos  (ex: 00:15 → 15 s)
//   Caso contrário → resultado = A*60 + B segundos (ex: 10:20 → 620 s)
function parseSeekInput(input) {
  input = input.trim();

  // Sem ":" — número sozinho → minutos
  if (!input.includes(":")) {
    const n = parseInt(input, 10);
    return isNaN(n) ? null : n * 60;
  }

  const partes = input.split(":").map((p) => parseInt(p, 10));
  if (partes.some(isNaN)) return null;

  if (partes.length === 3) {
    // H:MM:SS
    const [h, m, s] = partes;
    return h * 3600 + m * 60 + s;
  }

  if (partes.length === 2) {
    const [a, b] = partes;
    // Se o primeiro segmento é 0 → só segundos (00:15 → 15 s)
    if (a === 0) return b;
    // Caso contrário → MM:SS
    return a * 60 + b;
  }

  return null;
}

module.exports = {
  formatarTempo,
  criarBarraProgresso,
  formatarFx,
  parseSeekInput,
};
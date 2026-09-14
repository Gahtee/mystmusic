// Conversão de links do Spotify para o fluxo normal do bot (busca/stream no YouTube).
//
// Por que NÃO usar spotdl nem yt-dlp direto:
// - yt-dlp não extrai áudio do Spotify (DRM/login, sem extrator suportado).
// - spotdl baixa ARQUIVO (disco + CPU — péssimo no Raspberry Pi) e quebra a
//   cada mudança interna da API do Spotify; já deu erro aí e continuaria dando.
// Estratégia (leve, sem credencial, sem dependência nova):
// - Lê a página pública de embed (https://open.spotify.com/embed/<tipo>/<id>),
//   que não exige login, e extrai título+artista do JSON __NEXT_DATA__.
// - Track/episódio vira 1 query "Título - Artista" (segue o fluxo normal).
// - Álbum/playlist/artist vira coleção de queries (segue o fluxo de playlist).
// Custo no Pi: 1 fetch HTTPS de ~10-85KB por link. Sem transcodificação extra.

const EMBED_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const FETCH_TIMEOUT_MS = 15_000;

// Aceita URL aberta (com ou sem ?si=, com ou sem /intl-xx/) e URI spotify:... .
function parseSpotifyUrl(input) {
  if (!input || typeof input !== "string") return null;
  const s = input.trim();
  let m = s.match(/^spotify:(track|album|playlist|artist|episode|show):([A-Za-z0-9]{22})$/);
  if (m) return { type: m[1], id: m[2] };
  m = s.match(
    /open\.spotify\.com\/(?:intl-[a-z-]+\/)?(track|album|playlist|artist|episode|show)\/([A-Za-z0-9]{22})/i,
  );
  if (m) return { type: m[1].toLowerCase(), id: m[2] };
  return null;
}

function isSpotifyUrl(input) {
  return parseSpotifyUrl(input) !== null;
}

// O subtitle do embed usa NBSP (\u00a0) como separador de artistas.
function cleanName(s) {
  return String(s || "")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Extrai a entity do JSON embutido na página de embed. Pura (testável sem rede).
function parseEmbedEntity(html) {
  const m = String(html || "").match(
    /<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s,
  );
  if (!m) {
    throw new Error(
      "❌ Não consegui ler esse link do Spotify (página em formato inesperado).",
    );
  }
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch (err) {
    throw new Error(
      "❌ Não consegui ler esse link do Spotify (resposta inválida).",
    );
  }
  const entity = data?.props?.pageProps?.state?.data?.entity;
  if (!entity || !entity.title) {
    throw new Error(
      "❌ Link do Spotify não encontrado (privado, deletado ou restrito).",
    );
  }
  return entity;
}

// Converte a entity em resultado usável pelo manager. Pura (testável sem rede).
// Track/episódio (sem trackList) → { kind: 'track', title, query }.
// Álbum/playlist/artist (com trackList) → { kind: 'collection', title, tracks }.
function entityToResult(entity) {
  const trackList = Array.isArray(entity.trackList)
    ? entity.trackList
    : null;
  if (trackList && trackList.length > 0) {
    const tracks = trackList
      .map((t) => {
        const title = cleanName(t.title);
        const artist = cleanName(t.subtitle);
        if (!title) return null;
        return {
          title,
          artist,
          query: artist ? `${title} - ${artist}` : title,
        };
      })
      .filter(Boolean);
    if (tracks.length === 0) {
      throw new Error("❌ Essa coleção do Spotify está vazia ou indisponível.");
    }
    return { kind: "collection", title: cleanName(entity.title), tracks };
  }
  const artists = Array.isArray(entity.artists)
    ? entity.artists.map((a) => a && a.name).filter(Boolean)
    : [];
  const artist =
    artists.length > 0 ? artists.join(", ") : cleanName(entity.subtitle);
  const title = cleanName(entity.title);
  return {
    kind: "track",
    title: artist ? `${title} — ${artist}` : title,
    artist,
    query: artist ? `${title} - ${artist}` : title,
  };
}

// Resolve um link/URI do Spotify para query(s) de busca. fetchImpl injetável (testes).
async function resolveSpotifyLink(input, fetchImpl = globalThis.fetch) {
  const ref = parseSpotifyUrl(input);
  if (!ref) throw new Error("Não é um link do Spotify.");
  const url = `https://open.spotify.com/embed/${ref.type}/${ref.id}`;
  let res;
  try {
    res = await fetchImpl(url, {
      headers: {
        "User-Agent": EMBED_UA,
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(
      "⏳ O Spotify não respondeu a tempo. Tenta de novo em alguns segundos.",
    );
  }
  if (res.status === 404) {
    throw new Error(
      "❌ Link do Spotify não encontrado (privado, deletado ou restrito).",
    );
  }
  if (!res.ok) {
    throw new Error(
      "❌ Não consegui ler esse link do Spotify (pode ser privado/restrito ou o Spotify bloqueou a leitura).",
    );
  }
  const html = await res.text();
  return entityToResult(parseEmbedEntity(html));
}

// Adapta uma coleção Spotify para o formato { playlistTitle, songs } que o
// manager já usa no fluxo de playlist. url fica null DE PROPÓSITO: o stream
// otimista usa song.url || ytsearch1:query — se url fosse o link do Spotify,
// o yt-dlp tentaria (e falharia) em vez de buscar no YouTube.
function spotifyCollectionAsPlaylist(sp) {
  return {
    playlistTitle: `Spotify: ${sp.title}`,
    songs: sp.tracks.map((t) => ({
      title: t.title,
      url: null,
      thumbnail: null,
      uploader: t.artist || "Spotify",
      duration: null,
      isOpus: null,
      query: t.query,
    })),
  };
}

module.exports = {
  parseSpotifyUrl,
  isSpotifyUrl,
  cleanName,
  parseEmbedEntity,
  entityToResult,
  resolveSpotifyLink,
  spotifyCollectionAsPlaylist,
};

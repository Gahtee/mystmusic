// Conversão de links do Spotify para o fluxo normal do bot (busca/stream no YouTube).
//
// Por que NÃO usar spotdl nem yt-dlp direto:
// - yt-dlp não extrai áudio do Spotify (DRM/login, sem extrator suportado).
// - spotdl baixa ARQUIVO (disco + CPU — péssimo no Raspberry Pi) e quebra a
//   cada mudança interna da API do Spotify; já deu erro aí e continuaria dando.
// Estratégia (2 níveis):
//  1. Web API oficial COM credencial (SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET,
//     fluxo Client Credentials, server-to-server, sem login): pagina
//     /v1/playlists/{id}/tracks?limit=100&offset=N até o total — sem teto de
//     50/99. Cobre playlist e álbum de qualquer tamanho (respeitando o
//     failsafe do manager, 500).
//  2. Fallback sem credencial: página pública de embed
//     (https://open.spotify.com/embed/<tipo>/<id>), que não exige login, e
//     extrai título+artista do JSON __NEXT_DATA__ (~50 faixas/playlist).
// Custo no Pi: 1 POST de token (cache 1h) + N GETs de 100 faixas. Sem
// transcodificação extra, sem dependência nova.

const EMBED_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const FETCH_TIMEOUT_MS = 15_000;
const API_BASE = "https://api.spotify.com/v1";
const TOKEN_URL = "https://accounts.spotify.com/api/token";

// Token em memória: vale 3600s, renova com 60s de folga. Evita 1 POST por link.
let _cachedToken = null; // { token, expiresAt }

function getSpotifyCreds(env = process.env) {
  const clientId = String(env.SPOTIFY_CLIENT_ID || "").trim();
  const clientSecret = String(env.SPOTIFY_CLIENT_SECRET || "").trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

function hasSpotifyCreds(env = process.env) {
  return getSpotifyCreds(env) !== null;
}

function clearSpotifyTokenCache() {
  _cachedToken = null;
}

// POST /api/token grant_type=client_credentials + Basic(id:secret).
// fetchImpl injetável (testes). Puro o suficiente p/ mock.
async function fetchSpotifyToken(clientId, clientSecret, fetchImpl = globalThis.fetch) {
  const now = Date.now();
  if (_cachedToken && now < _cachedToken.expiresAt) return _cachedToken.token;
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  let res;
  try {
    res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(
      "⏳ O Spotify não respondeu a tempo (auth). Tenta de novo em alguns segundos.",
    );
  }
  if (res.status === 400 || res.status === 401) {
    throw new Error(
      "❌ Spotify rejeitou o Client ID/Secret (confere o .env — Settings → Basic Information no Dashboard).",
    );
  }
  if (!res.ok) {
    throw new Error(`❌ Falha ao autenticar no Spotify (HTTP ${res.status}).`);
  }
  let data;
  try {
    data = await res.json();
  } catch (err) {
    throw new Error("❌ Resposta inválida do Spotify (auth).");
  }
  if (!data || !data.access_token) {
    throw new Error("❌ Spotify não devolveu access_token.");
  }
  const ttl = Number.isFinite(Number(data.expires_in))
    ? Number(data.expires_in)
    : 3600;
  _cachedToken = {
    token: data.access_token,
    expiresAt: now + Math.max(60, ttl - 60) * 1000,
  };
  return _cachedToken.token;
}

async function apiGet(path, token, fetchImpl = globalThis.fetch) {
  let res;
  try {
    res = await fetchImpl(`${API_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
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
      "❌ Link do Spotify não encontrado (privado, deletado, restrito ou ID de exemplo — testa com um link real da tua conta).",
    );
  }
  if (res.status === 401) {
    // Token expirado/invalidado no meio da paginação: limpa o cache para o
    // próximo link renovar, mas este link falha com mensagem clara.
    clearSpotifyTokenCache();
    throw new Error("❌ Sessão do Spotify expirou — tenta de novo.");
  }
  if (!res.ok) {
    throw new Error(`❌ Spotify devolveu HTTP ${res.status} na Web API.`);
  }
  try {
    return await res.json();
  } catch (err) {
    throw new Error("❌ Resposta inválida da Web API do Spotify.");
  }
}

function artistNames(track) {
  if (!track) return "";
  const arr = Array.isArray(track.artists) ? track.artists : [];
  return arr.map((a) => (a && a.name ? String(a.name) : "")).filter(Boolean).join(", ");
}

function trackToQueryItem(name, artist) {
  const title = cleanName(name);
  const art = cleanName(artist);
  if (!title) return null;
  return { title, artist: art, query: art ? `${title} - ${art}` : title };
}

// Item de playlist pode ser track OU episode (podcast). Episode vem em
// item.episode; track em item.track (null quando indisponível/deletado).
function playlistItemToQuery(item) {
  if (!item || typeof item !== "object") return null;
  if (item.track && typeof item.track === "object" && item.track.name) {
    if (item.track.is_local) return null;
    return trackToQueryItem(item.track.name, artistNames(item.track));
  }
  if (item.episode && typeof item.episode === "object" && item.episode.name) {
    return trackToQueryItem(item.episode.name, item.episode.show?.name || "");
  }
  return null;
}

// Resolve via Web API oficial (paginação completa). Retorna o mesmo formato
// { kind, title, tracks|query } do embed, + source:'api' e total.
// Lança erro claro quando sem credencial (o chamador cai no embed).
async function resolveViaApi(ref, fetchImpl = globalThis.fetch, env = process.env) {
  const creds = getSpotifyCreds(env);
  if (!creds) throw new Error("SEM_CREDENCIAL");
  const token = await fetchSpotifyToken(creds.clientId, creds.clientSecret, fetchImpl);
  const api = (p) => apiGet(p, token, fetchImpl);

  if (ref.type === "track") {
    const t = await api(`/tracks/${ref.id}?market=BR`);
    const item = trackToQueryItem(t.name, artistNames(t));
    if (!item) throw new Error("❌ Essa faixa do Spotify está indisponível.");
    return {
      kind: "track",
      title: item.artist ? `${item.title} — ${item.artist}` : item.title,
      artist: item.artist,
      query: item.query,
      source: "api",
    };
  }

  if (ref.type === "episode") {
    const e = await api(`/episodes/${ref.id}?market=BR`);
    const item = trackToQueryItem(e.name, e.show?.name || "");
    if (!item) throw new Error("❌ Esse episódio do Spotify está indisponível.");
    return {
      kind: "track",
      title: item.artist ? `${item.title} — ${item.artist}` : item.title,
      artist: item.artist,
      query: item.query,
      source: "api",
    };
  }

  if (ref.type === "playlist") {
    const meta = await api(
      `/playlists/${ref.id}?fields=name,description,tracks(total)&market=BR`,
    );
    const total = meta?.tracks?.total ?? null;
    const tracks = [];
    let offset = 0;
    // limit=100 é o teto da API por página; pagina até o total.
    // Trava de segurança em 1000 (manager capa em 500 de qualquer forma).
    while (true) {
      const page = await api(
        `/playlists/${ref.id}/tracks?market=BR&limit=100&offset=${offset}` +
          `&fields=total,limit,offset,next,items(track(name,artists(name),is_local,type),episode(name,show(name)))`,
      );
      const items = Array.isArray(page.items) ? page.items : [];
      for (const it of items) {
        const q = playlistItemToQuery(it);
        if (q) tracks.push(q);
      }
      const pageTotal = typeof page.total === "number" ? page.total : total;
      offset += items.length;
      if (items.length === 0) break;
      if (typeof pageTotal === "number" && offset >= pageTotal) break;
      if (!page.next) break;
      if (offset >= 1000) break;
    }
    if (tracks.length === 0) {
      throw new Error("❌ Essa playlist do Spotify está vazia ou indisponível.");
    }
    return {
      kind: "collection",
      title: cleanName(meta?.name || "Playlist"),
      tracks,
      source: "api",
      total: typeof total === "number" ? total : tracks.length,
    };
  }

  if (ref.type === "album") {
    const meta = await api(`/albums/${ref.id}?fields=name,total_tracks&market=BR`);
    const total = meta?.total_tracks ?? null;
    const tracks = [];
    let offset = 0;
    while (true) {
      const page = await api(
        `/albums/${ref.id}/tracks?market=BR&limit=50&offset=${offset}`,
      );
      const items = Array.isArray(page.items) ? page.items : [];
      for (const t of items) {
        const q = trackToQueryItem(t.name, artistNames(t));
        if (q) tracks.push(q);
      }
      offset += items.length;
      if (items.length === 0) break;
      if (typeof page.total === "number" && offset >= page.total) break;
      if (!page.next) break;
      if (offset >= 1000) break;
    }
    if (tracks.length === 0) {
      throw new Error("❌ Esse álbum do Spotify está vazio ou indisponível.");
    }
    return {
      kind: "collection",
      title: cleanName(meta?.name || "Álbum"),
      tracks,
      source: "api",
      total: typeof total === "number" ? total : tracks.length,
    };
  }

  if (ref.type === "artist") {
    // A API só expõe top-tracks do artista (máx 10, sem paginação) — limite
    // do próprio Spotify, não do bot. Discografia completa exigiria
    // /artists/{id}/albums + tracks de cada álbum (caro no Pi).
    const data = await api(`/artists/${ref.id}/top-tracks?market=BR`);
    const list = Array.isArray(data.tracks) ? data.tracks : [];
    const tracks = list
      .map((t) => trackToQueryItem(t.name, artistNames(t)))
      .filter(Boolean);
    if (tracks.length === 0) {
      throw new Error("❌ Não achei faixas desse artista no Spotify.");
    }
    const artistName = cleanName(list[0] ? artistNames(list[0]).split(",")[0] : "") || "Artista";
    return { kind: "collection", title: artistName, tracks, source: "api", total: tracks.length, capped: true };
  }

  if (ref.type === "show") {
    const meta = await api(`/shows/${ref.id}?fields=name,total_episodes&market=BR`);
    const tracks = [];
    let offset = 0;
    while (true) {
      const page = await api(
        `/shows/${ref.id}/episodes?market=BR&limit=50&offset=${offset}`,
      );
      const items = Array.isArray(page.items) ? page.items : [];
      for (const e of items) {
        const q = trackToQueryItem(e.name, meta?.name || "");
        if (q) tracks.push(q);
      }
      offset += items.length;
      if (items.length === 0) break;
      if (typeof page.total === "number" && offset >= page.total) break;
      if (!page.next) break;
      if (offset >= 1000) break;
    }
    if (tracks.length === 0) {
      throw new Error("❌ Esse podcast do Spotify está vazio ou indisponível.");
    }
    return {
      kind: "collection",
      title: cleanName(meta?.name || "Podcast"),
      tracks,
      source: "api",
      total: tracks.length,
    };
  }

  throw new Error("Não é um link do Spotify.");
}

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

// O subtitle do embed usa NBSP ( ) como separador de artistas.
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
    return { kind: "collection", title: cleanName(entity.title), tracks, source: "embed" };
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
    source: "embed",
  };
}

async function resolveViaEmbed(ref, fetchImpl = globalThis.fetch) {
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

// Resolve um link/URI do Spotify para query(s) de busca. fetchImpl injetável (testes).
// Com credencial: tenta a Web API (paginação completa); se a API falhar por
// motivo transitório, cai no embed. SEM_CREDENCIAL vai direto ao embed.
async function resolveSpotifyLink(input, fetchImpl = globalThis.fetch, env = process.env) {
  const ref = parseSpotifyUrl(input);
  if (!ref) throw new Error("Não é um link do Spotify.");
  if (getSpotifyCreds(env)) {
    try {
      const viaApi = await resolveViaApi(ref, fetchImpl, env);
      const n = viaApi.kind === "collection" ? viaApi.tracks.length : 1;
      console.log(
        `[spotify] via Web API (${viaApi.source}): ${ref.type} ${ref.id} → ${n} faixa(s)` +
          (viaApi.total && viaApi.total !== n ? ` (total ${viaApi.total})` : ""),
      );
      return viaApi;
    } catch (err) {
      if (err && err.message === "SEM_CREDENCIAL") {
        return resolveViaEmbed(ref, fetchImpl);
      }
      // Erro "final" (não encontrado, credencial inválida, vazio): não
      // mascara com fallback — propaga a mensagem útil.
      if (/não encontrado|rejeitou|vazia|indisponível|expirou/i.test(err.message || "")) {
        throw err;
      }
      console.warn(`[spotify] Web API falhou (${err.message}), caindo p/ embed.`);
    }
  } else {
    console.log("[spotify] sem SPOTIFY_CLIENT_ID/SECRET — usando embed (~50 faixas).");
  }
  return resolveViaEmbed(ref, fetchImpl);
}

// Adapta uma coleção Spotify para o formato { playlistTitle, songs } que o
// manager já usa no fluxo de playlist. url fica null DE PROPÓSITO: o stream
// otimista usa song.url || ytsearch1:query — se url fosse o link do Spotify,
// o yt-dlp tentaria (e falharia) em vez de buscar no YouTube.
function spotifyCollectionAsPlaylist(sp) {
  return {
    playlistTitle: `Spotify: ${sp.title}`,
    totalOriginal: Array.isArray(sp.tracks) ? sp.tracks.length : 0,
    viaApi: sp.source === "api",
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
  resolveViaApi,
  resolveViaEmbed,
  fetchSpotifyToken,
  getSpotifyCreds,
  hasSpotifyCreds,
  clearSpotifyTokenCache,
  spotifyCollectionAsPlaylist,
};

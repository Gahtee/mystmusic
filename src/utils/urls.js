// Extrai o ID de 11 caracteres de uma URL do YouTube (watch?v= ou youtu.be/), usado
// pelo autoplay para montar a playlist "Mix" (relacionados) a partir da faixa atual.
function extrairYoutubeId(url) {
  if (!url) return null;
  const match = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

// Detecta playlist tanto do YouTube (?list=...) quanto do SoundCloud (.../sets/...).
function isPlaylistUrl(query) {
  return (
    query.includes("list=") || /soundcloud\.com\/[^/]+\/sets\//i.test(query)
  );
}

module.exports = {
  extrairYoutubeId,
  isPlaylistUrl,
};
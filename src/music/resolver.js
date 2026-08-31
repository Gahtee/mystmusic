const { spawn, exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

function friendlyExtractionError(err, query) {
    const stderr = err.stderr || '';

    if (/DRM protected/i.test(stderr)) {
        return new Error('🔒 Essa faixa é protegida por DRM e não pode ser reproduzida (comum em faixas de selo/gravadora no SoundCloud).');
    }
    if (/Video unavailable|This video is (private|unavailable)/i.test(stderr)) {
        return new Error('🚫 Esse conteúdo está indisponível (removido, privado ou bloqueado).');
    }
    if (/Sign in to confirm|age[- ]restricted/i.test(stderr)) {
        return new Error('🔞 Esse conteúdo tem restrição de idade/login e não pode ser tocado.');
    }
    if (/not available in your country|geo.?restrict/i.test(stderr)) {
        return new Error('🌍 Esse conteúdo está bloqueado na região do servidor.');
    }

    const primeiraLinhaErro = stderr.split('\n').find(l => l.trim().startsWith('ERROR'));
    return new Error(primeiraLinhaErro
        ? `Falha ao buscar "${query}": ${primeiraLinhaErro.replace(/^ERROR:\s*/, '')}`
        : `Falha ao buscar "${query}".`);
}

async function getAudioMetadata(query, searchEngine = 'ytsearch') {
    let target;
    if (query.startsWith('http://') || query.startsWith('https://')) {
        target = `"${query}"`;
    } else {
        target = `"${searchEngine}1:${query}"`;
    }

    const cmd = `yt-dlp --cookies cookies.txt --js-runtimes node --no-playlist -f "bestaudio[acodec=opus]/bestaudio/best" --print "%(title)s\n%(webpage_url)s\n%(uploader)s\n%(acodec)s\n%(thumbnail)s\n%(duration)s" ${target}`;

    let stdout;
    try {
        ({ stdout } = await execPromise(cmd));
    } catch (err) {
        throw friendlyExtractionError(err, query);
    }
    const lines = stdout.trim().split('\n');

    const pageUrl = lines[1] ? lines[1].trim() : null;

    if (!pageUrl || pageUrl === 'NA') {
        throw new Error(`Não foi possível extrair uma URL válida para: ${query}`);
    }

    const duracao = parseFloat(lines[5]);

    return {
        title: lines[0],
        url: pageUrl,
        thumbnail: (lines[4] && lines[4] !== 'NA') ? lines[4].trim() : null,
        uploader: lines[2] || "Desconhecido",
        isOpus: (lines[3] || '').trim() === 'opus',
        duration: Number.isFinite(duracao) ? duracao : null
    };
}

async function getPlaylistMetadata(playlistUrl) {

    const cmd = `yt-dlp --cookies cookies.txt --js-runtimes node --flat-playlist --playlist-end 100 --dump-single-json "${playlistUrl}"`;

    let stdout;
    try {
        ({ stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 20 }));
    } catch (err) {
        throw friendlyExtractionError(err, playlistUrl);
    }
    const playlistData = JSON.parse(stdout);
    const songs = playlistData.entries.map(entry => ({
        title: entry.title,
        url: entry.url || entry.webpage_url || (entry.id ? `https://www.youtube.com/watch?v=${entry.id}` : null),
        thumbnail: entry.thumbnail || (entry.id ? `https://img.youtube.com/vi/${entry.id}/hqdefault.jpg` : null),
        uploader: entry.uploader || entry.channel || "Desconhecido",
        duration: entry.duration || null,

        isOpus: null
    }));

    return {
        playlistTitle: playlistData.title,
        songs: songs
    };
}

function getAudioStream(url) {
    const args = [
        '--cookies', 'cookies.txt',
        '-f', 'bestaudio[acodec=opus]/bestaudio/best',
        '--js-runtimes', 'node',
        '-o', '-',
        '--no-playlist',
        '--quiet',
        '--no-warnings',
        url
    ];

    const ytProcess = spawn('yt-dlp', args);

    ytProcess.stderr.on('data', (data) => {
        console.error(`[yt-dlp error]: ${data}`);
    });

    ytProcess.on('error', (err) => {
        console.error('[SPAWN ERROR]: Falha ao iniciar o yt-dlp:', err);
    });

    return ytProcess.stdout; 
}

module.exports = { getAudioMetadata, getAudioStream, getPlaylistMetadata };
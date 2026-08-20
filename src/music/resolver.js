const { spawn, exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

async function getAudioMetadata(query) {
    let target;
    if (query.startsWith('http://') || query.startsWith('https://')) {
        target = `"${query}"`;
    } else {
        target = `"ytsearch1:${query}"`;
    }
    const cmd = `yt-dlp --cookies cookies.txt --js-runtimes node --default-search "ytsearch" --no-playlist -f "bestaudio[acodec=opus]/bestaudio" --print "%(title)s\n%(id)s\n%(uploader)s\n%(acodec)s" ${target}`;
    
    const { stdout } = await execPromise(cmd);
    const lines = stdout.trim().split('\n');
    
    const videoId = lines[1] ? lines[1].trim() : null;

    if (!videoId || videoId === 'undefined') {
        throw new Error(`Não foi possível extrair um ID de vídeo válido para a busca: ${query}`);
    }

    return {
        title: lines[0],
        url: `https://www.youtube.com/watch?v=${videoId}`,
        thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
        uploader: lines[2] || "Canal Desconhecido",
        // Sabemos com certeza o codec aqui, então definimos true/false (não null)
        isOpus: (lines[3] || '').trim() === 'opus'
    };
}

async function getPlaylistMetadata(playlistUrl) {
    const cmd = `yt-dlp --cookies cookies.txt --js-runtimes node --flat-playlist --dump-single-json "${playlistUrl}"`;
    
    const { stdout } = await execPromise(cmd);
    const playlistData = JSON.parse(stdout);
    const songs = playlistData.entries.map(entry => ({
        title: entry.title,
        url: `https://www.youtube.com/watch?v=${entry.id}`,
        thumbnail: entry.id ? `https://img.youtube.com/vi/${entry.id}/hqdefault.jpg` : null, 
        uploader: entry.uploader || entry.channel || "Canal do YouTube",
        // --flat-playlist não extrai o codec (seria lento demais fazer 1 extração por faixa).
        // null = "desconhecido", o manager assume Opus e tem fallback automático se falhar.
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
        '-f', 'bestaudio[acodec=opus]/bestaudio',
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
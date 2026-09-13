const { createAudioResource, StreamType } = require("@discordjs/voice");

function playStream(player, audioStream, streamType = StreamType.WebmOpus) {
    if (!audioStream) {
        console.error('❌ Erro: O stream de áudio está indefinido!');
        return;
    }

    const resource = createAudioResource(audioStream, {
        inputType: streamType,
        inlineVolume: false
    });

    resource.playStream.on('error', error => console.error('[STREAM ERROR]', error));
    resource.playStream.on('end', () => console.log('[STREAM END] O fluxo terminou.'));

    player.play(resource);
    return resource;
}

module.exports = { playStream };
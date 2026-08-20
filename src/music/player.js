const { createAudioResource, StreamType } = require("@discordjs/voice");

function playStream(player, audioStream) {
    if (!audioStream) {
        console.error('❌ Erro: O stream de áudio está indefinido!');
        return;
    }

    const resource = createAudioResource(audioStream, {
        inputType: StreamType.Arbitrary, 
        inlineVolume: true
    });

    resource.playStream.on('error', error => console.error('[STREAM ERROR]', error));
    resource.playStream.on('end', () => console.log('[STREAM END] O fluxo terminou.'));

    player.play(resource);
    return player;
}

module.exports = { playStream };
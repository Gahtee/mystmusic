const { exec } = require("child_process");

function updateYtDlp() {
  exec("sudo -n /usr/local/bin/yt-dlp -U", (error, stdout, stderr) => {
    if (error) {
      console.error("❌ Falha ao atualizar yt-dlp:", error.message);
      return;
    }
    console.log(`🔧 yt-dlp update check:\n${stdout.trim()}`);
  });
}

function startYtDlpAutoUpdater(intervalHours = 24) {
  updateYtDlp();
  setInterval(updateYtDlp, intervalHours * 60 * 60 * 1000);
}

module.exports = { startYtDlpAutoUpdater };
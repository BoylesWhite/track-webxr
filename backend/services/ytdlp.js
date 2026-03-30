var childProcess = require('child_process');
var path = require('path');
var fs = require('fs');

var CACHE_DIR = path.join(__dirname, '..', 'audio-cache');
var MAX_DURATION = parseInt(process.env.MAX_DURATION_SECONDS || '600', 10);

function extractVideoId(url) {
  var match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

function getTitle(url) {
  return new Promise(function (resolve) {
    childProcess.execFile('yt-dlp', ['--get-title', '--no-playlist', url], {
      timeout: 15000
    }, function (err, stdout) {
      resolve(err ? 'Unknown' : stdout.trim());
    });
  });
}

function getDuration(url) {
  return new Promise(function (resolve, reject) {
    childProcess.execFile('yt-dlp', ['--get-duration', '--no-playlist', url], {
      timeout: 15000
    }, function (err, stdout) {
      if (err) return resolve(0);
      var parts = stdout.trim().split(':').map(Number);
      var seconds = 0;
      if (parts.length === 3) seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
      else if (parts.length === 2) seconds = parts[0] * 60 + parts[1];
      else seconds = parts[0] || 0;
      resolve(seconds);
    });
  });
}

function extractAudio(url, videoId) {
  var outputPath = path.join(CACHE_DIR, videoId + '.mp3');

  if (fs.existsSync(outputPath)) {
    return Promise.resolve(outputPath);
  }

  return new Promise(function (resolve, reject) {
    var args = [
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '128K',
      '--no-playlist',
      '--match-filter', 'duration<=' + MAX_DURATION,
      '-o', outputPath,
      url
    ];

    childProcess.execFile('yt-dlp', args, { timeout: 120000 }, function (err, stdout, stderr) {
      if (err) {
        if (stderr && stderr.indexOf('duration') !== -1) {
          return reject(new Error('Video too long (max ' + Math.floor(MAX_DURATION / 60) + ' minutes)'));
        }
        return reject(new Error('Failed to extract audio: ' + (stderr || err.message)));
      }
      if (!fs.existsSync(outputPath)) {
        return reject(new Error('Audio extraction produced no output file'));
      }
      resolve(outputPath);
    });
  });
}

module.exports = {
  extractVideoId: extractVideoId,
  extractAudio: extractAudio,
  getTitle: getTitle,
  getDuration: getDuration
};

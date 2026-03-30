var childProcess = require('child_process');

var DEFAULT_BPM = 120;

function detectBPM(filePath) {
  return new Promise(function (resolve) {
    // Try aubio first
    childProcess.execFile('aubio', ['tempo', '-i', filePath], {
      timeout: 30000
    }, function (err, stdout) {
      if (!err && stdout) {
        var lines = stdout.trim().split('\n');
        // aubio tempo outputs beat timestamps, last line or summary has BPM
        // Try to find BPM in output
        for (var i = lines.length - 1; i >= 0; i--) {
          var bpm = parseFloat(lines[i]);
          if (bpm > 40 && bpm < 300) {
            return resolve(Math.round(bpm));
          }
        }
      }

      // Fallback: try ffmpeg-based detection via aubio's alternative output
      childProcess.execFile('aubio', ['tempo', '-i', filePath, '-B', '1024'], {
        timeout: 30000
      }, function (err2, stdout2) {
        if (!err2 && stdout2) {
          // Count beats and calculate BPM from timestamps
          var beats = stdout2.trim().split('\n').map(parseFloat).filter(function (n) { return !isNaN(n); });
          if (beats.length >= 4) {
            var intervals = [];
            for (var j = 1; j < beats.length; j++) {
              intervals.push(beats[j] - beats[j - 1]);
            }
            var avgInterval = intervals.reduce(function (a, b) { return a + b; }, 0) / intervals.length;
            if (avgInterval > 0) {
              var calculatedBPM = Math.round(60 / avgInterval);
              if (calculatedBPM > 40 && calculatedBPM < 300) {
                return resolve(calculatedBPM);
              }
            }
          }
        }

        console.log('BPM detection failed, using default:', DEFAULT_BPM);
        resolve(DEFAULT_BPM);
      });
    });
  });
}

module.exports = { detectBPM: detectBPM };

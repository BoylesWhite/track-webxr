var express = require('express');
var router = express.Router();
var ytdlp = require('../services/ytdlp');
var bpmDetect = require('../services/bpm-detect');

router.post('/', function (req, res) {
  var url = req.body && req.body.url;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ success: false, error: 'Missing url parameter' });
  }

  var videoId = ytdlp.extractVideoId(url);
  if (!videoId) {
    return res.status(400).json({ success: false, error: 'Invalid YouTube URL' });
  }

  var protocol = req.headers['x-forwarded-proto'] || req.protocol;
  var host = req.headers['x-forwarded-host'] || req.get('host');
  var baseUrl = protocol + '://' + host;

  Promise.all([
    ytdlp.getDuration(url),
    ytdlp.getTitle(url)
  ]).then(function (results) {
    var duration = results[0];
    var title = results[1];

    return ytdlp.extractAudio(url, videoId).then(function () {
      return bpmDetect.detectBPM(require('path').join(__dirname, '..', 'audio-cache', videoId + '.mp3'));
    }).then(function (bpm) {
      res.json({
        success: true,
        audioUrl: baseUrl + '/audio-cache/' + videoId + '.mp3',
        bpm: bpm,
        duration: duration,
        title: title
      });
    });
  }).catch(function (err) {
    console.error('Extraction error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  });
});

module.exports = router;

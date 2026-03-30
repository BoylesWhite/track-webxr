var express = require('express');
var cors = require('cors');
var rateLimit = require('express-rate-limit');
var path = require('path');
var extractRoute = require('./routes/extract');

var app = express();
var PORT = process.env.PORT || 3001;
var CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

app.use(cors({
  origin: CORS_ORIGIN,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json());

var limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { success: false, error: 'Too many requests, try again in a minute' }
});

app.use('/api', limiter);
app.use('/api/extract', extractRoute);

app.use('/audio-cache', express.static(path.join(__dirname, 'audio-cache'), {
  setHeaders: function (res) {
    res.set('Access-Control-Allow-Origin', CORS_ORIGIN);
    res.set('Cache-Control', 'public, max-age=86400');
  }
}));

app.get('/health', function (req, res) {
  res.json({ ok: true });
});

app.listen(PORT, function () {
  console.log('Track audio backend listening on port ' + PORT);
});

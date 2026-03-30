/**
 * YouTube Audio Interceptor for Track Visualizer
 *
 * Loads BEFORE main.min.js. Intercepts the Howl constructor to swap
 * the audio source when a YouTube URL is provided. If no URL is entered,
 * everything works exactly as before with the original song.
 *
 * Also injects a YouTube URL input UI into the start screen.
 */
(function () {
  'use strict';

  // ── Configuration ─────────────────────────────────────────────────────
  // Replace BACKEND_URL with your deployed backend domain
  var BACKEND_URL = 'BACKEND_URL';

  // ── State ─────────────────────────────────────────────────────────────
  window.__youtubeAudioUrl = null;
  window.__youtubeBPM = null;

  // ── Howl Constructor Interception ─────────────────────────────────────
  // main.min.js sets window.Howl during webpack module init.
  // We intercept this assignment to wrap the constructor.
  var _realHowl = null;
  var _intercepted = false;

  Object.defineProperty(window, 'Howl', {
    get: function () { return _realHowl; },
    set: function (val) {
      if (!_intercepted && val && typeof val === 'function') {
        _intercepted = true;
        var OriginalHowl = val;

        _realHowl = function WrappedHowl(opts) {
          // Only swap if user provided a YouTube URL and this is the main song
          if (window.__youtubeAudioUrl && opts && opts.src) {
            var srcStr = Array.isArray(opts.src) ? opts.src[0] : opts.src;
            if (typeof srcStr === 'string' && srcStr.indexOf('implant') !== -1) {
              console.log('[YT] Swapping audio src to:', window.__youtubeAudioUrl);
              opts.src = [window.__youtubeAudioUrl];
              // Enable CORS for cross-origin audio
              opts.html5 = false;
              opts.format = ['mp3'];
            }
          }
          return new OriginalHowl(opts);
        };

        // Preserve prototype chain and static methods
        _realHowl.prototype = OriginalHowl.prototype;
        Object.keys(OriginalHowl).forEach(function (k) {
          _realHowl[k] = OriginalHowl[k];
        });
      } else {
        _realHowl = val;
      }
    },
    configurable: true
  });

  // Also intercept Howler global (Howler.js sets both window.Howl and window.Howler)
  var _realHowler = null;
  Object.defineProperty(window, 'Howler', {
    get: function () { return _realHowler; },
    set: function (val) { _realHowler = val; },
    configurable: true
  });

  // ── Config.BPM Override ───────────────────────────────────────────────
  function overrideBPM(bpm) {
    function trySet() {
      if (window.Config) {
        window.Config.BPM = bpm;
        console.log('[YT] Config.BPM set to', bpm);
      } else {
        setTimeout(trySet, 50);
      }
    }
    trySet();
  }

  // ── UI Injection ──────────────────────────────────────────────────────
  function injectUI() {
    var ctaContainer = document.getElementById('cta-container');
    if (!ctaContainer) return;

    // Create container
    var container = document.createElement('div');
    container.id = 'yt-input-container';
    container.style.cssText = 'margin-bottom: 2em; text-align: center;';

    // Input field
    var input = document.createElement('input');
    input.type = 'text';
    input.id = 'yt-url-input';
    input.placeholder = 'Paste YouTube URL (optional)';
    input.style.cssText = [
      'font-family: Miso, Arial Narrow, sans-serif',
      'font-size: 1.5em',
      'text-transform: uppercase',
      'background: transparent',
      'border: 0.075em solid #fff',
      'color: #fff',
      'padding: 0.35em 0.6em',
      'width: 18em',
      'outline: none',
      'letter-spacing: 0.05em',
      'text-align: center'
    ].join(';');

    // Load button
    var btn = document.createElement('button');
    btn.id = 'yt-load-btn';
    btn.textContent = 'Load';
    btn.style.cssText = [
      'font-family: Miso, Arial Narrow, sans-serif',
      'font-size: 1.5em',
      'text-transform: uppercase',
      'background: transparent',
      'border: 0.075em solid #fff',
      'color: #fff',
      'padding: 0.35em 0.8em',
      'margin-left: 0.5em',
      'cursor: pointer',
      'letter-spacing: 0.1em',
      'outline: none'
    ].join(';');

    // Status display
    var status = document.createElement('div');
    status.id = 'yt-status';
    status.style.cssText = [
      'font-family: Miso, Arial Narrow, sans-serif',
      'font-size: 1.2em',
      'text-transform: uppercase',
      'color: #fff',
      'margin-top: 0.5em',
      'letter-spacing: 0.05em',
      'min-height: 1.5em'
    ].join(';');

    container.appendChild(input);
    container.appendChild(btn);
    container.appendChild(status);

    // Insert before the start button
    ctaContainer.insertBefore(container, ctaContainer.firstChild);

    // Hover effects
    btn.addEventListener('mouseenter', function () {
      btn.style.background = 'hsla(0,0%,100%,0.15)';
    });
    btn.addEventListener('mouseleave', function () {
      btn.style.background = 'transparent';
    });

    // Load button handler
    btn.addEventListener('click', function () {
      var url = input.value.trim();
      if (!url) {
        status.textContent = 'Enter a YouTube URL first';
        status.style.color = '#ff6666';
        return;
      }

      if (BACKEND_URL === 'BACKEND_URL') {
        status.textContent = 'Backend not configured — set BACKEND_URL in youtube-interceptor.js';
        status.style.color = '#ff6666';
        return;
      }

      btn.disabled = true;
      btn.style.opacity = '0.5';
      btn.style.cursor = 'default';
      status.textContent = 'Extracting audio...';
      status.style.color = '#fff';

      fetch(BACKEND_URL + '/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url })
      })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.success) {
          throw new Error(data.error || 'Extraction failed');
        }

        window.__youtubeAudioUrl = data.audioUrl;
        window.__youtubeBPM = data.bpm;

        overrideBPM(data.bpm);

        status.textContent = data.title + ' — ' + data.bpm + ' BPM';
        status.style.color = '#66ff66';
        input.disabled = true;
        input.style.opacity = '0.5';
        btn.textContent = 'Loaded';
      })
      .catch(function (err) {
        status.textContent = err.message;
        status.style.color = '#ff6666';
        btn.disabled = false;
        btn.style.opacity = '1';
        btn.style.cursor = 'pointer';
      });
    });

    // Allow Enter key to trigger load
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') btn.click();
    });
  }

  document.addEventListener('DOMContentLoaded', injectUI);

})();

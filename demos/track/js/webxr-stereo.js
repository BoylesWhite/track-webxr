/**
 * WebXR-to-WebVR Bridge for Apple Vision Pro
 *
 * This script polyfills the old WebVR 1.1 API using the modern WebXR API,
 * allowing the existing Three.js demo (which uses WebVR) to work on devices
 * that only support WebXR (like Apple Vision Pro).
 *
 * Must be loaded BEFORE the main bundle (main.min.js).
 */
(function () {
  'use strict';

  // ── On-screen debug overlay ───────────────────────────────────────────
  var debugEl = null;
  var debugLines = [];

  function createDebugPanel() {
    debugEl = document.createElement('div');
    debugEl.id = 'webxr-debug';
    debugEl.style.cssText =
      'position:fixed;top:10px;left:10px;right:10px;max-height:50vh;overflow-y:auto;' +
      'background:rgba(0,0,0,0.85);color:#0f0;font:12px/1.4 monospace;padding:10px;' +
      'z-index:99999;border-radius:8px;pointer-events:none;white-space:pre-wrap;';
    document.body.appendChild(debugEl);
  }

  function dbg(msg) {
    var line = new Date().toISOString().substr(11, 12) + ' ' + msg;
    console.log('[WebXR]', msg);
    debugLines.push(line);
    if (debugLines.length > 60) debugLines.shift();
    if (debugEl) debugEl.textContent = debugLines.join('\n');
  }

  // Create panel as soon as body exists
  if (document.body) {
    createDebugPanel();
  } else {
    document.addEventListener('DOMContentLoaded', createDebugPanel);
  }

  // ── Pre-flight checks ────────────────────────────────────────────────
  dbg('Script loaded (v3 - framebuffer fix)');
  dbg('navigator.xr: ' + (navigator.xr ? 'YES' : 'NO'));
  dbg('navigator.getVRDisplays: ' + ('getVRDisplays' in navigator ? 'YES (native WebVR, skipping polyfill)' : 'NO (will polyfill)'));
  dbg('User agent: ' + navigator.userAgent.substr(0, 120));

  if (!navigator.xr) {
    dbg('STOP: No WebXR API available');
    return;
  }
  if ('getVRDisplays' in navigator) {
    dbg('STOP: Native WebVR exists, not needed');
    return;
  }

  // ── VRFrameData polyfill ──────────────────────────────────────────────
  if (typeof window.VRFrameData === 'undefined') {
    window.VRFrameData = function VRFrameData() {
      this.leftProjectionMatrix = new Float32Array(16);
      this.rightProjectionMatrix = new Float32Array(16);
      this.leftViewMatrix = new Float32Array(16);
      this.rightViewMatrix = new Float32Array(16);
      this.pose = {
        position: new Float32Array(3),
        orientation: new Float32Array([0, 0, 0, 1])
      };
    };
    dbg('VRFrameData polyfilled');
  }

  // ── State ─────────────────────────────────────────────────────────────
  var xrSession = null;
  var xrRefSpace = null;
  var xrPose = null;
  var xrLayer = null;
  var inXRFrame = false;
  var originalBindFramebuffer = null;
  var originalViewport = null;
  var glContext = null;
  var supportedMode = null;
  var xrFrameCount = 0;

  // Cached per-eye viewport dimensions (updated each XR frame)
  var eyeRenderWidth = 0;
  var eyeRenderHeight = 0;

  // ── Detect supported session modes ────────────────────────────────────
  var modes = ['immersive-vr', 'immersive-ar', 'inline'];
  modes.forEach(function (mode) {
    navigator.xr.isSessionSupported(mode).then(function (ok) {
      dbg('isSessionSupported("' + mode + '"): ' + ok);
      if (ok && !supportedMode && mode !== 'inline') {
        supportedMode = mode;
      }
    }).catch(function (err) {
      dbg('isSessionSupported("' + mode + '") ERROR: ' + err.message);
    });
  });

  // ── FakeVRDisplay ─────────────────────────────────────────────────────
  var FakeVRDisplay = {
    displayId: 1,
    displayName: 'Apple Vision Pro (WebXR Bridge)',
    isPresenting: false,
    capabilities: {
      hasPosition: true,
      hasOrientation: true,
      hasExternalDisplay: false,
      canPresent: true,
      maxLayers: 1
    },
    stageParameters: null,
    depthNear: 0.01,
    depthFar: 2000,

    getEyeParameters: function (eye) {
      // Three.js r90 WebVRManager calls this to determine render dimensions.
      // It sets the renderer to (renderWidth * 2) x renderHeight.
      var w, h;
      if (eyeRenderWidth > 0) {
        // Use actual XR viewport dimensions (set during first frame)
        w = eyeRenderWidth;
        h = eyeRenderHeight;
      } else if (xrLayer && xrLayer.framebufferWidth > 1) {
        w = Math.round(xrLayer.framebufferWidth / 2);
        h = xrLayer.framebufferHeight;
      } else {
        // Reasonable defaults until XR layer is ready
        var dpr = window.devicePixelRatio || 1;
        w = Math.round(window.innerWidth * dpr);
        h = Math.round(window.innerHeight * dpr);
      }
      return {
        offset: new Float32Array([eye === 'left' ? -0.032 : 0.032, 0, 0]),
        renderWidth: w,
        renderHeight: h
      };
    },

    getFrameData: function (frameData) {
      if (!xrPose || !xrPose.views) return false;

      var views = xrPose.views;
      var leftView = views[0] || null;
      var rightView = views.length > 1 ? views[1] : views[0];

      for (var i = 0; i < views.length; i++) {
        if (views[i].eye === 'left') leftView = views[i];
        if (views[i].eye === 'right') rightView = views[i];
      }

      if (!leftView || !rightView) return false;

      frameData.leftProjectionMatrix.set(leftView.projectionMatrix);
      frameData.rightProjectionMatrix.set(rightView.projectionMatrix);
      frameData.leftViewMatrix.set(leftView.transform.inverse.matrix);
      frameData.rightViewMatrix.set(rightView.transform.inverse.matrix);

      var transform = xrPose.transform;
      frameData.pose.position[0] = transform.position.x;
      frameData.pose.position[1] = transform.position.y;
      frameData.pose.position[2] = transform.position.z;
      frameData.pose.orientation[0] = transform.orientation.x;
      frameData.pose.orientation[1] = transform.orientation.y;
      frameData.pose.orientation[2] = transform.orientation.z;
      frameData.pose.orientation[3] = transform.orientation.w;

      return true;
    },

    getLayers: function () {
      if (!xrLayer || !xrPose || !xrPose.views || xrPose.views.length < 2) {
        return [{
          leftBounds: [0, 0, 0.5, 1],
          rightBounds: [0.5, 0, 0.5, 1],
          source: null
        }];
      }

      var fbWidth = xrLayer.framebufferWidth;
      var fbHeight = xrLayer.framebufferHeight;
      var views = xrPose.views;
      var leftVP = xrLayer.getViewport(views[0]);
      var rightVP = xrLayer.getViewport(views[1]);

      return [{
        leftBounds: [
          leftVP.x / fbWidth, leftVP.y / fbHeight,
          leftVP.width / fbWidth, leftVP.height / fbHeight
        ],
        rightBounds: [
          rightVP.x / fbWidth, rightVP.y / fbHeight,
          rightVP.width / fbWidth, rightVP.height / fbHeight
        ],
        source: null
      }];
    },

    requestPresent: function (layers) {
      var self = this;
      dbg('requestPresent() called');

      return new Promise(function (resolve, reject) {
        function fail(msg, err) {
          dbg('FAIL: ' + msg + (err ? ' - ' + err.message : ''));
          reject(err || new Error(msg));
        }

        if (!supportedMode) {
          fail('No supported XR session mode detected');
          return;
        }

        dbg('Using mode: ' + supportedMode);

        // Find the canvas
        var source = layers && layers[0] && layers[0].source;
        var canvas = source || document.querySelector('canvas');
        dbg('Canvas: ' + (canvas ? canvas.width + 'x' + canvas.height : 'NOT FOUND'));

        if (!canvas) { fail('No canvas found'); return; }

        // Get the existing GL context (canvas already has one from Three.js)
        glContext = canvas.getContext('webgl2') || canvas.getContext('webgl');
        dbg('GL context: ' + (glContext ? 'OK (' + (glContext instanceof WebGL2RenderingContext ? 'WebGL2' : 'WebGL1') + ')' : 'FAILED'));

        if (!glContext) { fail('Could not get WebGL context'); return; }

        // Step 1: Make context XR-compatible
        var compatPromise;
        if (glContext.makeXRCompatible) {
          dbg('Calling makeXRCompatible()...');
          compatPromise = glContext.makeXRCompatible();
        } else {
          dbg('makeXRCompatible not available, skipping');
          compatPromise = Promise.resolve();
        }

        compatPromise.then(function () {
          dbg('GL is XR-compatible');

          // Step 2: Request XR session
          dbg('Requesting XR session (' + supportedMode + ')...');
          return navigator.xr.requestSession(supportedMode);

        }).then(function (session) {
          dbg('XR session obtained: ' + session);
          xrSession = session;

          // Step 3: Create XR WebGL layer
          try {
            xrLayer = new XRWebGLLayer(session, glContext);
            dbg('XRWebGLLayer created: ' + xrLayer.framebufferWidth + 'x' + xrLayer.framebufferHeight);
            dbg('XRWebGLLayer framebuffer: ' + xrLayer.framebuffer);
            dbg('XRWebGLLayer antialias: ' + xrLayer.antialias);
          } catch (e) {
            fail('XRWebGLLayer creation failed', e);
            return;
          }

          session.updateRenderState({ baseLayer: xrLayer });

          // Step 4: Get reference space
          dbg('Requesting reference space...');
          return session.requestReferenceSpace('local').catch(function (e) {
            dbg('"local" refspace failed: ' + e.message + ', trying "viewer"');
            return session.requestReferenceSpace('viewer');
          }).then(function (refSpace) {
            xrRefSpace = refSpace;
            dbg('Reference space obtained: ' + refSpace);

            self.isPresenting = true;
            xrFrameCount = 0;

            // Set up GL interception
            setupGLIntercept(glContext);

            // DO NOT resize canvas here - dimensions may be 1x1.
            // We'll update on the first real XR frame when we have viewport info.

            dbg('Session ready - waiting for first XR frame...');

            // Hide debug panel during XR (re-show on end)
            if (debugEl) debugEl.style.display = 'none';

            window.dispatchEvent(new CustomEvent('vrdisplaypresentchange', {
              detail: { display: self }
            }));

            // Handle session end
            session.addEventListener('end', function () {
              dbg('XR session ended');
              self.isPresenting = false;
              xrSession = null;
              xrRefSpace = null;
              xrPose = null;
              inXRFrame = false;
              xrLayer = null;
              xrFrameCount = 0;
              eyeRenderWidth = 0;
              eyeRenderHeight = 0;

              teardownGLIntercept(glContext);

              canvas.width = window.innerWidth * (window.devicePixelRatio || 1);
              canvas.height = window.innerHeight * (window.devicePixelRatio || 1);

              if (debugEl) debugEl.style.display = '';

              window.dispatchEvent(new CustomEvent('vrdisplaypresentchange', {
                detail: { display: self }
              }));
            });

            resolve();
          });

        }).catch(function (err) {
          fail('XR session setup failed', err);
        });
      });
    },

    exitPresent: function () {
      dbg('exitPresent() called');
      return new Promise(function (resolve, reject) {
        if (xrSession) {
          xrSession.end().then(resolve).catch(reject);
        } else {
          resolve();
        }
      });
    },

    requestAnimationFrame: function (callback) {
      if (xrSession) {
        return xrSession.requestAnimationFrame(function (time, frame) {
          inXRFrame = true;
          xrFrameCount++;

          // Get viewer pose
          if (xrRefSpace) {
            try {
              xrPose = frame.getViewerPose(xrRefSpace);
            } catch (e) {
              if (xrFrameCount < 3) dbg('getViewerPose error: ' + e.message);
            }
          }

          // Bind the XR framebuffer so Three.js renders into it
          if (xrLayer && xrLayer.framebuffer) {
            var gl = glContext;
            if (originalBindFramebuffer) {
              originalBindFramebuffer.call(gl, gl.FRAMEBUFFER, xrLayer.framebuffer);
            }
          }

          // On first frames, log XR layer info and update eye dimensions
          if (xrFrameCount <= 3 && xrLayer) {
            var fbW = xrLayer.framebufferWidth;
            var fbH = xrLayer.framebufferHeight;
            dbg('Frame ' + xrFrameCount + ': FB=' + fbW + 'x' + fbH +
              ', pose=' + (xrPose ? xrPose.views.length + ' views' : 'null'));

            if (xrPose && xrPose.views) {
              for (var i = 0; i < xrPose.views.length; i++) {
                var vp = xrLayer.getViewport(xrPose.views[i]);
                dbg('  view[' + i + '] eye=' + xrPose.views[i].eye +
                  ' VP=(' + vp.x + ',' + vp.y + ',' + vp.width + 'x' + vp.height + ')');

                // Cache the per-eye render dimensions from the first real viewport
                if (vp.width > 1 && eyeRenderWidth === 0) {
                  eyeRenderWidth = vp.width;
                  eyeRenderHeight = vp.height;
                  dbg('Eye render size set: ' + eyeRenderWidth + 'x' + eyeRenderHeight);

                  // Now resize the canvas to hold both eyes side-by-side
                  var canvas = glContext.canvas;
                  canvas.width = eyeRenderWidth * 2;
                  canvas.height = eyeRenderHeight;
                  dbg('Canvas resized to: ' + canvas.width + 'x' + canvas.height);
                }
              }
            }
          }

          try {
            callback(time);
          } catch (e) {
            if (xrFrameCount <= 3) dbg('Render callback error: ' + e.message);
          }

          inXRFrame = false;
        });
      }
      return window.requestAnimationFrame(callback);
    },

    cancelAnimationFrame: function (handle) {
      if (xrSession) {
        xrSession.cancelAnimationFrame(handle);
      } else {
        window.cancelAnimationFrame(handle);
      }
    },

    submitFrame: function () {
      // WebXR handles frame submission automatically
    }
  };

  // ── GL Intercepts ─────────────────────────────────────────────────────
  // Redirect bindFramebuffer(null) → XR framebuffer during XR frames,
  // and redirect viewport() calls to match XR viewports.
  function setupGLIntercept(gl) {
    if (originalBindFramebuffer) return; // already set up

    originalBindFramebuffer = gl.bindFramebuffer;
    gl.bindFramebuffer = function (target, framebuffer) {
      if (inXRFrame && framebuffer === null && xrLayer && xrLayer.framebuffer) {
        // Three.js binds null (= default framebuffer = canvas).
        // Redirect to the XR framebuffer instead.
        originalBindFramebuffer.call(gl, target, xrLayer.framebuffer);
      } else {
        originalBindFramebuffer.call(gl, target, framebuffer);
      }
    };

    originalViewport = gl.viewport;
    gl.viewport = function (x, y, width, height) {
      if (inXRFrame && xrPose && xrPose.views && xrLayer) {
        // During XR, Three.js sets viewports based on the canvas/eye bounds.
        // We need to map these to the actual XR layer viewports.
        // Three.js r90 renders left eye at x=0, right eye at x=renderWidth.
        // Detect which eye by x position and remap to XR viewport.
        var views = xrPose.views;
        if (views.length >= 2 && eyeRenderWidth > 0) {
          var isRightEye = (x >= eyeRenderWidth - 1); // allow 1px tolerance
          var viewIdx = isRightEye ? 1 : 0;

          // Find by eye name for reliability
          for (var i = 0; i < views.length; i++) {
            if (isRightEye && views[i].eye === 'right') { viewIdx = i; break; }
            if (!isRightEye && views[i].eye === 'left') { viewIdx = i; break; }
          }

          var vp = xrLayer.getViewport(views[viewIdx]);
          originalViewport.call(gl, vp.x, vp.y, vp.width, vp.height);
          return;
        }
      }
      originalViewport.call(gl, x, y, width, height);
    };
  }

  function teardownGLIntercept(gl) {
    if (originalBindFramebuffer) {
      gl.bindFramebuffer = originalBindFramebuffer;
      originalBindFramebuffer = null;
    }
    if (originalViewport) {
      gl.viewport = originalViewport;
      originalViewport = null;
    }
  }

  // ── navigator.getVRDisplays polyfill ──────────────────────────────────
  navigator.getVRDisplays = function () {
    dbg('getVRDisplays() called');
    return navigator.xr.isSessionSupported('immersive-vr').then(function (vrOk) {
      dbg('immersive-vr supported: ' + vrOk);
      if (vrOk) {
        supportedMode = supportedMode || 'immersive-vr';
        return [FakeVRDisplay];
      }
      return navigator.xr.isSessionSupported('immersive-ar').then(function (arOk) {
        dbg('immersive-ar supported: ' + arOk);
        if (arOk) {
          supportedMode = supportedMode || 'immersive-ar';
          return [FakeVRDisplay];
        }
        return [];
      });
    }).catch(function (err) {
      dbg('getVRDisplays error: ' + err.message);
      return [];
    });
  };

  // ── Dispatch initial vrdisplayconnect event after page loads ──────────
  window.addEventListener('DOMContentLoaded', function () {
    dbg('DOMContentLoaded fired');
    setTimeout(function () {
      navigator.getVRDisplays().then(function (displays) {
        dbg('Found ' + displays.length + ' display(s), supportedMode=' + supportedMode);
        if (displays.length > 0) {
          dbg('Dispatching vrdisplayconnect event');
          window.dispatchEvent(new CustomEvent('vrdisplayconnect', {
            detail: { display: displays[0] }
          }));
        }
      });
    }, 200);
  });

})();

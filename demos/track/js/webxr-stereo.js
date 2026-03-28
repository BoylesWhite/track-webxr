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

  // Only activate if WebXR is available and old WebVR is not
  if (!navigator.xr) return;
  if ('getVRDisplays' in navigator) return;

  var LOG = '[WebXR Bridge]';

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
  }

  // ── State ─────────────────────────────────────────────────────────────
  var xrSession = null;
  var xrRefSpace = null;
  var xrPose = null;
  var xrLayer = null;
  var inXRFrame = false;
  var originalBindFramebuffer = null;
  var glContext = null;
  var supportedMode = null; // 'immersive-vr' or 'immersive-ar'

  // ── Detect supported session mode early ───────────────────────────────
  navigator.xr.isSessionSupported('immersive-vr').then(function (supported) {
    if (supported) {
      supportedMode = 'immersive-vr';
      console.log(LOG, 'immersive-vr supported');
    } else {
      return navigator.xr.isSessionSupported('immersive-ar').then(function (arSupported) {
        if (arSupported) {
          supportedMode = 'immersive-ar';
          console.log(LOG, 'immersive-ar supported (visionOS mode)');
        } else {
          console.log(LOG, 'No immersive session type supported');
        }
      });
    }
  }).catch(function (err) {
    console.warn(LOG, 'Session support check failed:', err);
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

    getFrameData: function (frameData) {
      if (!xrPose || !xrPose.views) {
        return false;
      }

      var views = xrPose.views;

      // Handle mono (1 view) and stereo (2 views)
      var leftView = views[0] || null;
      var rightView = views.length > 1 ? views[1] : views[0];

      // Prefer explicit eye assignment
      for (var i = 0; i < views.length; i++) {
        if (views[i].eye === 'left') leftView = views[i];
        if (views[i].eye === 'right') rightView = views[i];
      }

      if (!leftView || !rightView) return false;

      // Copy projection matrices
      frameData.leftProjectionMatrix.set(leftView.projectionMatrix);
      frameData.rightProjectionMatrix.set(rightView.projectionMatrix);

      // Copy view matrices (inverse of the view transform)
      frameData.leftViewMatrix.set(leftView.transform.inverse.matrix);
      frameData.rightViewMatrix.set(rightView.transform.inverse.matrix);

      // Copy pose
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
          leftVP.x / fbWidth,
          leftVP.y / fbHeight,
          leftVP.width / fbWidth,
          leftVP.height / fbHeight
        ],
        rightBounds: [
          rightVP.x / fbWidth,
          rightVP.y / fbHeight,
          rightVP.width / fbWidth,
          rightVP.height / fbHeight
        ],
        source: null
      }];
    },

    requestPresent: function (layers) {
      var self = this;

      return new Promise(function (resolve, reject) {
        var mode = supportedMode;
        if (!mode) {
          reject(new Error('No supported WebXR session mode'));
          return;
        }

        console.log(LOG, 'requestPresent called, using mode:', mode);

        // Find the canvas from the layers argument
        var source = layers && layers[0] && layers[0].source;
        var canvas = source || document.querySelector('canvas');

        if (!canvas) {
          reject(new Error('No canvas found'));
          return;
        }

        // Get the existing GL context from the canvas
        glContext = canvas.getContext('webgl2', { xrCompatible: true }) ||
                    canvas.getContext('webgl', { xrCompatible: true });

        // If getContext returns null, the context already exists without xrCompatible.
        // Try to get the existing context and make it XR-compatible.
        if (!glContext) {
          glContext = canvas.getContext('webgl2') || canvas.getContext('webgl');
        }

        if (!glContext) {
          reject(new Error('Could not get WebGL context'));
          return;
        }

        // Make the GL context XR-compatible (required by some browsers)
        var makeCompatible;
        if (glContext.makeXRCompatible) {
          makeCompatible = glContext.makeXRCompatible();
        } else {
          makeCompatible = Promise.resolve();
        }

        makeCompatible.then(function () {
          console.log(LOG, 'GL context is XR-compatible, requesting session...');
          return navigator.xr.requestSession(mode);
        }).then(function (session) {
          console.log(LOG, 'XR session created:', session);
          xrSession = session;

          // Create the XR WebGL layer
          try {
            xrLayer = new XRWebGLLayer(session, glContext);
          } catch (e) {
            console.error(LOG, 'Failed to create XRWebGLLayer:', e);
            reject(e);
            return;
          }

          session.updateRenderState({ baseLayer: xrLayer });
          console.log(LOG, 'XR layer created, framebuffer:', xrLayer.framebufferWidth, 'x', xrLayer.framebufferHeight);

          // Try 'local' first, fall back to 'viewer'
          return session.requestReferenceSpace('local').catch(function () {
            console.log(LOG, 'local refspace unavailable, trying viewer');
            return session.requestReferenceSpace('viewer');
          }).then(function (refSpace) {
            xrRefSpace = refSpace;
            self.isPresenting = true;

            // Intercept framebuffer binding
            setupFramebufferRedirect(glContext);

            // Update canvas size to match XR framebuffer
            canvas.width = xrLayer.framebufferWidth;
            canvas.height = xrLayer.framebufferHeight;

            console.log(LOG, 'XR session active, stereo rendering enabled');

            // Dispatch the event the existing code listens for
            window.dispatchEvent(new CustomEvent('vrdisplaypresentchange', {
              detail: { display: self }
            }));

            resolve();
          });
        }).catch(function (err) {
          console.error(LOG, 'Failed to start XR session:', err);
          reject(err);
        });

        // Handle session end
        var onSessionEnd = function () {
          console.log(LOG, 'XR session ended');
          self.isPresenting = false;
          xrSession = null;
          xrRefSpace = null;
          xrPose = null;
          inXRFrame = false;
          xrLayer = null;

          teardownFramebufferRedirect(glContext);

          // Restore canvas size
          canvas.width = window.innerWidth * (window.devicePixelRatio || 1);
          canvas.height = window.innerHeight * (window.devicePixelRatio || 1);

          window.dispatchEvent(new CustomEvent('vrdisplaypresentchange', {
            detail: { display: self }
          }));
        };

        // We set this up outside the promise chain so it's ready immediately.
        // It's harmless if the session never starts (addEventListener on null is guarded).
        var checkEnd = setInterval(function () {
          if (xrSession) {
            xrSession.addEventListener('end', onSessionEnd);
            clearInterval(checkEnd);
          }
        }, 50);
        // Safety: stop checking after 10s
        setTimeout(function () { clearInterval(checkEnd); }, 10000);
      });
    },

    exitPresent: function () {
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

          // Get the viewer pose for this frame
          if (xrRefSpace) {
            xrPose = frame.getViewerPose(xrRefSpace);
          }

          // Bind the XR framebuffer before the app renders
          if (xrLayer && originalBindFramebuffer) {
            originalBindFramebuffer(glContext.FRAMEBUFFER, xrLayer.framebuffer);
          }

          callback(time);

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

  // ── GL Framebuffer Redirect ───────────────────────────────────────────
  function setupFramebufferRedirect(gl) {
    if (originalBindFramebuffer) return;

    originalBindFramebuffer = gl.bindFramebuffer.bind(gl);

    gl.bindFramebuffer = function (target, framebuffer) {
      if (inXRFrame && framebuffer === null && xrLayer) {
        originalBindFramebuffer(target, xrLayer.framebuffer);
      } else {
        originalBindFramebuffer(target, framebuffer);
      }
    };
  }

  function teardownFramebufferRedirect(gl) {
    if (originalBindFramebuffer) {
      gl.bindFramebuffer = originalBindFramebuffer;
      originalBindFramebuffer = null;
    }
  }

  // ── navigator.getVRDisplays polyfill ──────────────────────────────────
  navigator.getVRDisplays = function () {
    return navigator.xr.isSessionSupported('immersive-vr').then(function (supported) {
      if (supported) {
        supportedMode = supportedMode || 'immersive-vr';
        return [FakeVRDisplay];
      }
      return navigator.xr.isSessionSupported('immersive-ar').then(function (arSupported) {
        if (arSupported) {
          supportedMode = supportedMode || 'immersive-ar';
          return [FakeVRDisplay];
        }
        return [];
      });
    }).catch(function () {
      return [];
    });
  };

  // ── Dispatch initial vrdisplayconnect event after page loads ──────────
  window.addEventListener('DOMContentLoaded', function () {
    // Small delay to ensure main.min.js has set up its event listeners
    setTimeout(function () {
      navigator.getVRDisplays().then(function (displays) {
        if (displays.length > 0) {
          console.log(LOG, 'Dispatching vrdisplayconnect, mode:', supportedMode);
          window.dispatchEvent(new CustomEvent('vrdisplayconnect', {
            detail: { display: displays[0] }
          }));
        } else {
          console.log(LOG, 'No XR displays found');
        }
      });
    }, 100);
  });

  console.log(LOG, 'WebVR-to-WebXR polyfill loaded');

})();

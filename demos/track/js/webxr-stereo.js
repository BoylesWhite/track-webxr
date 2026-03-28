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
  var xrFrame = null;
  var xrPose = null;
  var xrLayer = null;
  var inXRFrame = false;
  var originalBindFramebuffer = null;
  var glContext = null;
  var presentResolve = null;
  var presentReject = null;

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
      if (!xrPose || !xrPose.views || xrPose.views.length < 2) {
        return false;
      }

      var views = xrPose.views;
      var leftView = null;
      var rightView = null;

      for (var i = 0; i < views.length; i++) {
        if (views[i].eye === 'left' || (!leftView && i === 0)) {
          leftView = views[i];
        }
        if (views[i].eye === 'right' || (!rightView && i === 1)) {
          rightView = views[i];
        }
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
        if (!navigator.xr) {
          reject(new Error('WebXR not available'));
          return;
        }

        // Find the canvas GL context from the layers
        var source = layers && layers[0] && layers[0].source;
        if (source) {
          glContext = source.getContext('webgl') || source.getContext('webgl2');
        }

        // If we couldn't get GL from layers, try to find the canvas
        if (!glContext) {
          var canvas = document.querySelector('canvas');
          if (canvas) {
            glContext = canvas.getContext('webgl') || canvas.getContext('webgl2');
          }
        }

        if (!glContext) {
          reject(new Error('Could not find WebGL context'));
          return;
        }

        navigator.xr.requestSession('immersive-vr').then(function (session) {
          xrSession = session;

          // Set up the XR WebGL layer
          xrLayer = new XRWebGLLayer(session, glContext);
          session.updateRenderState({ baseLayer: xrLayer });

          // Get a reference space for head tracking
          session.requestReferenceSpace('local').then(function (refSpace) {
            xrRefSpace = refSpace;

            self.isPresenting = true;

            // Intercept framebuffer binding to redirect to XR framebuffer
            setupFramebufferRedirect(glContext);

            // Update canvas size to match XR framebuffer
            var canvas = glContext.canvas;
            canvas.width = xrLayer.framebufferWidth;
            canvas.height = xrLayer.framebufferHeight;

            // Dispatch the event the existing code listens for
            window.dispatchEvent(new CustomEvent('vrdisplaypresentchange', {
              detail: { display: self }
            }));

            resolve();
          }).catch(reject);

          session.addEventListener('end', function () {
            self.isPresenting = false;
            xrSession = null;
            xrRefSpace = null;
            xrFrame = null;
            xrPose = null;
            inXRFrame = false;

            // Restore framebuffer binding
            teardownFramebufferRedirect(glContext);

            // Restore canvas size
            var canvas = glContext.canvas;
            canvas.width = window.innerWidth * window.devicePixelRatio;
            canvas.height = window.innerHeight * window.devicePixelRatio;

            window.dispatchEvent(new CustomEvent('vrdisplaypresentchange', {
              detail: { display: self }
            }));
          });

        }).catch(function (err) {
          // If immersive-vr fails, try immersive-ar (visionOS fallback)
          navigator.xr.requestSession('immersive-ar').then(function (session) {
            xrSession = session;
            xrLayer = new XRWebGLLayer(session, glContext);
            session.updateRenderState({ baseLayer: xrLayer });

            session.requestReferenceSpace('local').then(function (refSpace) {
              xrRefSpace = refSpace;
              self.isPresenting = true;

              setupFramebufferRedirect(glContext);

              var canvas = glContext.canvas;
              canvas.width = xrLayer.framebufferWidth;
              canvas.height = xrLayer.framebufferHeight;

              window.dispatchEvent(new CustomEvent('vrdisplaypresentchange', {
                detail: { display: self }
              }));

              resolve();
            }).catch(reject);

            session.addEventListener('end', function () {
              self.isPresenting = false;
              xrSession = null;
              xrRefSpace = null;
              xrFrame = null;
              xrPose = null;
              inXRFrame = false;
              teardownFramebufferRedirect(glContext);

              var canvas = glContext.canvas;
              canvas.width = window.innerWidth * window.devicePixelRatio;
              canvas.height = window.innerHeight * window.devicePixelRatio;

              window.dispatchEvent(new CustomEvent('vrdisplaypresentchange', {
                detail: { display: self }
              }));
            });

          }).catch(reject);
        });
      });
    },

    exitPresent: function () {
      var self = this;
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
          xrFrame = frame;
          inXRFrame = true;

          // Get the viewer pose for this frame
          if (xrRefSpace) {
            xrPose = frame.getViewerPose(xrRefSpace);
          }

          // Bind the XR framebuffer before the app renders
          if (xrLayer) {
            glContext.bindFramebuffer(glContext.FRAMEBUFFER, xrLayer.framebuffer);
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
  // When in XR, Three.js binds framebuffer null (the default) to render
  // to screen. We need to redirect this to the XR framebuffer instead.

  function setupFramebufferRedirect(gl) {
    if (originalBindFramebuffer) return; // Already set up

    originalBindFramebuffer = gl.bindFramebuffer.bind(gl);

    gl.bindFramebuffer = function (target, framebuffer) {
      if (inXRFrame && framebuffer === null && xrLayer) {
        // Redirect null framebuffer to XR framebuffer during XR frames
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
        return [FakeVRDisplay];
      }
      // Try immersive-ar as fallback (visionOS)
      return navigator.xr.isSessionSupported('immersive-ar').then(function (arSupported) {
        return arSupported ? [FakeVRDisplay] : [];
      });
    }).catch(function () {
      return [];
    });
  };

  // ── Dispatch initial vrdisplayconnect event after page loads ──────────
  window.addEventListener('DOMContentLoaded', function () {
    navigator.getVRDisplays().then(function (displays) {
      if (displays.length > 0) {
        window.dispatchEvent(new CustomEvent('vrdisplayconnect', {
          detail: { display: displays[0] }
        }));
      }
    });
  });

  console.log('[WebXR Bridge] WebVR-to-WebXR polyfill active');

})();

/* =========================================================
 * engine.js
 * Core renderer, scene, fog, and PS1/VHS post-processing.
 * - Low-resolution render target for PS1 chunkiness
 * - Custom VHS shader: scanlines, chromatic aberration, grain,
 *   barrel/jitter, screen distortion, brightness scaling,
 *   color bleed, tape noise bands, interlace, tracking errors
 * - Real-time shadow maps with quality presets
 * ========================================================= */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

// ----- Enhanced VHS / PS1 shader ------------------------------------------
const VHSShader = {
  uniforms: {
    tDiffuse:      { value: null },
    uTime:         { value: 0 },
    uResolution:   { value: new THREE.Vector2(1, 1) },
    uIntensity:    { value: 1.0 },
    uChroma:       { value: 0.0034 },
    uScanline:     { value: 0.21 },
    uGrain:        { value: 0.13 },
    uVignette:     { value: 0.66 },
    uJitter:       { value: 0.0 },
    uDistort:      { value: 0.0 },
    // NEW — enhanced VHS uniforms
    uColorBleed:   { value: 0.0025 },  // horizontal color smear (analog chroma bleed)
    uTapeNoise:    { value: 0.06 },    // horizontal noise bands rolling up
    uInterlace:    { value: 0.15 },    // interlace field flicker
    uTracking:     { value: 0.0 },     // tracking error (horizontal tear/offset)
    uFlickerSpeed: { value: 1.0 },     // luminance flicker rate multiplier
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2  uResolution;
    uniform float uIntensity;
    uniform float uChroma;
    uniform float uScanline;
    uniform float uGrain;
    uniform float uVignette;
    uniform float uJitter;
    uniform float uDistort;
    uniform float uColorBleed;
    uniform float uTapeNoise;
    uniform float uInterlace;
    uniform float uTracking;
    uniform float uFlickerSpeed;
    varying vec2  vUv;

    // cheap hash noise
    float hash(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    // smooth noise for tape bands
    float smoothNoise(float y, float t) {
      float i = floor(y);
      float f = fract(y);
      float a = hash(vec2(i, floor(t * 7.0)));
      float b = hash(vec2(i + 1.0, floor(t * 7.0)));
      return mix(a, b, f * f * (3.0 - 2.0 * f));
    }

    void main() {
      vec2 uv = vUv;

      // --- Tracking error: horizontal tear that drifts vertically ---
      float trackY = fract(uTime * 0.13);
      float trackBand = smoothstep(0.0, 0.02, abs(uv.y - trackY)) *
                        smoothstep(0.0, 0.02, abs(uv.y - trackY - 0.03));
      float trackOffset = (1.0 - trackBand) * uTracking * 0.08 * uIntensity;
      uv.x += trackOffset;

      // --- Barrel distortion + low-frequency wobble ---
      vec2 c = uv - 0.5;
      float r2 = dot(c, c);
      uv += c * r2 * 0.06 * uIntensity;
      uv.x += sin(uv.y * 40.0 + uTime * 1.7) * 0.0009 * uIntensity;
      uv.x += sin(uv.y * 9.0 + uTime * 0.5) * uDistort * 0.02;

      // --- Per-line jitter (stress) ---
      float lineJ = (hash(vec2(floor(uv.y * 240.0), floor(uTime * 30.0))) - 0.5) * uJitter * 0.02;
      uv.x += lineJ;

      // --- Tape noise bands (rolling horizontal static) ---
      float tapeY = uv.y + uTime * 0.25;
      float tapeBand = smoothNoise(tapeY * 12.0, uTime) * smoothNoise(tapeY * 48.0, uTime * 1.5);
      float tapeEffect = tapeBand * uTapeNoise * uIntensity;
      uv.x += tapeEffect * 0.01; // slight horizontal displacement in noisy bands

      // --- Chromatic aberration + color bleed ---
      vec2 dir = normalize(c + 1e-5);
      float ca = uChroma * uIntensity;

      // Color bleed: sample R from slightly to the left (analog chroma delay)
      float bleed = uColorBleed * uIntensity;
      float r = texture2D(tDiffuse, uv + dir * ca + vec2(-bleed, 0.0)).r;
      float g = texture2D(tDiffuse, uv).g;
      float b = texture2D(tDiffuse, uv - dir * ca + vec2(bleed * 0.5, 0.0)).b;
      vec3 col = vec3(r, g, b);

      // --- Interlace field flicker ---
      float field = mod(floor(uv.y * uResolution.y), 2.0);
      float interlaceFlick = 1.0 - uInterlace * field * (0.5 + 0.5 * sin(uTime * uFlickerSpeed * 60.0));
      col *= mix(1.0, interlaceFlick, uIntensity);

      // --- Scanlines ---
      float scan = sin(uv.y * uResolution.y * 1.4) * 0.5 + 0.5;
      col *= 1.0 - uScanline * scan * uIntensity;

      // --- Tape noise brightness modulation ---
      col = mix(col, col * (0.7 + tapeBand * 0.6), tapeEffect * 2.0);

      // --- Grain ---
      float n = hash(uv * uResolution + uTime * 60.0);
      col += (n - 0.5) * uGrain * uIntensity;

      // --- Luminance flicker (old CRT brightness instability) ---
      float lumFlicker = 1.0 - 0.015 * uIntensity * sin(uTime * uFlickerSpeed * 8.3 + 2.7);
      col *= lumFlicker;

      // --- Vignette ---
      float vig = smoothstep(0.85, 0.35, length(c));
      col *= mix(1.0, vig, uVignette);

      // --- Crush blacks for VHS feel ---
      col = pow(max(col, vec3(0.0)), vec3(1.05));

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

// --------------------------------------------------------------------------

export class Engine {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{quality?: 'low'|'medium'|'high', vhs?: boolean}} opts
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.quality = opts.quality || 'medium';
    this.vhsEnabled = opts.vhs !== false;
    this._time = 0;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(this._getPixelRatio());
    this.renderer.setClearColor(0x05070a, 1);

    // ===== TONE MAPPING + COLOR =====
    // ACES Filmic compresses highlights (flashlight hot spots, emissive bulbs)
    // and lifts shadow gradation — feels like film stock rather than raw GL.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.9;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // ===== SHADOWS =====
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = true;

    // Three.js r155+ physically correct lights — restore legacy scale
    if ('useLegacyLights' in this.renderer) this.renderer.useLegacyLights = true;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x07090e, 0.115);
    this.scene.background = new THREE.Color(0x07090e);

    this.camera = new THREE.PerspectiveCamera(72, 1, 0.05, 80);
    this.camera.position.set(0, 1.7, 0);

    // Composer + passes
    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    // Subtle bloom — catches emissive lamp bulbs and bright flashlight hits,
    // giving the air a moist, foggy "glow around the light" feel without
    // washing out the dark.
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth / 2, window.innerHeight / 2),
      0.45,  // strength
      0.7,   // radius
      0.65,  // threshold (only bright pixels bleed)
    );
    this.composer.addPass(this.bloomPass);

    this.vhsPass = new ShaderPass(VHSShader);
    this.composer.addPass(this.vhsPass);

    this._applyQuality();
    this._onResize();
    window.addEventListener('resize', () => this._onResize());
  }

  // ----------------------------------------------------------------------
  setVHSEnabled(on) {
    this.vhsEnabled = on;
    this.vhsPass.enabled = on;
  }

  setQuality(q) {
    this.quality = q;
    this._applyQuality();
    this._onResize();
  }

  /** drive screen distortion from gameplay (stress, scream, loud sfx) */
  setStress(amount /* 0..1 */) {
    const u = this.vhsPass.uniforms;
    u.uJitter.value    = amount * 0.7;
    u.uDistort.value   = amount * 0.45;
    u.uChroma.value    = 0.0034 + amount * 0.013;
    u.uGrain.value     = 0.11 + amount * 0.20;
    // New VHS stress responses
    u.uTapeNoise.value = 0.04 + amount * 0.18;
    u.uTracking.value  = amount * 0.6;
    u.uColorBleed.value = 0.0025 + amount * 0.006;
    u.uInterlace.value = 0.10 + amount * 0.25;
  }

  /** burst of distortion (e.g. weeper scream / horcror attack) */
  pulse(intensity = 1.0, duration = 0.6) {
    const u = this.vhsPass.uniforms;
    const start = performance.now();
    const baseChroma   = u.uChroma.value;
    const baseDist     = u.uDistort.value;
    const baseTracking = u.uTracking.value;
    const baseTape     = u.uTapeNoise.value;
    const tick = () => {
      const t = (performance.now() - start) / (duration * 1000);
      if (t >= 1) {
        u.uChroma.value   = baseChroma;
        u.uDistort.value  = baseDist;
        u.uTracking.value = baseTracking;
        u.uTapeNoise.value = baseTape;
        return;
      }
      const k = 1 - t;
      u.uChroma.value    = baseChroma + 0.05 * intensity * k;
      u.uDistort.value   = baseDist + 1.0 * intensity * k;
      u.uTracking.value  = baseTracking + 0.8 * intensity * k;
      u.uTapeNoise.value = baseTape + 0.3 * intensity * k;
      requestAnimationFrame(tick);
    };
    tick();
  }

  // ----------------------------------------------------------------------
  update(dt) {
    this._time += dt;
    this.vhsPass.uniforms.uTime.value = this._time;
  }

  render() {
    if (this.vhsEnabled) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  // ----------------------------------------------------------------------
  _getPixelRatio() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.quality === 'low')    return Math.min(dpr, 0.55);
    if (this.quality === 'medium') return Math.min(dpr, 0.85);
    return Math.min(dpr, 1.25);
  }

  _applyQuality() {
    // Shadow map resolution per quality tier
    if (this.quality === 'low') {
      this.scene.fog.density = 0.155;
      this.camera.far = 50;
      this.renderer.shadowMap.enabled = false; // no shadows on low
      this._shadowMapSize = 256;
      if (this.bloomPass) this.bloomPass.enabled = false;
    } else if (this.quality === 'medium') {
      this.scene.fog.density = 0.115;
      this.camera.far = 80;
      this.renderer.shadowMap.enabled = true;
      this._shadowMapSize = 1024;
      if (this.bloomPass) this.bloomPass.enabled = true;
    } else {
      this.scene.fog.density = 0.090;
      this.camera.far = 110;
      this.renderer.shadowMap.enabled = true;
      this._shadowMapSize = 2048;
      if (this.bloomPass) this.bloomPass.enabled = true;
    }
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(this._getPixelRatio());
  }

  /** Returns the current shadow map size for lights to use */
  getShadowMapSize() {
    return this._shadowMapSize || 512;
  }

  _onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    if (this.bloomPass) this.bloomPass.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.vhsPass.uniforms.uResolution.value.set(w * this._getPixelRatio(), h * this._getPixelRatio());
  }
}

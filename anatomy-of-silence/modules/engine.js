/* =========================================================
 * engine.js
 * Core renderer, scene, fog, and PS1/VHS post-processing.
 * - Low-resolution render target for PS1 chunkiness
 * - Custom VHS shader: scanlines, chromatic aberration, grain,
 *   barrel/jitter, screen distortion, brightness scaling
 * - Quality presets switch render scale + shadow params
 * ========================================================= */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

// ----- VHS / PS1 shader ---------------------------------------------------
const VHSShader = {
  uniforms: {
    tDiffuse:    { value: null },
    uTime:       { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uIntensity:  { value: 1.0 },   // 0..1 master VHS intensity
    uChroma:     { value: 0.0025 },// chromatic aberration offset
    uScanline:   { value: 0.18 },  // scanline strength
    uGrain:      { value: 0.08 },  // grain noise amount
    uVignette:   { value: 0.55 },  // vignette darkness
    uJitter:     { value: 0.0 },   // horizontal jitter (stress driven)
    uDistort:    { value: 0.0 },   // wobble (stress / scream)
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
    varying vec2  vUv;

    // cheap hash noise
    float hash(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    void main() {
      vec2 uv = vUv;

      // Subtle barrel distortion + low-frequency horizontal wobble
      vec2 c = uv - 0.5;
      float r2 = dot(c, c);
      uv += c * r2 * 0.06 * uIntensity;
      uv.x += sin(uv.y * 40.0 + uTime * 1.7) * 0.0009 * uIntensity;
      uv.x += sin(uv.y * 9.0 + uTime * 0.5) * uDistort * 0.02;

      // Per-line jitter (stress)
      float lineJ = (hash(vec2(floor(uv.y * 240.0), floor(uTime * 30.0))) - 0.5) * uJitter * 0.02;
      uv.x += lineJ;

      // Chromatic aberration: split RGB along radial direction
      vec2 dir = normalize(c + 1e-5);
      float ca = uChroma * uIntensity;
      float r = texture2D(tDiffuse, uv + dir *  ca).r;
      float g = texture2D(tDiffuse, uv).g;
      float b = texture2D(tDiffuse, uv - dir *  ca).b;
      vec3 col = vec3(r, g, b);

      // Scanlines
      float scan = sin(uv.y * uResolution.y * 1.4) * 0.5 + 0.5;
      col *= 1.0 - uScanline * scan * uIntensity;

      // Grain
      float n = hash(uv * uResolution + uTime * 60.0);
      col += (n - 0.5) * uGrain * uIntensity;

      // Vignette
      float vig = smoothstep(0.85, 0.35, length(c));
      col *= mix(1.0, vig, uVignette);

      // Crush blacks slightly for VHS feel
      col = pow(col, vec3(1.05));

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
      antialias: false,                 // PS1 look = no AA
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(this._getPixelRatio());
    this.renderer.setClearColor(0x05070a, 1);
    this.renderer.shadowMap.enabled = false; // we fake shadows via lights / vertex shading

    // Three.js r155+ switched lights to "physically correct" units, which would
    // make all our intensity values invisible. Restore legacy intensity scale
    // so a SpotLight with intensity 1.6 actually lights the scene.
    if ('useLegacyLights' in this.renderer) this.renderer.useLegacyLights = true;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x05070a, 0.075);
    this.scene.background = new THREE.Color(0x05070a);

    this.camera = new THREE.PerspectiveCamera(72, 1, 0.05, 80);
    this.camera.position.set(0, 1.7, 0);

    // Composer + passes
    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

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
    u.uJitter.value  = amount * 0.6;
    u.uDistort.value = amount * 0.4;
    u.uChroma.value  = 0.0025 + amount * 0.012;
    u.uGrain.value   = 0.08 + amount * 0.18;
  }

  /** burst of distortion (e.g. weeper scream / horcror attack) */
  pulse(intensity = 1.0, duration = 0.6) {
    const u = this.vhsPass.uniforms;
    const start = performance.now();
    const baseChroma = u.uChroma.value;
    const baseDist   = u.uDistort.value;
    const tick = () => {
      const t = (performance.now() - start) / (duration * 1000);
      if (t >= 1) {
        u.uChroma.value = baseChroma;
        u.uDistort.value = baseDist;
        return;
      }
      const k = 1 - t;
      u.uChroma.value  = baseChroma + 0.05 * intensity * k;
      u.uDistort.value = baseDist + 1.0 * intensity * k;
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
    if (this.quality === 'low') {
      this.scene.fog.density = 0.10;
      this.camera.far = 50;
    } else if (this.quality === 'medium') {
      this.scene.fog.density = 0.075;
      this.camera.far = 80;
    } else {
      this.scene.fog.density = 0.055;
      this.camera.far = 110;
    }
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(this._getPixelRatio());
  }

  _onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.vhsPass.uniforms.uResolution.value.set(w * this._getPixelRatio(), h * this._getPixelRatio());
  }
}

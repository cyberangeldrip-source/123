/* =========================================================
 * audio.js
 * Pure procedural Web Audio. No external sound files.
 *
 *  - master / sfx / ambient gain busses (volume sliders)
 *  - 3D positional panner helpers (player listener in updateListener())
 *  - one-shot SFX: footstep, glass, drop, click, hum, scream,
 *    radio static, jumpscare, vinyl crackle
 *  - looped ambient drone with slow LFO
 *  - tape recorder (record/playback) using captured oscillator events
 * ========================================================= */

import * as THREE from 'three';

export class AudioSystem {
  constructor() {
    this.ctx = null;
    this.master  = null;
    this.sfxBus  = null;
    this.ambBus  = null;

    this.listenerPos = new THREE.Vector3();
    this.listenerFwd = new THREE.Vector3(0, 0, -1);

    this._loops = [];      // ambient loops we update
    this._tapeBuffer = []; // recorded "events" (synthesized parameters)
    this._recording = false;
    this._recordStart = 0;

    this._volumes = { master: 0.8, sfx: 0.9, amb: 0.7 };
    this._started = false;
  }

  /** Must be called from a user gesture (browser autoplay policy). */
  start() {
    if (this._started) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      console.warn('Web Audio API not supported.');
      return;
    }
    this.ctx = new Ctx();

    this.master = this.ctx.createGain();
    this.master.gain.value = this._volumes.master;
    this.master.connect(this.ctx.destination);

    this.sfxBus = this.ctx.createGain();
    this.sfxBus.gain.value = this._volumes.sfx;
    this.sfxBus.connect(this.master);

    this.ambBus = this.ctx.createGain();
    this.ambBus.gain.value = this._volumes.amb;
    this.ambBus.connect(this.master);

    // Subtle global lowpass for "underwater dread" baseline
    this.colorFilter = this.ctx.createBiquadFilter();
    this.colorFilter.type = 'lowpass';
    this.colorFilter.frequency.value = 8000;
    this.colorFilter.Q.value = 0.6;
    this.master.disconnect();
    this.master.connect(this.colorFilter);
    this.colorFilter.connect(this.ctx.destination);

    this._startAmbient();
    this._started = true;
  }

  setVolume(kind, v) {
    this._volumes[kind] = v;
    if (!this.ctx) return;
    if (kind === 'master') this.master.gain.value = v;
    if (kind === 'sfx')    this.sfxBus.gain.value = v;
    if (kind === 'amb')    this.ambBus.gain.value = v;
  }

  /** Apply tinnitus / underwater filter for scream effect */
  setTinnitus(amount /* 0..1 */) {
    if (!this.colorFilter) return;
    this.colorFilter.frequency.value = 8000 - 7000 * amount;
    this.colorFilter.Q.value = 0.6 + 8 * amount;
  }

  // ----------------------------------------------------------------
  // Listener (3D)
  // ----------------------------------------------------------------
  updateListener(pos, forward) {
    if (!this.ctx) return;
    this.listenerPos.copy(pos);
    this.listenerFwd.copy(forward).normalize();
    const L = this.ctx.listener;
    if (L.positionX) {
      L.positionX.value = pos.x;
      L.positionY.value = pos.y;
      L.positionZ.value = pos.z;
      L.forwardX.value = forward.x;
      L.forwardY.value = forward.y;
      L.forwardZ.value = forward.z;
      L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
    } else {
      // older API
      L.setPosition(pos.x, pos.y, pos.z);
      L.setOrientation(forward.x, forward.y, forward.z, 0, 1, 0);
    }
  }

  /** Build a panner at world position, returns {panner, gain} chain to sfxBus. */
  _make3DChain(pos, refDist = 2, maxDist = 25, rolloff = 1.6) {
    const panner = this.ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = refDist;
    panner.maxDistance = maxDist;
    panner.rolloffFactor = rolloff;
    if (panner.positionX) {
      panner.positionX.value = pos.x;
      panner.positionY.value = pos.y;
      panner.positionZ.value = pos.z;
    } else {
      panner.setPosition(pos.x, pos.y, pos.z);
    }
    const g = this.ctx.createGain();
    g.gain.value = 1;
    g.connect(panner);
    panner.connect(this.sfxBus);
    return { panner, gain: g };
  }

  /** Move a panner each frame */
  _setPannerPos(panner, pos) {
    if (panner.positionX) {
      panner.positionX.value = pos.x;
      panner.positionY.value = pos.y;
      panner.positionZ.value = pos.z;
    } else {
      panner.setPosition(pos.x, pos.y, pos.z);
    }
  }

  // ----------------------------------------------------------------
  // Noise / oscillator helpers
  // ----------------------------------------------------------------

  /** Returns an AudioBuffer of white noise of given seconds. */
  _whiteNoiseBuffer(seconds = 1) {
    if (this._noiseBuffer && this._noiseBuffer.duration === seconds) return this._noiseBuffer;
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this._noiseBuffer = buf;
    return buf;
  }

  _pinkNoiseBuffer(seconds = 2) {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
    return buf;
  }

  // ----------------------------------------------------------------
  // Ambient drone (looping)
  // ----------------------------------------------------------------
  _startAmbient() {
    const ctx = this.ctx;
    // Two detuned low sine + filtered noise = oppressive room tone
    const o1 = ctx.createOscillator(); o1.type = 'sine'; o1.frequency.value = 55;
    const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = 82.41; // E2
    const oG = ctx.createGain(); oG.gain.value = 0.10;
    o1.connect(oG); o2.connect(oG);

    const noise = ctx.createBufferSource();
    noise.buffer = this._pinkNoiseBuffer(4);
    noise.loop = true;
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = 200;
    noiseFilter.Q.value = 1.5;
    const noiseG = ctx.createGain();
    noiseG.gain.value = 0.06;
    noise.connect(noiseFilter); noiseFilter.connect(noiseG);

    // Slow LFO on noise gain for "breathing room"
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoG = ctx.createGain(); lfoG.gain.value = 0.04;
    lfo.connect(lfoG); lfoG.connect(noiseG.gain);

    oG.connect(this.ambBus);
    noiseG.connect(this.ambBus);
    o1.start(); o2.start(); noise.start(); lfo.start();

    this._loops.push({ o1, o2, noise, lfo });
  }

  // ----------------------------------------------------------------
  // SFX — one-shots
  // ----------------------------------------------------------------

  /** Footstep at world position. Surface: 'concrete'|'tile'|'water'|'glass' */
  footstep(worldPos, surface = 'concrete', intensity = 1.0) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const { gain } = this._make3DChain(worldPos, 1, 18, 2.0);

    const noise = ctx.createBufferSource();
    noise.buffer = this._whiteNoiseBuffer(0.18);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = surface === 'tile' ? 2200 : surface === 'water' ? 800 : 1200;
    filter.Q.value = surface === 'tile' ? 6 : 2.5;

    const env = ctx.createGain();
    const t = ctx.currentTime;
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.6 * intensity, t + 0.01);
    env.gain.exponentialRampToValueAtTime(0.001, t + (surface === 'tile' ? 0.22 : 0.14));

    noise.connect(filter); filter.connect(env); env.connect(gain);
    noise.start(t);
    noise.stop(t + 0.3);
  }

  /** Player breathing — tied to stress (0..1) */
  breath(intensity = 0.5) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const noise = ctx.createBufferSource();
    noise.buffer = this._whiteNoiseBuffer(0.6);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 600 + intensity * 800;
    filter.Q.value = 2;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.18 + 0.25 * intensity, t + 0.12);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.55);

    noise.connect(filter); filter.connect(env); env.connect(this.sfxBus);
    noise.start(t); noise.stop(t + 0.7);
  }

  /** Heartbeat thump, intensity-scaled */
  heartbeat(intensity = 0.5) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(70, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.18);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.4 * intensity, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    o.connect(g); g.connect(this.sfxBus);
    o.start(t); o.stop(t + 0.3);
  }

  /** Object drop / impact */
  drop(worldPos, intensity = 1.0) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const { gain } = this._make3DChain(worldPos, 1, 30, 1.8);
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.4 * intensity, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    o.connect(g); g.connect(gain);
    o.start(t); o.stop(t + 0.4);
  }

  /** Glass break (very loud / 3D) */
  glass(worldPos) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const { gain } = this._make3DChain(worldPos, 1, 40, 1.4);
    const noise = ctx.createBufferSource();
    noise.buffer = this._whiteNoiseBuffer(0.5);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 2500;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.7, t + 0.005);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    noise.connect(hp); hp.connect(env); env.connect(gain);
    noise.start(t); noise.stop(t + 0.6);
  }

  /** Soft UI click / pickup confirm */
  click() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = 1200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
    o.connect(g); g.connect(this.sfxBus);
    o.start(t); o.stop(t + 0.1);
  }

  /** Continuous flashlight hum — returns handle so we can stop it */
  startHum(getPos /* () => Vector3 */) {
    if (!this.ctx) return null;
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 60;
    const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = 120;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700;
    const g = ctx.createGain(); g.gain.value = 0.04;

    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 0.4; panner.maxDistance = 8; panner.rolloffFactor = 1.0;
    o.connect(lp); o2.connect(lp); lp.connect(g); g.connect(panner); panner.connect(this.sfxBus);
    o.start(); o2.start();

    const handle = {
      stop: () => { try { o.stop(); o2.stop(); } catch(e){} },
      setIntensity: (i) => { g.gain.value = 0.04 * i; },
      _update: () => {
        const p = getPos();
        if (p && panner.positionX) {
          panner.positionX.value = p.x; panner.positionY.value = p.y; panner.positionZ.value = p.z;
        } else if (p) panner.setPosition(p.x, p.y, p.z);
      },
    };
    this._huming = (this._huming || []).concat(handle);
    return handle;
  }

  /** Weeper crying loop at worldPosGetter — handle returned */
  startWeeperCry(getPos) {
    if (!this.ctx) return null;
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 220;
    const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = 330;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.6;
    const lfoG = ctx.createGain(); lfoG.gain.value = 30;
    lfo.connect(lfoG); lfoG.connect(o.frequency); lfoG.connect(o2.frequency);

    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1200;
    const g = ctx.createGain(); g.gain.value = 0.0;

    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 1.5; panner.maxDistance = 30; panner.rolloffFactor = 1.4;

    o.connect(lp); o2.connect(lp); lp.connect(g); g.connect(panner); panner.connect(this.sfxBus);
    o.start(); o2.start(); lfo.start();

    const handle = {
      panner,
      stop: () => { try { o.stop(); o2.stop(); lfo.stop(); } catch(e){} },
      setVolume: (v) => { g.gain.value = v; },
      _update: () => {
        const p = getPos();
        if (p) this._setPannerPos(panner, p);
      },
    };
    return handle;
  }

  /** Weeper sonic scream (3D, distorted). intensity 0..1 -> screen pulse hint */
  weeperScream(worldPos, onPeak) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const { gain } = this._make3DChain(worldPos, 1, 50, 1.2);

    // tonal screech
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.setValueAtTime(800, t);
    o.frequency.exponentialRampToValueAtTime(2200, t + 0.15);
    o.frequency.exponentialRampToValueAtTime(180, t + 1.4);

    // noise layer
    const n = ctx.createBufferSource(); n.buffer = this._whiteNoiseBuffer(1.6);
    const nf = ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = 1500; nf.Q.value = 4;

    // distortion
    const ws = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const x = (i / 128) - 1;
      curve[i] = ((Math.PI + 4) * x) / (Math.PI + 4 * Math.abs(x));
    }
    ws.curve = curve; ws.oversample = '2x';

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.7, t + 0.06);
    env.gain.exponentialRampToValueAtTime(0.001, t + 1.6);

    o.connect(ws); n.connect(nf); nf.connect(ws);
    ws.connect(env); env.connect(gain);
    o.start(t); o.stop(t + 1.7);
    n.start(t); n.stop(t + 1.7);

    if (onPeak) setTimeout(onPeak, 60);
  }

  /** Acoustic jumpscare: heavy bass hit + noise + tinnitus ring */
  jumpscare() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    // bass thud
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(28, t + 0.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.9, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
    o.connect(g); g.connect(this.sfxBus);
    o.start(t); o.stop(t + 0.8);
    // metal scrape (noise + comb)
    const n = ctx.createBufferSource(); n.buffer = this._whiteNoiseBuffer(0.9);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 3500; bp.Q.value = 9;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.5, t + 0.02);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    n.connect(bp); bp.connect(ng); ng.connect(this.sfxBus);
    n.start(t); n.stop(t + 1.0);
    // tinnitus ring
    const ring = ctx.createOscillator(); ring.type = 'sine'; ring.frequency.value = 6500;
    const rg = ctx.createGain();
    rg.gain.setValueAtTime(0.0001, t);
    rg.gain.exponentialRampToValueAtTime(0.18, t + 0.05);
    rg.gain.exponentialRampToValueAtTime(0.001, t + 3.5);
    ring.connect(rg); rg.connect(this.sfxBus);
    ring.start(t); ring.stop(t + 3.6);
  }

  /** Whisper layer — randomly placed faint voices when stress is high */
  whisper() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const angle = Math.random() * Math.PI * 2;
    const r = 1.5;
    const pos = new THREE.Vector3(
      this.listenerPos.x + Math.cos(angle) * r,
      this.listenerPos.y,
      this.listenerPos.z + Math.sin(angle) * r,
    );
    const { gain } = this._make3DChain(pos, 0.3, 4, 1.4);
    const n = ctx.createBufferSource(); n.buffer = this._whiteNoiseBuffer(0.6);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1200; bp.Q.value = 4;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 12;
    const lfoG = ctx.createGain(); lfoG.gain.value = 600;
    lfo.connect(lfoG); lfoG.connect(bp.frequency);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.10, t + 0.1);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
    n.connect(bp); bp.connect(env); env.connect(gain);
    n.start(t); lfo.start(t); n.stop(t + 0.8); lfo.stop(t + 0.8);
  }

  /** Vinyl crackle / static used during tape playback */
  vinylCrackle(seconds = 0.3) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const n = ctx.createBufferSource(); n.buffer = this._whiteNoiseBuffer(seconds);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 3000;
    const g = ctx.createGain(); g.gain.value = 0.06;
    n.connect(hp); hp.connect(g); g.connect(this.sfxBus);
    n.start(t); n.stop(t + seconds);
  }

  // ----------------------------------------------------------------
  // Tape recorder (record + playback synthesized events)
  // ----------------------------------------------------------------
  startRecording() {
    if (!this.ctx) return;
    this._tapeBuffer = [];
    this._recording = true;
    this._recordStart = this.ctx.currentTime;
  }

  stopRecording() {
    this._recording = false;
    return this._tapeBuffer.slice();
  }

  /** Internal: log an event during recording (called by recorder.js) */
  recordEvent(event) {
    if (!this._recording || !this.ctx) return;
    event.t = this.ctx.currentTime - this._recordStart;
    this._tapeBuffer.push(event);
  }

  /**
   * Play back a tape's events from worldPos — AI hearing system can then
   * react to that location (lure mechanic).
   */
  playTape(events, worldPos, onDone) {
    if (!this.ctx || !events?.length) { onDone?.(); return; }
    const start = this.ctx.currentTime + 0.05;
    let lastT = 0;
    this.vinylCrackle(0.4);
    for (const ev of events) {
      const when = start + ev.t;
      lastT = Math.max(lastT, ev.t);
      setTimeout(() => {
        if (ev.kind === 'footstep') this.footstep(worldPos, ev.surface || 'concrete', ev.intensity || 1);
        else if (ev.kind === 'drop') this.drop(worldPos, ev.intensity || 1);
        else if (ev.kind === 'breath') this.breath(ev.intensity || 0.6);
      }, ev.t * 1000);
    }
    setTimeout(() => onDone?.(), lastT * 1000 + 200);
  }

  /** Update positional sources each frame */
  update(dt) {
    if (this._huming) this._huming.forEach(h => h._update());
  }
}

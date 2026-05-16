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

    // Cache for decoded external audio files (key: url -> AudioBuffer).
    // We only fetch each file once and reuse the decoded buffer.
    this._sampleCache = new Map();
    // Pending fetches keyed by url, so concurrent loadSample(url) calls
    // for the same url don't hit the network twice.
    this._samplePending = new Map();
  }

  /**
   * Load and decode an external audio file (mp3/ogg/wav/m4a).
   * Returns a Promise<AudioBuffer>. Safe to call before start() — the
   * decoding is deferred until the AudioContext exists.
   */
  loadSample(url) {
    if (this._sampleCache.has(url)) return Promise.resolve(this._sampleCache.get(url));
    if (this._samplePending.has(url)) return this._samplePending.get(url);

    const p = (async () => {
      // Wait until the AudioContext is created (start() runs on first user gesture)
      while (!this.ctx) await new Promise((r) => setTimeout(r, 50));
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      const arr = await res.arrayBuffer();
      const buffer = await this.ctx.decodeAudioData(arr);
      this._sampleCache.set(url, buffer);
      this._samplePending.delete(url);
      return buffer;
    })();
    this._samplePending.set(url, p);
    p.catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[audio] failed to load sample ${url}:`, err);
      this._samplePending.delete(url);
    });
    return p;
  }

  /**
   * Play a previously-decoded sample once.
   *
   * @param {AudioBuffer|string} sample  AudioBuffer (from loadSample) or a url
   * @param {object} opts
   *   - volume {number} 0..1+   default 1
   *   - rate {number}           playbackRate (1 = normal, 1.2 = +20% pitch/speed)
   *   - worldPos {THREE.Vector3} if set, plays through 3D positional chain
   *   - refDist/maxDist/rolloff for 3D distance falloff
   *   - bus 'sfx'|'amb'         default 'sfx'
   * @returns {AudioBufferSourceNode|null}
   */
  playSample(sample, opts = {}) {
    if (!this.ctx) return null;
    const buffer =
      typeof sample === 'string' ? this._sampleCache.get(sample) : sample;
    if (!buffer) {
      // Sample not loaded yet — kick off a load and bail
      if (typeof sample === 'string') this.loadSample(sample);
      return null;
    }
    const {
      volume = 1.0,
      rate = 1.0,
      worldPos = null,
      refDist = 1,
      maxDist = 25,
      rolloff = 1.4,
      bus = 'sfx',
    } = opts;

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;

    const g = this.ctx.createGain();
    g.gain.value = volume;
    src.connect(g);

    if (worldPos) {
      const { gain: chainGain } = this._make3DChain(worldPos, refDist, maxDist, rolloff);
      g.connect(chainGain);
    } else {
      g.connect(bus === 'amb' ? this.ambBus : this.sfxBus);
    }
    src.start(this.ctx.currentTime);
    return src;
  }

  /**
   * Start a looping positional sample (e.g. a creature's idle breath).
   * Returns a handle with .stop(), .setVolume(v), and ._update() — push
   * the handle into your update loop or call _update() yourself with a
   * fresh world position each frame to follow a moving entity.
   *
   * @param {AudioBuffer|string} sample
   * @param {object} opts
   *   - getPos {() => THREE.Vector3}  required for 3D tracking; called per _update
   *   - volume {number}               default 0.6
   *   - rate {number}                 default 1.0
   *   - refDist/maxDist/rolloff       3D falloff tuning
   * @returns {{stop, setVolume, _update}|null}
   */
  startLoopSample(sample, opts = {}) {
    if (!this.ctx) return null;
    const buffer =
      typeof sample === 'string' ? this._sampleCache.get(sample) : sample;
    if (!buffer) {
      if (typeof sample === 'string') this.loadSample(sample);
      return null;
    }
    const {
      getPos = null,
      volume = 0.6,
      rate = 1.0,
      refDist = 1,
      maxDist = 18,
      rolloff = 1.6,
    } = opts;

    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.playbackRate.value = rate;

    const g = ctx.createGain();
    g.gain.value = volume;
    src.connect(g);

    let panner = null;
    if (getPos) {
      panner = ctx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = refDist;
      panner.maxDistance = maxDist;
      panner.rolloffFactor = rolloff;
      g.connect(panner);
      panner.connect(this.sfxBus);
      // initial position
      const p = getPos();
      if (p) this._setPannerPos(panner, p);
    } else {
      g.connect(this.sfxBus);
    }

    src.start(ctx.currentTime);

    let stopped = false;
    const handle = {
      stop: () => {
        if (stopped) return;
        stopped = true;
        try { src.stop(); } catch (e) {}
      },
      setVolume: (v) => { g.gain.value = v; },
      setRate:   (r) => { src.playbackRate.value = r; },
      _update: () => {
        if (stopped || !panner || !getPos) return;
        const p = getPos();
        if (p) this._setPannerPos(panner, p);
      },
    };
    // Auto-tick every frame from update()
    this._huming = (this._huming || []).concat(handle);
    return handle;
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
    const t = ctx.currentTime;

    // Footsteps for the player's own steps are mostly close — use a less aggressive panner
    // so they remain audible even though the position == listener position.
    const distFromListener = worldPos ? Math.hypot(
      worldPos.x - this.listenerPos.x,
      worldPos.z - this.listenerPos.z,
    ) : 0;
    const isPlayerStep = distFromListener < 0.5;

    let outNode;
    if (isPlayerStep) {
      // Mono path → bus directly so player hears own steps clearly
      outNode = ctx.createGain();
      outNode.gain.value = 1.0;
      outNode.connect(this.sfxBus);
    } else {
      const chain = this._make3DChain(worldPos, 1, 18, 2.0);
      outNode = chain.gain;
    }

    // Heel impact — short noise burst, surface-tinted
    const noise = ctx.createBufferSource();
    noise.buffer = this._whiteNoiseBuffer(0.18);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = surface === 'tile' ? 2400 : surface === 'water' ? 700 : 1100;
    filter.Q.value = surface === 'tile' ? 5 : 2.0;

    const env = ctx.createGain();
    const peak = 0.55 * intensity;
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(peak, t + 0.008);
    env.gain.exponentialRampToValueAtTime(0.001, t + (surface === 'tile' ? 0.22 : 0.14));

    noise.connect(filter); filter.connect(env); env.connect(outNode);
    noise.start(t);
    noise.stop(t + 0.25);

    // Sub-thump — gives steps weight (low sine "tap")
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(180, t);
    o.frequency.exponentialRampToValueAtTime(80, t + 0.08);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.18 * intensity, t + 0.005);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.10);
    o.connect(og); og.connect(outNode);
    o.start(t); o.stop(t + 0.15);
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

  /** Far-away water drip — random pitch, low volume, distant reverb feel */
  drip(worldPos) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const { gain } = this._make3DChain(worldPos, 1, 35, 1.4);
    // sine that quickly bends down (water "tonk")
    const o = ctx.createOscillator();
    o.type = 'sine';
    const f0 = 600 + Math.random() * 800;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.4, t + 0.18);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    // tiny "splash" noise tail
    const n = ctx.createBufferSource(); n.buffer = this._whiteNoiseBuffer(0.15);
    const nf = ctx.createBiquadFilter(); nf.type = 'highpass'; nf.frequency.value = 2000;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t + 0.02);
    ng.gain.exponentialRampToValueAtTime(0.04, t + 0.04);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    o.connect(g); g.connect(gain);
    n.connect(nf); nf.connect(ng); ng.connect(gain);
    o.start(t); o.stop(t + 0.5);
    n.start(t + 0.02); n.stop(t + 0.2);
  }

  /** Distant metal groan — pipes shifting, building settling */
  metalGroan(worldPos) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const { gain } = this._make3DChain(worldPos, 2, 50, 1.0);
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(80, t);
    o.frequency.exponentialRampToValueAtTime(50, t + 1.8);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.value = 400; lp.Q.value = 4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.8);
    g.gain.exponentialRampToValueAtTime(0.001, t + 2.5);
    o.connect(lp); lp.connect(g); g.connect(gain);
    o.start(t); o.stop(t + 2.6);
  }

  /** Distant door slam — somewhere in the building */
  distantSlam(worldPos) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const { gain } = this._make3DChain(worldPos, 2, 60, 1.2);
    // bass thud
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(35, t + 0.4);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.5, t + 0.005);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    // wood crack
    const n = ctx.createBufferSource(); n.buffer = this._whiteNoiseBuffer(0.3);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1200;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.3, t + 0.005);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    o.connect(og); og.connect(gain);
    n.connect(lp); lp.connect(ng); ng.connect(gain);
    o.start(t); o.stop(t + 0.6);
    n.start(t); n.stop(t + 0.3);
  }

  /** Radio static burst with garbled voice — diegetic surrealism */
  radioStatic(worldPos, durationSec = 1.4) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const { gain } = this._make3DChain(worldPos || this.listenerPos, 1, 12, 1.6);

    // hissy white noise carrier
    const n = ctx.createBufferSource();
    n.buffer = this._whiteNoiseBuffer(durationSec);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
    bp.frequency.value = 2000; bp.Q.value = 2;
    const ng = ctx.createGain(); ng.gain.value = 0.08;

    // amplitude-modulated tone (fake voice formant)
    const v = ctx.createOscillator(); v.type = 'sawtooth'; v.frequency.value = 110;
    const vlp = ctx.createBiquadFilter(); vlp.type = 'lowpass'; vlp.frequency.value = 800;
    const vg = ctx.createGain(); vg.gain.value = 0.0;

    // LFO that randomly opens/closes the voice gate (so it stutters like a broken transmission)
    const lfo = ctx.createOscillator(); lfo.frequency.value = 3.7;
    const lfoG = ctx.createGain(); lfoG.gain.value = 0.06;
    lfo.connect(lfoG); lfoG.connect(vg.gain);
    vg.gain.value = 0.06;

    n.connect(bp); bp.connect(ng); ng.connect(gain);
    v.connect(vlp); vlp.connect(vg); vg.connect(gain);

    n.start(t); v.start(t); lfo.start(t);
    n.stop(t + durationSec); v.stop(t + durationSec); lfo.stop(t + durationSec);
  }

  /** Hallucinated breath right behind player — used during high stress.
   *  Position is just behind listener so HRTF places it convincingly. */
  breathBehind() {
    if (!this.ctx) return;
    // 0.4m behind the listener
    const back = this.listenerFwd.clone().multiplyScalar(-0.4);
    const pos = this.listenerPos.clone().add(back);
    pos.y -= 0.05;
    const ctx = this.ctx, t = ctx.currentTime;
    const { gain } = this._make3DChain(pos, 0.2, 2, 2.0);
    const n = ctx.createBufferSource();
    n.buffer = this._whiteNoiseBuffer(1.2);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 500; bp.Q.value = 1.4;
    // slow envelope: inhale ~0.5s, exhale ~0.7s
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.22, t + 0.4);
    env.gain.exponentialRampToValueAtTime(0.04,  t + 0.6);
    env.gain.exponentialRampToValueAtTime(0.18, t + 0.9);
    env.gain.exponentialRampToValueAtTime(0.001, t + 1.4);
    n.connect(bp); bp.connect(env); env.connect(gain);
    n.start(t); n.stop(t + 1.5);
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

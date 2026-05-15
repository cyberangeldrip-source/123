/* =========================================================
 * noiseStress.js
 * Three coupled systems:
 *   1. NoiseSystem  — meter + emit world-space sound events
 *      (footsteps, breathing, drops, glass, tape, hum, scream)
 *      AI subscribes via .listen(cb) and reacts to events whose
 *      intensity exceeds its hearing threshold at distance.
 *   2. StressSystem — accumulates from darkness, proximity to
 *      enemies, loud sounds, isolation. Decays slowly.
 *      Drives engine VHS shader, breathing/heartbeat sfx,
 *      whispers, hallucinations, extra noise output.
 *   3. CalmingSystem — Shift-hold. Darkens DOM overlay,
 *      stabilises breathing, drops stress, makes player blind
 *      for 3 seconds. Cannot be used continuously (cooldown).
 * ========================================================= */

import * as THREE from 'three';

// -------- Source noise levels per the brief (0..100 scale) --------
const SOURCE_NOISE = {
  walk: 10, sprint: 60, crouch: 4, calm: 2, idle: 0,
  breathing: 30, water: 70, glass: 80, hum: 5,
  drop: 40, tape: 50, scream: 100,
};

const SURFACE_MULT = {
  concrete: 1.0, tile: 1.4, wood: 1.1, water: 1.7, metal: 1.3,
};

// =============================================================
//  NOISE
// =============================================================
export class NoiseSystem {
  constructor() {
    this.meter = 0;             // 0..100, smoothed
    this._listeners = [];       // AI subscribers
    this._stepCooldown = 0;
  }

  /** Subscribe AI / debug. cb(event) where event = {pos, intensity, kind, t} */
  listen(cb) { this._listeners.push(cb); }

  /** Emit a world-space sound event. Intensity is 0..100 (scaled to source). */
  emit(kind, pos, intensity, audio) {
    const ev = { kind, pos: pos.clone(), intensity, t: performance.now() / 1000 };
    // visual meter spike
    this.meter = Math.min(100, Math.max(this.meter, intensity));
    for (const cb of this._listeners) cb(ev);
    return ev;
  }

  /** Per-frame: footsteps from player movement state, decay meter */
  update(dt, player, audio, surfaceLookup, stressBoost = 0) {
    // decay meter back toward 0
    this.meter = Math.max(0, this.meter - 35 * dt);

    const speed = player.getHorizontalSpeed();
    const state = player.getMovementState();
    if (!player.onGround || state === 'idle') {
      this._stepCooldown = 0.25;
      return;
    }

    // footstep cadence based on speed
    const cadence = state === 'sprint' ? 0.32 : state === 'crouch' ? 0.62 : 0.48;
    this._stepCooldown -= dt;
    if (this._stepCooldown > 0) return;
    this._stepCooldown = cadence;

    // determine surface
    const playerXZ = new THREE.Vector2(player.collider.start.x, player.collider.start.z);
    const surface = surfaceLookup ? surfaceLookup(playerXZ) : 'concrete';

    let base = SOURCE_NOISE[state] ?? SOURCE_NOISE.walk;
    base *= (SURFACE_MULT[surface] || 1);
    // stress makes you noisier (heavier breathing / clumsier feet)
    base *= 1 + stressBoost * 0.4;

    // emit footstep + 3D sfx
    const pos = new THREE.Vector3(player.collider.start.x, player.collider.start.y, player.collider.start.z);
    if (state !== 'idle' && state !== 'calm') {
      audio?.footstep(pos, surface, Math.min(1.0, base / 40));  // louder footsteps
      this.emit('footstep', pos, base, audio);
    }
  }

  /** Convenience helpers */
  noiseFromDrop(pos, audio)   { audio?.drop(pos);  this.emit('drop',   pos, SOURCE_NOISE.drop);   }
  noiseFromGlass(pos, audio)  { audio?.glass(pos); this.emit('glass',  pos, SOURCE_NOISE.glass); }
  noiseFromTape(pos)          { this.emit('tape',  pos, SOURCE_NOISE.tape); }
  noiseFromScream(pos)        { this.emit('scream',pos, SOURCE_NOISE.scream); }
  noiseFromHum(pos)           { this.emit('hum',   pos, SOURCE_NOISE.hum); }
}

// =============================================================
//  STRESS
// =============================================================
export class StressSystem {
  constructor() {
    this.value = 0;            // 0..100
    this._heartT = 0;
    this._breathT = 0;
    this._whisperT = 0;
  }

  /** Inputs that raise stress; called by gameplay each frame */
  applyDarkness(amount /* 0..1 */, dt)        { this.value += amount * 4 * dt; }
  applyEnemyProximity(distance, dt)           {
    if (distance < 8) this.value += (8 - distance) * 0.6 * dt;
  }
  applyLoudSound(intensity /* 0..100 */)      { this.value = Math.min(100, this.value + intensity * 0.15); }
  applyChase(dt)                               { this.value += 8 * dt; }
  applyIsolation(dt)                           { this.value += 0.5 * dt; }

  decay(dt, multiplier = 1) {
    this.value = Math.max(0, this.value - 1.5 * dt * multiplier);
  }

  /** 0..1 normalised — used by engine VHS, audio breath etc. */
  get norm() { return Math.min(1, this.value / 100); }

  /** Periodic side-effects: breathing, heartbeat, whispers */
  update(dt, audio) {
    const s = this.norm;
    this._heartT  += dt * (0.8 + s * 2.5);   // bpm rises with stress
    this._breathT += dt * (0.5 + s * 1.6);
    this._whisperT += dt;

    if (this._heartT >= 1 && s > 0.25) {
      this._heartT = 0;
      audio?.heartbeat(0.4 + s * 0.6);
    }
    if (this._breathT >= 1.4 && s > 0.15) {
      this._breathT = 0;
      audio?.breath(0.4 + s * 0.8);
    }
    if (s > 0.55 && this._whisperT > 4 + Math.random() * 4) {
      this._whisperT = 0;
      audio?.whisper();
    }
  }
}

// =============================================================
//  CALMING
// =============================================================
export class CalmingSystem {
  constructor() {
    this.active = false;       // true while in 3-sec calming window
    this._timer = 0;           // active duration so far
    this.duration = 3.0;
    this._cooldown = 0;        // can't re-trigger immediately
    this.cooldownDuration = 6.0;
    this._held = false;        // shift currently held this tick
    this.blindFactor = 0;      // 0..1 darkening for DOM overlay
  }

  /** call once per frame with current shift-key state */
  setHeld(held) { this._held = held; }

  /** True if the player should be visually blinded right now */
  get isBlind() { return this.active && this.blindFactor > 0.6; }

  /** Returns multiplier on stress decay while active (used by StressSystem) */
  get stressDecayMultiplier() { return this.active ? 12 : 1; }

  update(dt, stress) {
    if (this._cooldown > 0) this._cooldown -= dt;

    if (this._held && !this.active && this._cooldown <= 0) {
      this.active = true;
      this._timer = 0;
    }
    if (this.active) {
      this._timer += dt;
      // ease-in/out blind factor
      const t = this._timer / this.duration;
      this.blindFactor = Math.sin(Math.min(1, t) * Math.PI); // 0→1→0
      if (this._timer >= this.duration || !this._held) {
        this.active = false;
        this.blindFactor = 0;
        this._cooldown = this.cooldownDuration;
      }
    }
  }
}

/* =========================================================
 * noiseStress.js
 * Three coupled systems + Stamina:
 *   1. NoiseSystem  — meter fills based on movement state:
 *      walking → 30%, running → 60%, jumping → 65%
 *      Decays quickly when stopped.
 *   2. StressSystem — accumulates from darkness, proximity,
 *      loud sounds, isolation. Distance-based rate from monster.
 *      Passive fill 25% slower when monster is far.
 *   3. CalmingSystem — G-hold. Works at ALL stress levels.
 *   4. StaminaSystem — 100 max, 6sec sprint to deplete.
 *      Recovery: 15/sec if stress<40%, 8/sec if stress 50-80%.
 * ========================================================= */

import * as THREE from 'three';

// -------- Noise target levels per movement state --------
const NOISE_TARGETS = {
  idle: 0,
  walk: 30,
  sprint: 60,
  jump: 65,
  crouch: 8,
  calm: 3,
};

const SOURCE_NOISE = {
  walk: 30, sprint: 60, crouch: 8, calm: 3, idle: 0,
  breathing: 30, water: 70, glass: 80, hum: 5,
  drop: 40, tape: 50, scream: 100,
};

const SURFACE_MULT = {
  concrete: 1.0, tile: 1.4, wood: 1.1, water: 1.85, metal: 1.3,
};

// =============================================================
//  NOISE
// =============================================================
export class NoiseSystem {
  constructor() {
    this.meter = 0;             // 0..100, smoothed
    this._listeners = [];
    this._stepCooldown = 0;
    this._jumpNoise = false;
    this.lastSurface = 'concrete';   // surface under the player at last update
    this.onWater = false;            // true if player is currently on water
  }

  listen(cb) { this._listeners.push(cb); }

  emit(kind, pos, intensity, audio) {
    const ev = { kind, pos: pos.clone(), intensity, t: performance.now() / 1000 };
    for (const cb of this._listeners) cb(ev);
    return ev;
  }

  /** Set jump noise flag (called from game.js when player jumps) */
  setJumping(jumping) { this._jumpNoise = jumping; }

  /** Per-frame: drive noise meter based on player state */
  update(dt, player, audio, surfaceLookup, stressBoost = 0) {
    const state = player.getMovementState();
    const speed = player.getHorizontalSpeed();

    // Determine target noise level
    let targetNoise = NOISE_TARGETS[state] || 0;

    // Jump overrides to 65%
    if (this._jumpNoise && !player.onGround) {
      targetNoise = Math.max(targetNoise, NOISE_TARGETS.jump);
    }
    if (player.onGround && this._jumpNoise) {
      this._jumpNoise = false; // reset after landing
    }

    // Meter moves toward target
    if (targetNoise > this.meter) {
      // Fill quickly
      this.meter += (targetNoise - this.meter) * Math.min(1, dt * 4);
    } else {
      // Decay very fast when stopped (almost instant)
      const decayRate = state === 'idle' ? 120 : 60;
      this.meter = Math.max(0, this.meter - decayRate * dt);
    }

    // Clamp
    this.meter = Math.max(0, Math.min(100, this.meter));

    // Emit footstep / movement events for AI to hear
    const pos = new THREE.Vector3(player.collider.start.x, player.collider.start.y, player.collider.start.z);
    const playerXZ = new THREE.Vector2(player.collider.start.x, player.collider.start.z);
    const surface = surfaceLookup ? surfaceLookup(playerXZ) : 'concrete';
    this.lastSurface = surface;
    this.onWater = surface === 'water';

    // --- Jump landing noise (single burst when touching ground after a jump) ---
    if (this._jumpNoise && player.onGround) {
      this._jumpNoise = false;
      const jumpBase = SOURCE_NOISE.sprint * 1.1 * (SURFACE_MULT[surface] || 1);
      audio?.footstep(pos, surface, 1.0);
      this.emit('jump_land', pos, jumpBase, audio);
    }

    // No continuous footstep events when airborne or idle
    if (!player.onGround || state === 'idle') {
      this._stepCooldown = 0.15;
      return;
    }

    // Cadence-based footstep emission
    const cadence = state === 'sprint' ? 0.32 : state === 'crouch' ? 0.62 : 0.48;
    this._stepCooldown -= dt;
    if (this._stepCooldown > 0) return;
    this._stepCooldown = cadence;

    let base = SOURCE_NOISE[state] ?? SOURCE_NOISE.walk;
    base *= (SURFACE_MULT[surface] || 1);
    base *= 1 + stressBoost * 0.4;

    if (state !== 'idle' && state !== 'calm') {
      // Player-step intensity: walk=0.7, sprint=1.0, crouch=0.35
      const stepIntensity = state === 'sprint' ? 1.0 : state === 'crouch' ? 0.35 : 0.7;
      audio?.footstep(pos, surface, stepIntensity);
      this.emit('footstep', pos, base, audio);
    }
  }

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

  /** Darkness stress — SLOWER passive fill */
  applyDarkness(amount /* 0..1 */, dt) { this.value += amount * 2.5 * dt; }

  /** Enemy proximity — closer = faster stress, further = 25% slower */
  applyEnemyProximity(distance, dt) {
    if (distance < 12) {
      // Scale: at distance 0 = max stress rate, at distance 12 = 25% slower
      const proximityFactor = Math.max(0, (12 - distance) / 12);
      const baseFill = proximityFactor * 0.8;
      // If monster is far (>8m), reduce by 25%
      const distanceMult = distance > 8 ? 0.75 : 1.0;
      this.value += baseFill * distanceMult * dt;
    }
  }

  applyLoudSound(intensity /* 0..100 */) { this.value = Math.min(100, this.value + intensity * 0.15); }
  applyChase(dt)                          { this.value += 8 * dt; }
  /** Isolation stress — SLOWER */
  applyIsolation(dt)                      { this.value += 0.25 * dt; }

  /** Water/cold stress — passive while standing in flooded basement.
   *  Faster while moving (player is making splash sounds, feels exposed). */
  applyWater(dt, moving = false) {
    this.value += (moving ? 1.4 : 0.6) * dt;
  }

  decay(dt, multiplier = 1) {
    this.value = Math.max(0, this.value - 1.5 * dt * multiplier);
  }

  get norm() { return Math.min(1, this.value / 100); }

  update(dt, audio) {
    this.value = Math.min(100, Math.max(0, this.value));
    const s = this.norm;
    this._heartT  += dt * (0.8 + s * 2.5);
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
//  CALMING — G key hold. NO stress cap — works at ALL levels.
// =============================================================
export class CalmingSystem {
  constructor() {
    this.active = false;
    this._timer = 0;
    this.duration = 3.0;
    this._cooldown = 0;
    this.cooldownDuration = 6.0;
    this._held = false;
    this.blindFactor = 0;
  }

  setHeld(held) { this._held = held; }

  get isBlind() { return this.active && this.blindFactor > 0.6; }

  /** Stress decay multiplier — works regardless of stress level */
  get stressDecayMultiplier() { return this.active ? 12 : 1; }

  update(dt, stress) {
    if (this._cooldown > 0) this._cooldown -= dt;

    // FIX: Remove the stress cap check — calming should ALWAYS work
    if (this._held && !this.active && this._cooldown <= 0) {
      this.active = true;
      this._timer = 0;
    }
    if (this.active) {
      this._timer += dt;
      const t = this._timer / this.duration;
      this.blindFactor = Math.sin(Math.min(1, t) * Math.PI);
      if (this._timer >= this.duration || !this._held) {
        this.active = false;
        this.blindFactor = 0;
        this._cooldown = this.cooldownDuration;
      }
    }
  }
}

// =============================================================
//  STAMINA — 100 max, 6 seconds sprint to empty
// =============================================================
export class StaminaSystem {
  constructor() {
    this.value = 100;       // 0..100
    this.max = 100;
    this.drainPerSec = 100 / 6; // empties in 6 seconds (~16.67/sec)
    this.depleted = false;  // true when stamina hits 0 and player must wait
  }

  /** Returns recovery rate based on stress level */
  getRecoveryRate(stressNorm) {
    const stressPercent = stressNorm * 100;
    if (stressPercent <= 40) return 15;        // 15 ticks/sec
    if (stressPercent >= 50 && stressPercent <= 80) return 8; // 8 ticks/sec
    // Between 40-50% or above 80%: interpolate or use low rate
    if (stressPercent > 80) return 5;          // very slow above 80%
    return 12; // 40-50% transition
  }

  /** Call each frame. Returns whether sprint is allowed. */
  update(dt, isSprinting, stressNorm) {
    if (isSprinting && !this.depleted && this.value > 0) {
      this.value -= this.drainPerSec * dt;
      if (this.value <= 0) {
        this.value = 0;
        this.depleted = true;
      }
    } else {
      // Recover
      const rate = this.getRecoveryRate(stressNorm);
      this.value = Math.min(this.max, this.value + rate * dt);
      // Allow sprint again once recovered to at least 20%
      if (this.depleted && this.value >= 20) {
        this.depleted = false;
      }
    }
    return !this.depleted && this.value > 0;
  }

  get norm() { return this.value / this.max; }
}

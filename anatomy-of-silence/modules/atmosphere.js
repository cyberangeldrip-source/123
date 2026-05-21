/* =========================================================
 * atmosphere.js
 * Volumetric particle-based atmospheric effects for horror:
 *  - Dust motes floating in light beams
 *  - Ground fog / mist that creeps along the floor
 *  - Steam / condensation vents
 *  - Ember-like floating particles in red-lit zones
 *  - Moth swarms near broken lamps
 *  - Cold breath (visible exhale near player camera)
 *
 * All systems are GPU-friendly (BufferGeometry point clouds)
 * and fade with distance / quality settings.
 * ========================================================= */

import * as THREE from 'three';

// ----- Shared utilities ---------------------------------------------------
function randomRange(min, max) { return min + Math.random() * (max - min); }

function createPointCloud(count, material) {
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  const alphas    = new Float32Array(count);
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('alpha',    new THREE.BufferAttribute(alphas, 1));
  const points = new THREE.Points(geo, material);
  points.frustumCulled = false;
  return { points, geo, positions, alphas };
}

// --------------------------------------------------------------------------
//  DUST MOTES — tiny particles that float in light beams
// --------------------------------------------------------------------------
class DustSystem {
  constructor(scene, count = 300) {
    this.scene = scene;
    this.count = count;
    this._velocities = [];

    const mat = new THREE.PointsMaterial({
      color: 0xccbb99,
      size: 0.025,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });

    const { points, geo, positions, alphas } = createPointCloud(count, mat);
    this.points = points;
    this.geo = geo;
    this.positions = positions;
    this.alphas = alphas;
    this.scene.add(this.points);

    // Initialize particles around origin (will reposition relative to player)
    for (let i = 0; i < count; i++) {
      positions[i * 3]     = randomRange(-12, 12);
      positions[i * 3 + 1] = randomRange(0.2, 2.8);
      positions[i * 3 + 2] = randomRange(-12, 12);
      alphas[i] = randomRange(0.1, 0.5);
      this._velocities.push(new THREE.Vector3(
        randomRange(-0.02, 0.02),
        randomRange(-0.008, 0.015),
        randomRange(-0.02, 0.02),
      ));
    }
  }

  update(dt, playerPos) {
    const px = playerPos.x;
    const py = playerPos.y;
    const pz = playerPos.z;

    for (let i = 0; i < this.count; i++) {
      const i3 = i * 3;
      const vel = this._velocities[i];

      this.positions[i3]     += vel.x * dt * 60;
      this.positions[i3 + 1] += vel.y * dt * 60;
      this.positions[i3 + 2] += vel.z * dt * 60;

      // Gentle Brownian drift
      vel.x += (Math.random() - 0.5) * 0.001;
      vel.y += (Math.random() - 0.5) * 0.0005;
      vel.z += (Math.random() - 0.5) * 0.001;
      vel.x *= 0.99; vel.y *= 0.99; vel.z *= 0.99;

      // Recycle particles that drift too far from the player
      const dx = this.positions[i3] - px;
      const dy = this.positions[i3 + 1] - py;
      const dz = this.positions[i3 + 2] - pz;
      if (dx * dx + dy * dy + dz * dz > 15 * 15) {
        this.positions[i3]     = px + randomRange(-10, 10);
        this.positions[i3 + 1] = py + randomRange(-1, 1.5);
        this.positions[i3 + 2] = pz + randomRange(-10, 10);
        this.alphas[i] = randomRange(0.1, 0.4);
      }
    }

    this.geo.attributes.position.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.points);
    this.geo.dispose();
    this.points.material.dispose();
  }
}

// --------------------------------------------------------------------------
//  GROUND FOG — low-lying volumetric mist
// --------------------------------------------------------------------------
class GroundFogSystem {
  constructor(scene, count = 200) {
    this.scene = scene;
    this.count = count;
    this._ages = [];
    this._lifetimes = [];
    this._velocities = [];

    const mat = new THREE.PointsMaterial({
      color: 0x8899aa,
      size: 1.2,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
      blending: THREE.NormalBlending,
      sizeAttenuation: true,
    });

    const { points, geo, positions, alphas } = createPointCloud(count, mat);
    this.points = points;
    this.geo = geo;
    this.positions = positions;
    this.alphas = alphas;
    this.scene.add(this.points);

    for (let i = 0; i < count; i++) {
      this._resetParticle(i, new THREE.Vector3(0, 0, 0), true);
    }
  }

  _resetParticle(i, center, randomAge = false) {
    const i3 = i * 3;
    this.positions[i3]     = center.x + randomRange(-16, 16);
    this.positions[i3 + 1] = randomRange(-0.1, 0.35); // hugs the floor
    this.positions[i3 + 2] = center.z + randomRange(-16, 16);
    this._lifetimes[i] = randomRange(6, 14);
    this._ages[i] = randomAge ? randomRange(0, this._lifetimes[i]) : 0;
    this._velocities[i] = new THREE.Vector3(
      randomRange(-0.08, 0.08),
      randomRange(-0.002, 0.005),
      randomRange(-0.08, 0.08),
    );
  }

  update(dt, playerPos) {
    for (let i = 0; i < this.count; i++) {
      const i3 = i * 3;
      this._ages[i] += dt;
      const lifeT = this._ages[i] / this._lifetimes[i];

      if (lifeT >= 1) {
        this._resetParticle(i, playerPos);
        continue;
      }

      // Fade in/out
      const fade = lifeT < 0.2 ? lifeT / 0.2
                 : lifeT > 0.8 ? (1 - lifeT) / 0.2
                 : 1.0;
      this.alphas[i] = fade * 0.25;

      const vel = this._velocities[i];
      this.positions[i3]     += vel.x * dt * 60;
      this.positions[i3 + 1] += vel.y * dt * 60;
      this.positions[i3 + 2] += vel.z * dt * 60;

      // Keep fog on the floor
      if (this.positions[i3 + 1] > 0.5) this.positions[i3 + 1] = 0.5;
      if (this.positions[i3 + 1] < -0.2) this.positions[i3 + 1] = -0.2;
    }

    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.alpha.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.points);
    this.geo.dispose();
    this.points.material.dispose();
  }
}

// --------------------------------------------------------------------------
//  STEAM VENTS — localized upward plumes
// --------------------------------------------------------------------------
class SteamVent {
  constructor(scene, position, opts = {}) {
    this.scene = scene;
    this.origin = position.clone();
    this.count = opts.count || 60;
    this._ages = [];
    this._lifetimes = [];
    this._velocities = [];

    const mat = new THREE.PointsMaterial({
      color: opts.color || 0xaabbcc,
      size: opts.size || 0.4,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });

    const { points, geo, positions, alphas } = createPointCloud(this.count, mat);
    this.points = points;
    this.geo = geo;
    this.positions = positions;
    this.alphas = alphas;
    this.scene.add(this.points);

    for (let i = 0; i < this.count; i++) {
      this._resetParticle(i, true);
    }
  }

  _resetParticle(i, randomAge = false) {
    const i3 = i * 3;
    this.positions[i3]     = this.origin.x + randomRange(-0.15, 0.15);
    this.positions[i3 + 1] = this.origin.y;
    this.positions[i3 + 2] = this.origin.z + randomRange(-0.15, 0.15);
    this._lifetimes[i] = randomRange(2, 5);
    this._ages[i] = randomAge ? randomRange(0, this._lifetimes[i]) : 0;
    this._velocities[i] = new THREE.Vector3(
      randomRange(-0.03, 0.03),
      randomRange(0.3, 0.7), // upward
      randomRange(-0.03, 0.03),
    );
  }

  update(dt) {
    for (let i = 0; i < this.count; i++) {
      const i3 = i * 3;
      this._ages[i] += dt;
      const lifeT = this._ages[i] / this._lifetimes[i];

      if (lifeT >= 1) {
        this._resetParticle(i);
        continue;
      }

      const fade = lifeT < 0.15 ? lifeT / 0.15
                 : lifeT > 0.6 ? (1 - lifeT) / 0.4
                 : 1.0;
      this.alphas[i] = fade * 0.35;

      const vel = this._velocities[i];
      this.positions[i3]     += vel.x * dt * 60;
      this.positions[i3 + 1] += vel.y * dt;
      this.positions[i3 + 2] += vel.z * dt * 60;

      // Spread as it rises
      vel.x += (Math.random() - 0.5) * 0.002;
      vel.z += (Math.random() - 0.5) * 0.002;
      // Slow down vertically over time
      vel.y *= 0.998;
    }

    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.alpha.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.points);
    this.geo.dispose();
    this.points.material.dispose();
  }
}

// --------------------------------------------------------------------------
//  EMBERS — tiny glowing particles in red-lit zones (ritual/altar areas)
// --------------------------------------------------------------------------
class EmberSystem {
  constructor(scene, center, opts = {}) {
    this.scene = scene;
    this.center = center.clone();
    this.radius = opts.radius || 4;
    this.count = opts.count || 50;
    this._ages = [];
    this._lifetimes = [];
    this._velocities = [];

    const mat = new THREE.PointsMaterial({
      color: opts.color || 0xff4400,
      size: 0.04,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });

    const { points, geo, positions, alphas } = createPointCloud(this.count, mat);
    this.points = points;
    this.geo = geo;
    this.positions = positions;
    this.alphas = alphas;
    this.scene.add(this.points);

    for (let i = 0; i < this.count; i++) {
      this._resetParticle(i, true);
    }
  }

  _resetParticle(i, randomAge = false) {
    const i3 = i * 3;
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.random() * this.radius;
    this.positions[i3]     = this.center.x + Math.cos(angle) * dist;
    this.positions[i3 + 1] = this.center.y + randomRange(0.1, 0.5);
    this.positions[i3 + 2] = this.center.z + Math.sin(angle) * dist;
    this._lifetimes[i] = randomRange(3, 8);
    this._ages[i] = randomAge ? randomRange(0, this._lifetimes[i]) : 0;
    this._velocities[i] = new THREE.Vector3(
      randomRange(-0.01, 0.01),
      randomRange(0.05, 0.2),
      randomRange(-0.01, 0.01),
    );
  }

  update(dt) {
    for (let i = 0; i < this.count; i++) {
      const i3 = i * 3;
      this._ages[i] += dt;
      const lifeT = this._ages[i] / this._lifetimes[i];

      if (lifeT >= 1) {
        this._resetParticle(i);
        continue;
      }

      const fade = lifeT < 0.1 ? lifeT / 0.1
                 : lifeT > 0.7 ? (1 - lifeT) / 0.3
                 : 1.0;
      this.alphas[i] = fade * 0.8;

      const vel = this._velocities[i];
      this.positions[i3]     += vel.x * dt * 60;
      this.positions[i3 + 1] += vel.y * dt;
      this.positions[i3 + 2] += vel.z * dt * 60;

      // Swirl
      vel.x += Math.sin(this._ages[i] * 2 + i) * 0.0003;
      vel.z += Math.cos(this._ages[i] * 2 + i) * 0.0003;
    }

    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.alpha.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.points);
    this.geo.dispose();
    this.points.material.dispose();
  }
}

// --------------------------------------------------------------------------
//  COLD BREATH — visible exhale puff near camera when stress is high
// --------------------------------------------------------------------------
class ColdBreathSystem {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.count = 30;
    this._active = false;
    this._timer = 0;
    this._breathInterval = 3.5;
    this._ages = [];
    this._lifetimes = [];
    this._velocities = [];

    const mat = new THREE.PointsMaterial({
      color: 0xddeeff,
      size: 0.06,
      transparent: true,
      opacity: 0.25,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });

    const { points, geo, positions, alphas } = createPointCloud(this.count, mat);
    this.points = points;
    this.geo = geo;
    this.positions = positions;
    this.alphas = alphas;
    this.points.visible = false;
    this.scene.add(this.points);

    for (let i = 0; i < this.count; i++) {
      this._ages[i] = 999;
      this._lifetimes[i] = 1;
      this._velocities[i] = new THREE.Vector3();
    }
  }

  /** Call with stress 0..1; breath only visible above threshold */
  setStress(stress) {
    this._active = stress > 0.35;
    this._breathInterval = 3.5 - stress * 1.8; // faster breathing when stressed
  }

  _emitBreath() {
    const camPos = new THREE.Vector3();
    const camDir = new THREE.Vector3();
    this.camera.getWorldPosition(camPos);
    this.camera.getWorldDirection(camDir);

    // Emit from slightly below + in front of camera
    const origin = camPos.clone().add(camDir.clone().multiplyScalar(0.3));
    origin.y -= 0.15;

    for (let i = 0; i < this.count; i++) {
      const i3 = i * 3;
      this.positions[i3]     = origin.x + randomRange(-0.03, 0.03);
      this.positions[i3 + 1] = origin.y + randomRange(-0.02, 0.02);
      this.positions[i3 + 2] = origin.z + randomRange(-0.03, 0.03);
      this._lifetimes[i] = randomRange(0.8, 1.8);
      this._ages[i] = 0;
      this._velocities[i].set(
        camDir.x * randomRange(0.3, 0.6) + randomRange(-0.05, 0.05),
        camDir.y * 0.1 + randomRange(0.02, 0.08),
        camDir.z * randomRange(0.3, 0.6) + randomRange(-0.05, 0.05),
      );
    }
    this.points.visible = true;
  }

  update(dt) {
    if (!this._active) {
      this.points.visible = false;
      this._timer = 0;
      return;
    }

    this._timer += dt;
    if (this._timer >= this._breathInterval) {
      this._timer = 0;
      this._emitBreath();
    }

    let anyAlive = false;
    for (let i = 0; i < this.count; i++) {
      const i3 = i * 3;
      this._ages[i] += dt;
      const lifeT = this._ages[i] / this._lifetimes[i];
      if (lifeT >= 1) {
        this.alphas[i] = 0;
        continue;
      }
      anyAlive = true;

      const fade = lifeT < 0.1 ? lifeT / 0.1 : (1 - lifeT) / 0.9;
      this.alphas[i] = fade * 0.3;

      const vel = this._velocities[i];
      this.positions[i3]     += vel.x * dt;
      this.positions[i3 + 1] += vel.y * dt;
      this.positions[i3 + 2] += vel.z * dt;

      // Disperse
      vel.x *= 0.96;
      vel.y *= 0.96;
      vel.z *= 0.96;
    }

    if (!anyAlive) this.points.visible = false;
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.alpha.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.points);
    this.geo.dispose();
    this.points.material.dispose();
  }
}

// ==========================================================================
//  ATMOSPHERE MANAGER — orchestrates all subsystems
// ==========================================================================
export class AtmosphereSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   * @param {{quality?: string}} opts
   */
  constructor(scene, camera, opts = {}) {
    this.scene = scene;
    this.camera = camera;
    const quality = opts.quality || 'medium';

    // Particle counts per quality
    const dustCount = quality === 'low' ? 100 : quality === 'medium' ? 250 : 400;
    const fogCount  = quality === 'low' ? 80  : quality === 'medium' ? 160 : 250;

    this.dust = new DustSystem(scene, dustCount);
    this.groundFog = new GroundFogSystem(scene, fogCount);
    this.coldBreath = new ColdBreathSystem(scene, camera);
    this.steamVents = [];
    this.embers = [];
  }

  /** Add a steam vent at a world position */
  addSteamVent(position, opts) {
    const vent = new SteamVent(this.scene, position, opts);
    this.steamVents.push(vent);
    return vent;
  }

  /** Add ember particles around a point (e.g. altar / ritual area) */
  addEmbers(center, opts) {
    const sys = new EmberSystem(this.scene, center, opts);
    this.embers.push(sys);
    return sys;
  }

  /**
   * Update all atmosphere systems.
   * @param {number} dt — delta time
   * @param {THREE.Vector3} playerPos
   * @param {number} stress — normalized 0..1
   */
  update(dt, playerPos, stress = 0) {
    this.dust.update(dt, playerPos);
    this.groundFog.update(dt, playerPos);
    this.coldBreath.setStress(stress);
    this.coldBreath.update(dt);

    for (const vent of this.steamVents) vent.update(dt);
    for (const emb of this.embers) emb.update(dt);
  }

  dispose() {
    this.dust.dispose();
    this.groundFog.dispose();
    this.coldBreath.dispose();
    for (const vent of this.steamVents) vent.dispose();
    for (const emb of this.embers) emb.dispose();
  }
}

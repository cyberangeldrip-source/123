/* =========================================================
 * lighting.js
 * Ambient + flickering lamp helpers with real-time shadow
 * support. Shadow-casting lights are limited to the N closest
 * lamps to the player to keep GPU budget under control.
 * ========================================================= */

import * as THREE from 'three';

const MAX_SHADOW_LAMPS = 4; // max simultaneous shadow-casting point lights

export class LightingSystem {
  constructor(scene, engine) {
    this.scene = scene;
    this.engine = engine; // reference to Engine for shadow map size
    this.lamps = [];
    this._playerPos = new THREE.Vector3();

    // Slightly raised ambient — corners shouldn't be pure black, but still oppressive.
    this.ambient = new THREE.AmbientLight(0x141a22, 0.245);
    this.scene.add(this.ambient);

    // Cold "moon" hemisphere — readability without breaking horror tone
    this.hemi = new THREE.HemisphereLight(0x223040, 0x080606, 0.155);
    this.scene.add(this.hemi);
  }

  /**
   * Add a flickering point lamp with optional shadow casting.
   * @param {THREE.Vector3} pos
   * @param {{color?: number, intensity?: number, distance?: number,
   *          flicker?: number, broken?: boolean, red?: boolean,
   *          shadow?: boolean}} opts
   */
  addLamp(pos, opts = {}) {
    const color     = opts.color    ?? (opts.red ? 0xb30000 : 0xffd9a0);
    const baseIntensity = opts.intensity ?? (opts.red ? 1.6 : 1.3);
    const intensity = baseIntensity * 0.78;     // darkening pass
    const distance  = opts.distance  ?? (opts.red ? 7.0 : 8.0);
    const flicker   = opts.flicker   ?? 0.18;
    const wantShadow = opts.shadow !== false; // default: eligible for shadows

    const light = new THREE.PointLight(color, intensity, distance, 2.0);
    light.position.copy(pos);

    // Shadow setup (initially disabled; proximity system toggles at runtime)
    light.castShadow = false;
    const mapSize = this.engine?.getShadowMapSize?.() || 512;
    light.shadow.mapSize.set(mapSize, mapSize);
    light.shadow.camera.near = 0.1;
    light.shadow.camera.far = distance;
    light.shadow.bias = -0.002;
    light.shadow.radius = 3; // soft shadow blur

    this.scene.add(light);

    // Visual bulb (tiny emissive sphere)
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.06, 6, 6),
      new THREE.MeshBasicMaterial({ color })
    );
    bulb.position.copy(pos);
    this.scene.add(bulb);

    const lamp = {
      light, bulb,
      base: intensity,
      flicker,
      broken: opts.broken === true,
      seed: Math.random() * 100,
      dead: false,
      wantShadow,
      _distSq: 0, // cached squared distance to player
    };
    this.lamps.push(lamp);
    return lamp;
  }

  /**
   * Call once per frame with current time and player position.
   * Handles flicker + proximity-based shadow activation.
   */
  update(t, playerPos) {
    if (playerPos) this._playerPos.copy(playerPos);

    // --- Flicker pass ---
    for (const lamp of this.lamps) {
      if (lamp.dead) continue;
      const n = Math.sin(t * 7.3 + lamp.seed) * 0.5 + Math.sin(t * 23.7 + lamp.seed * 2.1) * 0.25;
      let i = lamp.base * (1 + n * lamp.flicker);
      if (lamp.broken && Math.random() < 0.012) {
        i *= Math.random() < 0.5 ? 0 : 1.6;
      }
      lamp.light.intensity = Math.max(0, i);
      lamp.bulb.material.color.setScalar(0.4 + Math.min(1, i / lamp.base) * 0.6);
    }

    // --- Proximity shadow activation (every frame is fine for <100 lamps) ---
    this._updateShadowProximity();
  }

  /** Enable shadow casting only on the N closest eligible lamps */
  _updateShadowProximity() {
    const px = this._playerPos.x;
    const py = this._playerPos.y;
    const pz = this._playerPos.z;

    // Compute squared distance for each eligible lamp
    const eligible = [];
    for (const lamp of this.lamps) {
      if (lamp.dead || !lamp.wantShadow) {
        lamp.light.castShadow = false;
        continue;
      }
      const lp = lamp.light.position;
      lamp._distSq = (lp.x - px) ** 2 + (lp.y - py) ** 2 + (lp.z - pz) ** 2;
      eligible.push(lamp);
    }

    // Sort by distance (ascending), enable shadow on closest N
    eligible.sort((a, b) => a._distSq - b._distSq);
    for (let i = 0; i < eligible.length; i++) {
      eligible[i].light.castShadow = i < MAX_SHADOW_LAMPS;
    }
  }

  /** Permanently kill a lamp (used by Blind Frequency events) */
  killLamp(lamp) {
    lamp.dead = true;
    lamp.light.intensity = 0;
    lamp.light.castShadow = false;
    lamp.bulb.visible = false;
  }
}

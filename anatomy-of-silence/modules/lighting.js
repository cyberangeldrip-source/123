/* =========================================================
 * lighting.js
 * Ambient + flickering lamp helpers. Kept lightweight: no
 * shadow maps (PS1 vibe). Lamps register themselves so the
 * main loop can update flicker each frame.
 * ========================================================= */

import * as THREE from 'three';

export class LightingSystem {
  constructor(scene) {
    this.scene = scene;
    this.lamps = [];

    // Slightly raised ambient — corners shouldn't be pure black, but still oppressive.
    // -10% overall: ambient 0.35 -> 0.315, hemisphere 0.22 -> 0.198
    this.ambient = new THREE.AmbientLight(0x1a2028, 0.315);
    this.scene.add(this.ambient);

    // Cold "moon" hemisphere — readability without breaking horror tone
    this.hemi = new THREE.HemisphereLight(0x223040, 0x080606, 0.198);
    this.scene.add(this.hemi);
  }

  /**
   * Add a flickering point lamp.
   * @param {THREE.Vector3} pos
   * @param {{color?: number, intensity?: number, distance?: number,
   *          flicker?: number, broken?: boolean, red?: boolean}} opts
   */
  addLamp(pos, opts = {}) {
    const color     = opts.color    ?? (opts.red ? 0xb30000 : 0xffd9a0);
    // Slightly toned down vs first pass — corridors are dim, not bright.
    // Caller-supplied intensity also gets the global -10% darkness scale below.
    const baseIntensity = opts.intensity ?? (opts.red ? 1.6 : 1.3);
    const intensity = baseIntensity * 0.9;     // -10% overall darkness pass
    const distance  = opts.distance  ?? (opts.red ? 7.0 : 8.0);
    const flicker   = opts.flicker   ?? 0.18;

    const light = new THREE.PointLight(color, intensity, distance, 2.0);
    light.position.copy(pos);
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
    };
    this.lamps.push(lamp);
    return lamp;
  }

  update(t) {
    for (const lamp of this.lamps) {
      if (lamp.dead) continue;
      // smooth low-frequency noise + occasional dropouts
      const n = Math.sin(t * 7.3 + lamp.seed) * 0.5 + Math.sin(t * 23.7 + lamp.seed * 2.1) * 0.25;
      let i = lamp.base * (1 + n * lamp.flicker);
      if (lamp.broken && Math.random() < 0.012) {
        i *= Math.random() < 0.5 ? 0 : 1.6; // hard glitch
      }
      lamp.light.intensity = Math.max(0, i);
      lamp.bulb.material.color.setScalar(0.4 + Math.min(1, i / lamp.base) * 0.6);
    }
  }

  /** Permanently kill a lamp (used by Blind Frequency events) */
  killLamp(lamp) {
    lamp.dead = true;
    lamp.light.intensity = 0;
    lamp.bulb.visible = false;
  }
}

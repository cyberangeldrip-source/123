/* =========================================================
 * interaction.js
 * Raycast-based "look at + press E" interaction. Tests
 * pickups, doors, and final-tape choice. Triggers (subtitles,
 * narrative beats) are zone-based and handled separately by
 * the trigger system in game.js (not raycast).
 * ========================================================= */

import * as THREE from 'three';

const RAY_DIST = 2.4;

export class InteractionSystem {
  /**
   * @param {THREE.Camera} camera
   * @param {{pickups: Array, doors: Array}} levelData
   */
  constructor(camera, levelData) {
    this.camera = camera;
    this.pickups = levelData.pickups;
    this.doors = levelData.doors;
    this._ray = new THREE.Raycaster();
    this._origin = new THREE.Vector3();
    this._dir = new THREE.Vector3();
  }

  /** Find target under crosshair: returns {kind:'pickup'|'door', ref, label} or null. */
  pick() {
    this.camera.getWorldPosition(this._origin);
    this.camera.getWorldDirection(this._dir);

    let best = null;
    let bestDist = RAY_DIST;

    // pickups (line-segment proximity to ray)
    for (const p of this.pickups) {
      if (p.taken) continue;
      const v = p.mesh.position.clone().sub(this._origin);
      const along = v.dot(this._dir);
      if (along < 0 || along > bestDist) continue;
      const closest = this._origin.clone().add(this._dir.clone().multiplyScalar(along));
      const d = closest.distanceTo(p.mesh.position);
      if (d < 0.5 && along < bestDist) {
        bestDist = along;
        best = { kind: 'pickup', ref: p, label: p.label };
      }
    }

    // doors
    for (const d of this.doors) {
      const v = d.worldPos.clone().sub(this._origin);
      const along = v.dot(this._dir);
      if (along < 0 || along > bestDist) continue;
      const closest = this._origin.clone().add(this._dir.clone().multiplyScalar(along));
      const dd = closest.distanceTo(d.worldPos);
      if (dd < 0.9 && along < bestDist) {
        bestDist = along;
        const label = d.locked ? 'ЗАПЕРТО' : (d.open ? 'ЗАКРЫТЬ' : 'ОТКРЫТЬ');
        best = { kind: 'door', ref: d, label };
      }
    }
    return best;
  }
}

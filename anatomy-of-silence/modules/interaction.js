/* =========================================================
 * interaction.js
 * Raycast-based "look at + press E" interaction.
 * Handles pickups, doors, and wall-mounted notes.
 * ========================================================= */

import * as THREE from 'three';

const RAY_DIST = 2.4;

export class InteractionSystem {
  constructor(camera, levelData) {
    this.camera = camera;
    this.pickups = levelData.pickups;
    this.doors = levelData.doors;
    this.notes = levelData.notes || [];
    this._origin = new THREE.Vector3();
    this._dir = new THREE.Vector3();
  }

  /** Find target under crosshair: returns {kind, ref, label} or null. */
  pick() {
    this.camera.getWorldPosition(this._origin);
    this.camera.getWorldDirection(this._dir);

    let best = null;
    let bestDist = RAY_DIST;

    // pickups
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

    // notes
    for (const n of this.notes) {
      const v = n.worldPos.clone().sub(this._origin);
      const along = v.dot(this._dir);
      if (along < 0 || along > bestDist) continue;
      const closest = this._origin.clone().add(this._dir.clone().multiplyScalar(along));
      const dd = closest.distanceTo(n.worldPos);
      if (dd < 0.5 && along < bestDist) {
        bestDist = along;
        best = { kind: 'note', ref: n, label: 'ПРОЧИТАТЬ' };
      }
    }
    return best;
  }
}

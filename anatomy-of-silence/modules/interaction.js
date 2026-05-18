/* =========================================================
 * interaction.js
 * Raycast-based "look at + press E" interaction.
 * Handles pickups, doors, key-locked doors, hatches, notes,
 * and dropped recorder lures.
 * ========================================================= */

import * as THREE from 'three';
import { RU, t } from './i18n.js';

const RAY_DIST = 2.4;

export class InteractionSystem {
  constructor(camera, levelData) {
    this.camera = camera;
    this.pickups = levelData.pickups;
    this.doors = levelData.doors;
    this.hatches = levelData.hatches || [];
    this.notes = levelData.notes || [];
    this.recorder = null;
    this.inventory = null;
    this._origin = new THREE.Vector3();
    this._dir = new THREE.Vector3();
  }

  /** Wire the recorder so dropped-recorder lures become interactable. */
  setRecorder(recorder) {
    this.recorder = recorder;
  }

  /** Wire the inventory so we can render contextual labels for keyed doors. */
  setInventory(inventory) {
    this.inventory = inventory;
  }

  /** Build a label for a door, taking into account locked/key state. */
  _doorLabel(d) {
    if (d.open) return RU.prompt_close || 'ЗАКРЫТЬ';
    if (d.locked) {
      // Permanently locked door (no key in game)
      if (!d.requiredKey) return RU.prompt_locked || 'ЗАПЕРТО';
      // Key-locked door: show key name if we don't have it
      if (this.inventory?.hasKey(d.requiredKey)) {
        return RU.prompt_open || 'ОТКРЫТЬ';   // we have the key — just open
      }
      // Keyed but key not in inventory
      const keyName = this._keyDisplayName(d.requiredKey);
      return t('door_needs_key', keyName);
    }
    return RU.prompt_open || 'ОТКРЫТЬ';
  }

  _hatchLabel(h) {
    if (h.requiredKey && !this.inventory?.hasKey(h.requiredKey)) {
      return RU.hatch_locked || 'ЛЮК ЗАПЕРТ';
    }
    return h.label || (h.direction === 'down' ? 'СПУСТИТЬСЯ' : 'ПОДНЯТЬСЯ');
  }

  _keyDisplayName(keyId) {
    if (keyId === 'key_basement') return RU.item_dispatcher_key;
    if (keyId === 'key_storage')  return RU.item_storage_key;
    return RU.pick_key || 'ключ';
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
        best = { kind: 'door', ref: d, label: this._doorLabel(d) };
      }
    }

    // hatches (horizontal floor panels — slightly larger interaction radius)
    for (const h of this.hatches) {
      const v = h.worldPos.clone().sub(this._origin);
      const along = v.dot(this._dir);
      if (along < 0 || along > bestDist) continue;
      const closest = this._origin.clone().add(this._dir.clone().multiplyScalar(along));
      const dd = closest.distanceTo(h.worldPos);
      // Hatches sit on floor — players look down at them, so allow ~1.0m radius
      if (dd < 1.0 && along < bestDist) {
        bestDist = along;
        best = { kind: 'hatch', ref: h, label: this._hatchLabel(h) };
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

    // dropped recorder lures
    if (this.recorder) {
      for (const lure of this.recorder.lures) {
        const v = lure.mesh.position.clone().sub(this._origin);
        const along = v.dot(this._dir);
        if (along < 0 || along > bestDist) continue;
        const closest = this._origin.clone().add(this._dir.clone().multiplyScalar(along));
        const dd = closest.distanceTo(lure.mesh.position);
        if (dd < 0.6 && along < bestDist) {
          bestDist = along;
          best = { kind: 'lure', ref: lure, label: 'ПОДОБРАТЬ ДИКТОФОН' };
        }
      }
    }
    return best;
  }
}

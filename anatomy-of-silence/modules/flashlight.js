/* =========================================================
 * flashlight.js
 * Spotlight that follows the camera, with battery, low-power
 * flicker, hum sound, and noise emission. Toggled with F.
 * ========================================================= */

import * as THREE from 'three';

export class Flashlight {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   * @param {AudioSystem} audio
   */
  constructor(scene, camera, audio) {
    this.scene = scene;
    this.camera = camera;
    this.audio = audio;

    this.spot = new THREE.SpotLight(0xfff1c4, 0.0, 18, Math.PI * 0.18, 0.45, 1.4);
    this.spot.position.set(0, 0, 0);
    this.target = new THREE.Object3D();
    this.scene.add(this.spot);
    this.scene.add(this.target);
    this.spot.target = this.target;

    this.on = false;
    this.owned = false;            // becomes true after pickup
    this.battery = 100;            // 0..100
    this.drainPerSec = 1.4;        // empties in ~70 seconds of use
    this._humHandle = null;
    this._flickerSeed = Math.random() * 100;
    this._humPosition = new THREE.Vector3();
  }

  pickUp() {
    this.owned = true;
  }

  toggle() {
    if (!this.owned || this.battery <= 0) return false;
    this.on = !this.on;
    if (this.on && !this._humHandle) {
      this._humHandle = this.audio?.startHum(() => this._humPosition);
    } else if (!this.on && this._humHandle) {
      this._humHandle.stop(); this._humHandle = null;
    }
    return this.on;
  }

  addBattery(amount = 60) {
    this.battery = Math.min(100, this.battery + amount);
  }

  /** Update each frame */
  update(dt, t, noise) {
    // position the light and target to camera
    const camPos = new THREE.Vector3();
    const camDir = new THREE.Vector3();
    this.camera.getWorldPosition(camPos);
    this.camera.getWorldDirection(camDir);

    // offset slightly down-right (handheld feel)
    const right = new THREE.Vector3().crossVectors(camDir, new THREE.Vector3(0, 1, 0)).normalize();
    const offset = right.multiplyScalar(0.15).add(new THREE.Vector3(0, -0.12, 0));
    this.spot.position.copy(camPos).add(offset);
    this.target.position.copy(camPos).add(camDir.multiplyScalar(8));
    this._humPosition.copy(camPos);

    if (!this.on) {
      this.spot.intensity += (0 - this.spot.intensity) * Math.min(1, dt * 8);
      return;
    }

    // drain battery
    this.battery = Math.max(0, this.battery - this.drainPerSec * dt);
    if (this.battery <= 0) {
      this.on = false;
      this._humHandle?.stop(); this._humHandle = null;
      return;
    }

    // base intensity 1.6, low-power flicker when battery < 30
    let target = 1.6;
    const lowBat = this.battery / 30;
    if (lowBat < 1) {
      const f = Math.sin(t * 18 + this._flickerSeed) * 0.5 + 0.5;
      target *= 0.4 + f * 0.6 * lowBat;
      // occasional dropouts
      if (Math.random() < 0.02 * (1 - lowBat)) target *= Math.random() < 0.5 ? 0 : 1.2;
    }
    this.spot.intensity += (target - this.spot.intensity) * Math.min(1, dt * 12);

    // hum becomes more prominent when low
    this._humHandle?.setIntensity?.(0.6 + (1 - Math.min(1, this.battery / 100)) * 1.2);

    // Flashlight emits faint noise (5) — counts as a beacon for AI
    if (noise && Math.random() < 1.5 * dt) {
      noise.noiseFromHum(camPos);
    }
  }
}

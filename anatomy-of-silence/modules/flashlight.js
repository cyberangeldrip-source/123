/* =========================================================
 * flashlight.js
 * Spotlight that follows the camera, with battery, low-power
 * flicker, hum sound, noise emission, and shadow casting.
 * Toggled with F.
 * ========================================================= */

import * as THREE from 'three';

export class Flashlight {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   * @param {AudioSystem} audio
   * @param {{shadowMapSize?: number}} opts
   */
  constructor(scene, camera, audio, opts = {}) {
    this.scene = scene;
    this.camera = camera;
    this.audio = audio;

    const shadowMapSize = opts.shadowMapSize || 1024;

    // SpotLight with shadow support — warm sodium-tinted bulb, soft cone
    this.spot = new THREE.SpotLight(0xffe0a8, 0.0, 22, Math.PI * 0.22, 0.7, 1.6);
    this.spot.position.set(0, 0, 0);
    this.target = new THREE.Object3D();
    this.scene.add(this.spot);
    this.scene.add(this.target);
    this.spot.target = this.target;

    // ----- Volumetric beam cone (atmosphere) ----------------------------
    // A semi-transparent cone mesh that follows the spotlight, rendered
    // with additive blending and an inverted-normal shader-like falloff
    // via vertex colors. Sells "dusty air catches the beam" without an
    // actual volumetric pass.
    const coneLen = 8;
    const coneRadius = 1.85;
    const coneGeo = new THREE.ConeGeometry(coneRadius, coneLen, 24, 1, true);
    // Vertex colors: tip is brightest, base fades out
    const colorAttr = new Float32Array(coneGeo.attributes.position.count * 3);
    const posAttr = coneGeo.attributes.position;
    for (let i = 0; i < posAttr.count; i++) {
      // ConeGeometry orientation: apex at +y, base at -y (with default before
      // we rotate). We'll rotate later so apex faces forward.
      const y = posAttr.getY(i);
      // y goes from -coneLen/2 (base) to +coneLen/2 (apex). Brighten near apex.
      const t = (y + coneLen / 2) / coneLen; // 0 at base, 1 at apex
      const a = Math.pow(t, 1.6); // soft falloff
      colorAttr[i * 3 + 0] = a;
      colorAttr[i * 3 + 1] = a;
      colorAttr[i * 3 + 2] = a;
    }
    coneGeo.setAttribute('color', new THREE.BufferAttribute(colorAttr, 3));
    coneGeo.translate(0, -coneLen / 2, 0); // move apex to origin
    coneGeo.rotateX(-Math.PI / 2); // apex pointing along +z (forward)

    const coneMat = new THREE.MeshBasicMaterial({
      color: 0xffe0a8,
      transparent: true,
      opacity: 0.0, // controlled per-frame
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      vertexColors: true,
      fog: true,
    });
    this.volumeCone = new THREE.Mesh(coneGeo, coneMat);
    this.volumeCone.renderOrder = 999;
    this.scene.add(this.volumeCone);

    // ===== SHADOWS =====
    this.spot.castShadow = true;
    this.spot.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    this.spot.shadow.camera.near = 0.3;
    this.spot.shadow.camera.far = 22;
    this.spot.shadow.camera.fov = 50;
    this.spot.shadow.bias = -0.001;
    this.spot.shadow.normalBias = 0.04;
    this.spot.shadow.radius = 5; // genuinely soft penumbra

    this.on = false;
    this.owned = false;
    this.battery = 100;
    this.drainPerSec = 0.84 * 1.40;
    this._humHandle = null;
    this._flickerSeed = Math.random() * 100;
    this._humPosition = new THREE.Vector3();

    // ----- 3D viewmodel: a flashlight in the player's hand -----
    this.viewmodel = new THREE.Group();
    this.viewmodel.visible = false;

    // Body — dark metal cylinder
    const bodyMat = new THREE.MeshLambertMaterial({ color: 0x2a2620 });
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.038, 0.034, 0.18, 12),
      bodyMat,
    );
    body.rotation.x = Math.PI / 2;
    this.viewmodel.add(body);

    // Head bezel — slightly wider, rusted brass
    const bezelMat = new THREE.MeshLambertMaterial({ color: 0x453a2c });
    const bezel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.052, 0.044, 0.05, 12),
      bezelMat,
    );
    bezel.rotation.x = Math.PI / 2;
    bezel.position.z = -0.115;
    this.viewmodel.add(bezel);

    // Lens (emissive disc, brightens when light is on)
    const lensMat = new THREE.MeshBasicMaterial({ color: 0x332817 });
    const lens = new THREE.Mesh(
      new THREE.CircleGeometry(0.042, 16),
      lensMat,
    );
    lens.position.z = -0.141;
    lens.rotation.y = Math.PI;
    this.viewmodel.add(lens);
    this._lens = lens;
    this._lensMat = lensMat;

    // Switch (small ring)
    const switchMat = new THREE.MeshLambertMaterial({ color: 0x111111 });
    const swt = new THREE.Mesh(
      new THREE.TorusGeometry(0.035, 0.006, 6, 16),
      switchMat,
    );
    swt.position.z = 0.0;
    swt.rotation.y = Math.PI / 2;
    this.viewmodel.add(swt);

    // Position the whole viewmodel: lower-right of FOV, angled slightly inward
    this.viewmodel.position.set(0.22, -0.18, -0.35);
    this.viewmodel.rotation.set(-0.05, -0.1, 0);

    // Attach to camera so it tracks head movement
    this.camera.add(this.viewmodel);

    this._bobBaseY = -0.18;
    this._bobBaseX = 0.22;
  }

  pickUp() {
    this.owned = true;
    this.viewmodel.visible = true;
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

  reload() {
    if (!this.owned) return false;
    if (this.battery >= 99.5) return false;
    this.battery = 100;
    return true;
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

    // Keep cone glued to the spotlight, pointing where the light points.
    if (this.volumeCone) {
      this.volumeCone.position.copy(this.spot.position);
      // Forward direction: from spotlight to target
      const fwd = new THREE.Vector3().subVectors(this.target.position, this.spot.position).normalize();
      this.volumeCone.lookAt(this.volumeCone.position.clone().add(fwd));
    }

    // Subtle handheld sway for the viewmodel
    if (this.viewmodel.visible) {
      const sway = Math.sin(t * 1.6) * 0.004;
      const sway2 = Math.cos(t * 2.1) * 0.003;
      this.viewmodel.position.x = this._bobBaseX + sway2;
      this.viewmodel.position.y = this._bobBaseY + sway;
    }

    if (!this.on) {
      this.spot.intensity += (0 - this.spot.intensity) * Math.min(1, dt * 8);
      this._lensMat.color.setRGB(0.20, 0.16, 0.10);
      if (this.volumeCone) {
        this.volumeCone.material.opacity += (0 - this.volumeCone.material.opacity) * Math.min(1, dt * 8);
      }
      // Disable shadow when light is off (saves GPU)
      this.spot.castShadow = false;
      return;
    }

    // Enable shadow when flashlight is on
    this.spot.castShadow = true;

    // drain battery
    this.battery = Math.max(0, this.battery - this.drainPerSec * dt);
    if (this.battery <= 0) {
      this.on = false;
      this._humHandle?.stop(); this._humHandle = null;
      return;
    }

    let target = 2.8;
    const lowBat = this.battery / 30;
    if (lowBat < 1) {
      const f = Math.sin(t * 18 + this._flickerSeed) * 0.5 + 0.5;
      target *= 0.4 + f * 0.6 * lowBat;
      if (Math.random() < 0.02 * (1 - lowBat)) target *= Math.random() < 0.5 ? 0 : 1.2;
    }
    this.spot.intensity += (target - this.spot.intensity) * Math.min(1, dt * 12);

    // Volumetric cone tracks the beam intensity for a subtle haze effect.
    if (this.volumeCone) {
      const targetOpacity = 0.10 * Math.min(1, this.spot.intensity / 2.8);
      this.volumeCone.material.opacity += (targetOpacity - this.volumeCone.material.opacity) * Math.min(1, dt * 6);
    }

    // Lens glows proportionally to current spot intensity
    const lensBright = Math.min(1, this.spot.intensity / 2.8);
    this._lensMat.color.setRGB(
      0.20 + 0.80 * lensBright,
      0.16 + 0.78 * lensBright,
      0.10 + 0.45 * lensBright,
    );

    // hum becomes more prominent when low
    this._humHandle?.setIntensity?.(0.6 + (1 - Math.min(1, this.battery / 100)) * 1.2);

    // Flashlight emits faint noise (5) — counts as a beacon for AI
    if (noise && Math.random() < 1.5 * dt) {
      noise.noiseFromHum(camPos);
    }
  }
}

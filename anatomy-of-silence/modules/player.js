/* =========================================================
 * player.js
 * First-person controller with:
 *   - WASD movement, sprint (shift NOT used here — shift is calm),
 *     ctrl crouch, mouse look (PointerLockControls)
 *   - Capsule vs Octree collision (Three.js addon)
 *   - Gravity, grounded check, head-bob, smooth accel/decel
 *   - Calming mode (Shift hold) — controlled externally, here we
 *     just expose .calming and slow the player
 * ========================================================= */

import * as THREE from 'three';
import { Octree } from 'three/addons/math/Octree.js';
import { Capsule } from 'three/addons/math/Capsule.js';

const STAND_HEIGHT  = 1.7;
const CROUCH_HEIGHT = 1.05;
const RADIUS        = 0.32;
const GRAVITY       = 24;
const JUMP_VELOCITY = 7.5;

export class Player {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {HTMLElement} domElement   element to capture pointer lock from
   */
  constructor(camera, domElement) {
    this.camera = camera;
    this.domElement = domElement;

    // Yaw/pitch we manage ourselves (so we keep camera offset under control)
    this.yawObject   = new THREE.Object3D();
    this.pitchObject = new THREE.Object3D();
    this.pitchObject.add(camera);
    this.yawObject.add(this.pitchObject);

    this.yawObject.position.set(0, 0, 0); // feet position
    this.eyeHeight = STAND_HEIGHT;
    camera.position.set(0, 0, 0);

    // Capsule: bottom + top + radius (feet → eye-ish)
    this.collider = new Capsule(
      new THREE.Vector3(0, RADIUS, 0),
      new THREE.Vector3(0, STAND_HEIGHT - RADIUS, 0),
      RADIUS
    );

    this.octree = new Octree();

    this.velocity = new THREE.Vector3();
    this.input = { forward: 0, right: 0, jump: false, sprint: false, crouch: false };
    this.onGround = false;

    // Tunables
    this.walkSpeed   = 3.6;
    this.sprintSpeed = 6.6;
    this.crouchSpeed = 1.6;
    this.calmSpeed   = 1.2;
    this.acceleration = 14;     // higher = snappier
    this.airControl   = 0.35;

    // External flags (set by stress / calming modules)
    this.calming = false;       // shift held
    this.locked  = false;       // pointer locked

    // Head-bob state
    this._bobT = 0;
    this._bobAmp = 0;

    // Mouse look
    this.sensitivity = 0.002;
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onPointerLockChange = this._onPointerLockChange.bind(this);
    document.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('pointerlockchange', this._onPointerLockChange);
  }

  // ---- public API ----

  setLevelOctree(rootObject) {
    this.octree = new Octree();
    this.octree.fromGraphNode(rootObject);
  }

  teleport(x, y, z, yaw = 0) {
    this.collider.start.set(x, y + RADIUS, z);
    this.collider.end.set(x, y + STAND_HEIGHT - RADIUS, z);
    this.collider.radius = RADIUS;
    this.velocity.set(0, 0, 0);
    this.yawObject.rotation.y = yaw;
    this.pitchObject.rotation.x = 0;
  }

  requestPointerLock() {
    this.domElement.requestPointerLock?.();
  }

  /** True world position (head/eye) */
  getEyePosition(out = new THREE.Vector3()) {
    out.copy(this.collider.end); // top of capsule ~ eye height
    return out;
  }

  /** Forward direction (xz plane) */
  getForward(out = new THREE.Vector3()) {
    out.set(0, 0, -1).applyQuaternion(this.yawObject.quaternion);
    return out;
  }

  /** Speed magnitude in xz plane (used for footsteps/noise) */
  getHorizontalSpeed() {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  /** What the player is "doing" — drives noise system */
  getMovementState() {
    const speed = this.getHorizontalSpeed();
    if (speed < 0.2)         return 'idle';
    if (this.input.crouch)   return 'crouch';
    if (this.input.sprint)   return 'sprint';
    if (this.calming)        return 'calm';
    return 'walk';
  }

  setInput(state) {
    Object.assign(this.input, state);
  }

  // ---- update ----

  update(dt) {
    this._handleHorizontalMovement(dt);
    this._applyGravity(dt);
    this._integrate(dt);
    this._updateHeadBob(dt);
    this._syncObjectToCollider();
  }

  // ---- internals ----

  _handleHorizontalMovement(dt) {
    // Build wish-direction in local yaw space
    const wish = new THREE.Vector3(this.input.right, 0, -this.input.forward);
    if (wish.lengthSq() > 1e-4) wish.normalize();
    wish.applyQuaternion(this.yawObject.quaternion);

    let targetSpeed = this.walkSpeed;
    if (this.input.crouch)      targetSpeed = this.crouchSpeed;
    else if (this.input.sprint) targetSpeed = this.sprintSpeed;
    if (this.calming)           targetSpeed = Math.min(targetSpeed, this.calmSpeed);

    // Crouch transition (smooth)
    const targetEye = this.input.crouch ? CROUCH_HEIGHT : STAND_HEIGHT;
    this.eyeHeight += (targetEye - this.eyeHeight) * Math.min(1, dt * 8);
    // Adjust capsule top accordingly
    this.collider.end.y = this.collider.start.y + (this.eyeHeight - RADIUS);

    const wishVel = wish.multiplyScalar(targetSpeed);

    // Accelerate horizontal velocity toward wish
    const accel = this.onGround ? this.acceleration : this.acceleration * this.airControl;
    const dvx = (wishVel.x - this.velocity.x) * Math.min(1, accel * dt);
    const dvz = (wishVel.z - this.velocity.z) * Math.min(1, accel * dt);
    this.velocity.x += dvx;
    this.velocity.z += dvz;

    // Friction when no input on ground
    if (this.onGround && wish.lengthSq() < 1e-4) {
      const damping = Math.exp(-12 * dt);
      this.velocity.x *= damping;
      this.velocity.z *= damping;
    }

    // Jump (kept for physics correctness; not bound to a key, but supports pickups)
    if (this.input.jump && this.onGround) {
      this.velocity.y = JUMP_VELOCITY;
      this.onGround = false;
    }
  }

  _applyGravity(dt) {
    if (!this.onGround) this.velocity.y -= GRAVITY * dt;
    else if (this.velocity.y < 0) this.velocity.y = 0;
  }

  _integrate(dt) {
    // translate capsule
    const delta = new THREE.Vector3().copy(this.velocity).multiplyScalar(dt);
    this.collider.translate(delta);

    // resolve against world geometry
    const result = this.octree.capsuleIntersect(this.collider);
    this.onGround = false;
    if (result) {
      this.onGround = result.normal.y > 0.35;
      // Push capsule out of geometry by penetration depth
      this.collider.translate(result.normal.multiplyScalar(result.depth));

      // Cancel velocity along the contact normal (wall-slide / floor-stop)
      if (!this.onGround) {
        const into = this.velocity.dot(result.normal);
        if (into < 0) this.velocity.addScaledVector(result.normal, -into);
      } else {
        if (this.velocity.y < 0) this.velocity.y = 0;
      }
    }

    // Floor safety net (in case octree is missing geometry)
    if (this.collider.start.y < -10) {
      this.collider.start.set(0, RADIUS, 0);
      this.collider.end.set(0, STAND_HEIGHT - RADIUS, 0);
      this.velocity.set(0, 0, 0);
    }
  }

  _updateHeadBob(dt) {
    const speed = this.getHorizontalSpeed();
    const targetAmp = this.onGround
      ? Math.min(speed / this.sprintSpeed, 1) * (this.input.crouch ? 0.02 : 0.04)
      : 0;
    this._bobAmp += (targetAmp - this._bobAmp) * Math.min(1, dt * 6);
    this._bobT  += dt * (this.input.sprint ? 12 : 8);
    const bobY = Math.sin(this._bobT) * this._bobAmp;
    const bobX = Math.cos(this._bobT * 0.5) * this._bobAmp * 0.5;
    this.camera.position.set(bobX, bobY, 0);
  }

  _syncObjectToCollider() {
    // yawObject sits on the floor under the capsule, with its Y at feet
    this.yawObject.position.set(
      this.collider.start.x,
      this.collider.end.y, // eye y in world
      this.collider.start.z
    );
  }

  _onMouseMove(e) {
    if (!this.locked) return;
    this.yawObject.rotation.y   -= e.movementX * this.sensitivity;
    this.pitchObject.rotation.x -= e.movementY * this.sensitivity;
    const PI2 = Math.PI / 2 - 0.001;
    this.pitchObject.rotation.x = Math.max(-PI2, Math.min(PI2, this.pitchObject.rotation.x));
  }

  _onPointerLockChange() {
    this.locked = document.pointerLockElement === this.domElement;
  }
}

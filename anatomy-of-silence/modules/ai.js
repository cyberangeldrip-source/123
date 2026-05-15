/* =========================================================
 * ai.js
 * Two enemy types, both blind, both react to noise events:
 *
 *  WEEPER  — slow blind humanoid. States:
 *    idle → alerted (turn toward sound) → inhale → SCREAM
 *    (sonic scream stuns player, summons Horcror, raises stress).
 *    Crying loop always plays at 3D position so player can hear them.
 *
 *  HORCROR (Blind Frequency) — invisible-ish entity rendered as a
 *    rippling air distortion. Patrols in silence; when noise heard,
 *    accelerates rapidly, hunts, performs an acoustic jumpscare on
 *    contact (deals heavy stress; if stress reaches 100, game over).
 *
 *  AI subscribes to NoiseSystem.listen(); each event provides
 *  intensity + position. Hearing radius scales with intensity.
 *  Memory timer keeps them searching after silence.
 * ========================================================= */

import * as THREE from 'three';

// =============================================================
//  Helpers
// =============================================================
function distance2D(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

// Walk along a flat plane, avoiding walls via the player's octree.
// We do not need full pathing — direct steering w/ obstacle slide is enough
// for the linear corridor-and-rooms layout.
function steerTowards(actor, target, speed, dt, octree) {
  const dx = target.x - actor.position.x;
  const dz = target.z - actor.position.z;
  const len = Math.hypot(dx, dz) || 1;
  const dirX = dx / len;
  const dirZ = dz / len;

  // tentative step
  const stepX = dirX * speed * dt;
  const stepZ = dirZ * speed * dt;

  // Use ray-like sphere for lazy collision
  const cap = new THREE.Sphere(
    new THREE.Vector3(actor.position.x + stepX, actor.position.y + 0.6, actor.position.z + stepZ),
    0.35
  );
  const hit = octree?.sphereIntersect(cap);
  if (hit) {
    // try sliding along normal
    const slideX = stepX + hit.normal.x * hit.depth;
    const slideZ = stepZ + hit.normal.z * hit.depth;
    actor.position.x += slideX;
    actor.position.z += slideZ;
  } else {
    actor.position.x += stepX;
    actor.position.z += stepZ;
  }

  // face direction of motion
  if (Math.abs(dx) + Math.abs(dz) > 0.01) {
    const targetYaw = Math.atan2(dx, dz);
    let cur = actor.rotation.y;
    let diff = ((targetYaw - cur + Math.PI) % (Math.PI * 2)) - Math.PI;
    actor.rotation.y += diff * Math.min(1, dt * 6);
  }
}

// =============================================================
//  WEEPER
// =============================================================
const WEEPER_STATES = { IDLE: 'idle', ALERTED: 'alerted', INHALE: 'inhale', SCREAM: 'scream', SEARCH: 'search' };

class Weeper {
  constructor(scene, audio, pos) {
    this.scene = scene;
    this.audio = audio;

    // visuals — gaunt humanoid (boxes for PS1 vibe)
    const grp = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.18, 1.2, 6),
      new THREE.MeshLambertMaterial({ color: 0x4a4036 })
    );
    body.position.y = 0.95;
    grp.add(body);
    const head = new THREE.Mesh(
      new THREE.BoxGeometry(0.32, 0.32, 0.32),
      new THREE.MeshLambertMaterial({ color: 0xd9c8a8 })
    );
    head.position.y = 1.7;
    grp.add(head);
    // sunken eye sockets (dark patches via small spheres)
    for (const s of [-0.08, 0.08]) {
      const eye = new THREE.Mesh(
        new THREE.SphereGeometry(0.04, 6, 6),
        new THREE.MeshBasicMaterial({ color: 0x000000 })
      );
      eye.position.set(s, 1.74, 0.18);
      grp.add(eye);
    }
    // gangly arms
    for (const s of [-0.3, 0.3]) {
      const arm = new THREE.Mesh(
        new THREE.CylinderGeometry(0.05, 0.05, 1.0, 5),
        new THREE.MeshLambertMaterial({ color: 0x5a4a3e })
      );
      arm.position.set(s, 1.0, 0);
      grp.add(arm);
    }
    grp.position.copy(pos);
    grp.position.y = 0;
    scene.add(grp);
    this.group = grp;

    this.state = WEEPER_STATES.IDLE;
    this.target = new THREE.Vector3();
    this.memoryTimer = 0;        // search duration after losing trail
    this.stateTimer = 0;
    this.scream = { triggered: false };
    this.speed = 1.2;             // slow

    // crying loop (3D)
    this.cryHandle = audio?.startWeeperCry(() => this.group.position);
    this.cryHandle?.setVolume?.(0.05);
  }

  hear(event) {
    // hearing scales with intensity (60 base ~= 12m); if noise reaches us, react
    const audible = event.intensity * 0.18; // intensity 80 -> 14.4m
    const d = distance2D(this.group.position, event.pos);
    if (d > audible) return;

    this.target.copy(event.pos);
    if (this.state === WEEPER_STATES.IDLE || this.state === WEEPER_STATES.SEARCH) {
      this.state = WEEPER_STATES.ALERTED;
      this.stateTimer = 0;
    }
    this.memoryTimer = 6.0; // remember for 6s
  }

  update(dt, octree, player, noise, stress, onScream) {
    this.stateTimer += dt;
    this.memoryTimer = Math.max(0, this.memoryTimer - dt);

    // crying loop volume scales with proximity and excitement
    const dPlayer = distance2D(this.group.position, player.collider.start);
    const cryVol = Math.max(0.04, Math.min(0.18, 0.3 / (dPlayer + 0.5)));
    this.cryHandle?.setVolume?.(cryVol);
    this.cryHandle?._update?.();

    switch (this.state) {
      case WEEPER_STATES.IDLE: {
        // slow drift
        if (this.stateTimer > 4) {
          this.target.set(
            this.group.position.x + (Math.random() - 0.5) * 4,
            0,
            this.group.position.z + (Math.random() - 0.5) * 4
          );
          this.stateTimer = 0;
        }
        steerTowards(this.group, this.target, this.speed * 0.4, dt, octree);
        break;
      }
      case WEEPER_STATES.ALERTED: {
        // turn toward sound, walk a bit, then inhale
        steerTowards(this.group, this.target, this.speed, dt, octree);
        if (this.stateTimer > 1.4 || distance2D(this.group.position, this.target) < 1.2) {
          this.state = WEEPER_STATES.INHALE;
          this.stateTimer = 0;
        }
        break;
      }
      case WEEPER_STATES.INHALE: {
        // pause, deep breath, then scream
        if (this.stateTimer > 1.0) {
          this.state = WEEPER_STATES.SCREAM;
          this.stateTimer = 0;
          this.scream.triggered = false;
        }
        break;
      }
      case WEEPER_STATES.SCREAM: {
        if (!this.scream.triggered) {
          this.scream.triggered = true;
          this.audio?.weeperScream(this.group.position);
          noise?.noiseFromScream(this.group.position);
          onScream?.(this);          // game.js will pulse engine + tinnitus + stun player
        }
        if (this.stateTimer > 1.7) {
          this.state = WEEPER_STATES.SEARCH;
          this.stateTimer = 0;
        }
        break;
      }
      case WEEPER_STATES.SEARCH: {
        if (this.memoryTimer > 0) {
          steerTowards(this.group, this.target, this.speed * 0.7, dt, octree);
        } else {
          this.state = WEEPER_STATES.IDLE;
          this.stateTimer = 0;
        }
        break;
      }
    }

    // Stress nearby Weeper
    if (dPlayer < 6) stress?.applyEnemyProximity(dPlayer, dt);
  }

  destroy() {
    this.cryHandle?.stop();
    this.scene.remove(this.group);
  }
}

// =============================================================
//  HORCROR / BLIND FREQUENCY
// =============================================================
class Horcror {
  constructor(scene, audio, pos) {
    this.scene = scene;
    this.audio = audio;

    // air-distortion: low-poly sphere with shader-ish material
    // (PS1-friendly hack: nearly transparent sphere with normal-driven tint)
    const geo = new THREE.IcosahedronGeometry(0.7, 1);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime:     { value: 0 },
        uActivity: { value: 0 }, // 0 idle, 1 hunting
      },
      vertexShader: /* glsl */`
        uniform float uTime;
        uniform float uActivity;
        varying float vFres;
        varying vec3 vN;
        void main() {
          vec3 p = position;
          // ripple
          float ripple = sin(uTime * 6.0 + position.y * 8.0) * 0.05
                       + cos(uTime * 9.0 + position.x * 7.0) * 0.04;
          p += normal * ripple * (0.5 + uActivity);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vN = normalize(normalMatrix * normal);
          vFres = pow(1.0 - abs(vN.z), 2.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        varying float vFres;
        uniform float uActivity;
        void main() {
          vec3 col = mix(vec3(0.05, 0.06, 0.08), vec3(0.6, 0.1, 0.1), uActivity * vFres);
          float a = vFres * (0.18 + uActivity * 0.45);
          gl_FragColor = vec4(col, a);
        }
      `,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.position.copy(pos);
    this.mesh.position.y = 1.4;
    scene.add(this.mesh);

    this.state = 'patrol';        // 'patrol' | 'hunt' | 'attack' | 'sleep'
    this.target = new THREE.Vector3().copy(pos);
    this.memoryTimer = 0;
    this.attackCooldown = 0;
    this.activity = 0;            // visual intensity 0..1
    this.speedPatrol = 0.6;
    this.speedHunt   = 4.0;
    this.huntDelay   = 0;
  }

  hear(event) {
    // Horcror reacts to anything ≥ 25 intensity within ~30 m
    if (event.intensity < 25) return;
    const d = distance2D(this.mesh.position, event.pos);
    if (d > Math.min(40, event.intensity * 0.4)) return;
    this.target.copy(event.pos);
    this.memoryTimer = 5.0;
    if (this.state !== 'attack') {
      this.state = 'hunt';
      this.huntDelay = 0.4;        // small windup
    }
  }

  update(dt, octree, player, stress, onAttack) {
    this.mesh.material.uniforms.uTime.value += dt;
    this.memoryTimer = Math.max(0, this.memoryTimer - dt);
    this.attackCooldown = Math.max(0, this.attackCooldown - dt);
    this.huntDelay = Math.max(0, this.huntDelay - dt);

    const dPlayer = distance2D(this.mesh.position, player.collider.start);

    // proximity scares the player even if not hunting
    if (dPlayer < 5) stress?.applyEnemyProximity(dPlayer, dt);

    switch (this.state) {
      case 'patrol': {
        steerTowards(this.mesh, this.target, this.speedPatrol, dt, octree);
        if (distance2D(this.mesh.position, this.target) < 0.5) {
          this.target.set(
            this.mesh.position.x + (Math.random() - 0.5) * 14,
            0,
            this.mesh.position.z + (Math.random() - 0.5) * 14
          );
        }
        this.activity += (0.0 - this.activity) * Math.min(1, dt * 1.5);
        break;
      }
      case 'hunt': {
        if (this.huntDelay > 0) break;
        steerTowards(this.mesh, this.target, this.speedHunt, dt, octree);
        this.activity += (1.0 - this.activity) * Math.min(1, dt * 3);
        if (dPlayer < 1.4 && this.attackCooldown <= 0) {
          this.state = 'attack';
          this.attackCooldown = 4.0;
        }
        if (this.memoryTimer <= 0 && distance2D(this.mesh.position, this.target) < 0.8) {
          this.state = 'patrol';
        }
        break;
      }
      case 'attack': {
        // acoustic jumpscare; deals heavy stress
        onAttack?.(this);
        stress?.applyLoudSound(80);
        // shove player away slightly (cheap knockback by displacing capsule)
        const back = new THREE.Vector3(
          player.collider.start.x - this.mesh.position.x, 0,
          player.collider.start.z - this.mesh.position.z
        ).normalize().multiplyScalar(1.4);
        player.collider.translate(back);
        this.state = 'hunt';
        this.huntDelay = 1.2;
        break;
      }
    }

    this.mesh.material.uniforms.uActivity.value = this.activity;
    // float bob
    this.mesh.position.y = 1.4 + Math.sin(this.mesh.material.uniforms.uTime.value * 1.6) * 0.1;
  }

  destroy() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

// =============================================================
//  AI MANAGER
// =============================================================
export class AIManager {
  constructor(scene, audio, noise) {
    this.scene = scene;
    this.audio = audio;
    this.noise = noise;

    this.weepers = [];
    this.horcror = null;
    this.octree = null;

    this._lastNoiseAt = 0;
    this._silenceTimer = 0;

    // subscribe to noise events
    noise.listen((ev) => this._onNoise(ev));

    this.callbacks = {
      onWeeperScream: null,    // (weeper) => void
      onHorcrorAttack: null,   // (horcror) => void
    };
  }

  setOctree(octree) { this.octree = octree; }

  spawnWeepers(positions) {
    for (const p of positions) this.weepers.push(new Weeper(this.scene, this.audio, p));
  }

  spawnHorcror(pos) {
    this.horcror = new Horcror(this.scene, this.audio, pos);
  }

  _onNoise(event) {
    this._lastNoiseAt = performance.now();
    for (const w of this.weepers) w.hear(event);
    this.horcror?.hear(event);
  }

  update(dt, player, stress) {
    for (const w of this.weepers) {
      w.update(dt, this.octree, player, this.noise, stress,
        (weeper) => this.callbacks.onWeeperScream?.(weeper)
      );
    }
    this.horcror?.update(dt, this.octree, player, stress,
      (h) => this.callbacks.onHorcrorAttack?.(h)
    );
  }

  /** Closest enemy distance (used for HUD subtle danger cue) */
  closestEnemyDistance(point) {
    let best = Infinity;
    for (const w of this.weepers) {
      best = Math.min(best, distance2D(w.group.position, point));
    }
    if (this.horcror) best = Math.min(best, distance2D(this.horcror.mesh.position, point));
    return best;
  }

  destroyAll() {
    for (const w of this.weepers) w.destroy();
    this.weepers.length = 0;
    this.horcror?.destroy(); this.horcror = null;
  }
}

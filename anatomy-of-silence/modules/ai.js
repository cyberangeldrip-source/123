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

    // ---- visuals: tall, emaciated, wrong proportions ----
    const grp = new THREE.Group();

    // emaciated torso: tall thin cylinder, dark dirty cloth
    const torso = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.14, 1.4, 7),
      new THREE.MeshLambertMaterial({ color: 0x352c25 })
    );
    torso.position.y = 1.1;
    grp.add(torso);

    // shoulders (extra bulk so the silhouette reads humanoid)
    const shoulders = new THREE.Mesh(
      new THREE.BoxGeometry(0.55, 0.18, 0.28),
      new THREE.MeshLambertMaterial({ color: 0x2c2520 })
    );
    shoulders.position.y = 1.7;
    grp.add(shoulders);

    // pale stretched skull — slightly elongated, tilted forward
    const head = new THREE.Mesh(
      new THREE.BoxGeometry(0.30, 0.42, 0.28),
      new THREE.MeshLambertMaterial({ color: 0xc9b89a, emissive: 0x1a0a0a, emissiveIntensity: 0.3 })
    );
    head.position.set(0, 2.0, 0.04);
    head.rotation.x = 0.18; // slight head-droop
    grp.add(head);

    // gaping black eye sockets (hollow rectangles, deep)
    for (const s of [-0.07, 0.07]) {
      const socket = new THREE.Mesh(
        new THREE.BoxGeometry(0.08, 0.10, 0.04),
        new THREE.MeshBasicMaterial({ color: 0x000000 })
      );
      socket.position.set(s, 2.04, 0.20);
      grp.add(socket);
    }
    // wet-cheek streaks (thin red strips below eyes — "tears of blood")
    for (const s of [-0.07, 0.07]) {
      const tear = new THREE.Mesh(
        new THREE.BoxGeometry(0.015, 0.20, 0.01),
        new THREE.MeshBasicMaterial({ color: 0x3a0606 })
      );
      tear.position.set(s, 1.85, 0.20);
      grp.add(tear);
    }
    // wide gaping mouth (dark slit)
    const mouth = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 0.08, 0.03),
      new THREE.MeshBasicMaterial({ color: 0x000000 })
    );
    mouth.position.set(0, 1.82, 0.21);
    grp.add(mouth);
    this._mouth = mouth;

    // long emaciated arms hanging below the knees, slightly swaying
    this._arms = [];
    for (const s of [-0.28, 0.28]) {
      const armGrp = new THREE.Group();
      armGrp.position.set(s, 1.65, 0);
      const upper = new THREE.Mesh(
        new THREE.CylinderGeometry(0.04, 0.035, 0.8, 5),
        new THREE.MeshLambertMaterial({ color: 0x4a3d33 })
      );
      upper.position.y = -0.4;
      armGrp.add(upper);
      const fore = new THREE.Mesh(
        new THREE.CylinderGeometry(0.035, 0.025, 0.7, 5),
        new THREE.MeshLambertMaterial({ color: 0x4a3d33 })
      );
      fore.position.y = -1.1;
      armGrp.add(fore);
      // claw-like hand
      const hand = new THREE.Mesh(
        new THREE.BoxGeometry(0.10, 0.14, 0.08),
        new THREE.MeshLambertMaterial({ color: 0xa89a7c })
      );
      hand.position.y = -1.55;
      armGrp.add(hand);
      grp.add(armGrp);
      this._arms.push(armGrp);
    }

    // dragging legs (visible below torso)
    for (const s of [-0.10, 0.10]) {
      const leg = new THREE.Mesh(
        new THREE.CylinderGeometry(0.07, 0.05, 0.9, 6),
        new THREE.MeshLambertMaterial({ color: 0x261f18 })
      );
      leg.position.set(s, 0.45, 0);
      grp.add(leg);
    }

    grp.position.copy(pos);
    grp.position.y = 0;
    scene.add(grp);
    this.group = grp;

    this.state = WEEPER_STATES.IDLE;
    this.target = new THREE.Vector3();
    this.memoryTimer = 0;
    this.stateTimer = 0;
    this.scream = { triggered: false };
    this.speed = 1.2;

    // crying loop (3D)
    this.cryHandle = audio?.startWeeperCry(() => this.group.position);
    this.cryHandle?.setVolume?.(0.05);

    this._swayPhase = Math.random() * Math.PI * 2;
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

    // ----- subtle idle/walk animation -----
    this._swayPhase += dt * (this.state === WEEPER_STATES.IDLE ? 0.7 : 1.6);
    const sway = Math.sin(this._swayPhase) * 0.18;
    if (this._arms[0]) this._arms[0].rotation.x = -0.05 + sway;
    if (this._arms[1]) this._arms[1].rotation.x = -0.05 - sway;
    // mouth widens during inhale/scream
    let mouthScale = 1.0;
    if (this.state === WEEPER_STATES.INHALE) mouthScale = 1.0 + Math.min(1, this.stateTimer) * 1.4;
    else if (this.state === WEEPER_STATES.SCREAM) mouthScale = 2.6;
    if (this._mouth) this._mouth.scale.set(1, mouthScale, 1);

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

    // ---- main rippling sphere (the "frequency" body) ----
    const geo = new THREE.IcosahedronGeometry(0.8, 2);
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
          float ripple = sin(uTime * 6.0 + position.y * 8.0) * 0.07
                       + cos(uTime * 9.0 + position.x * 7.0) * 0.05
                       + sin(uTime * 13.0 + position.z * 5.0) * 0.04;
          p += normal * ripple * (0.6 + uActivity * 1.4);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vN = normalize(normalMatrix * normal);
          vFres = pow(1.0 - abs(vN.z), 2.5);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        varying float vFres;
        uniform float uActivity;
        void main() {
          // dark blood-red core, screaming-red edges when hunting
          vec3 col = mix(vec3(0.02, 0.02, 0.04), vec3(0.8, 0.05, 0.05), uActivity * vFres);
          float a = vFres * (0.32 + uActivity * 0.55);
          gl_FragColor = vec4(col, a);
        }
      `,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.position.copy(pos);
    this.mesh.position.y = 1.4;
    scene.add(this.mesh);

    // ---- inner silhouette: a humanoid shape that ONLY shows when activity > 0 ----
    const innerGrp = new THREE.Group();
    const tor = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.06, 1.0, 6),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.0 })
    );
    tor.position.y = -0.3;
    innerGrp.add(tor); this._inner = [tor];
    const innerHead = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 0.22, 0.18),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.0 })
    );
    innerHead.position.y = 0.32;
    innerGrp.add(innerHead); this._inner.push(innerHead);
    // tendrils (thin tall boxes hanging down)
    for (const s of [-0.25, -0.1, 0.1, 0.25]) {
      const tendril = new THREE.Mesh(
        new THREE.BoxGeometry(0.04, 0.7, 0.04),
        new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.0 })
      );
      tendril.position.set(s, -0.55, 0);
      innerGrp.add(tendril);
      this._inner.push(tendril);
    }
    this.mesh.add(innerGrp);
    this._innerGrp = innerGrp;

    // ---- red point light on the entity (cheap "menace glow") ----
    this._glow = new THREE.PointLight(0xff2020, 0.0, 6, 2);
    this.mesh.add(this._glow);

    this.state = 'patrol';
    this.target = new THREE.Vector3().copy(pos);
    this.memoryTimer = 0;
    this.attackCooldown = 0;
    this.activity = 0;
    this.speedPatrol = 0.6;
    this.speedHunt   = 4.0;
    this.huntDelay   = 0;
  }

  hear(event) {
    // Horcror reacts to anything ≥ 15 intensity within a generous radius
    if (event.intensity < 15) return;
    const d = distance2D(this.mesh.position, event.pos);
    // hearing radius scales with intensity: sprint(60) -> 42m, walk(10) -> 7m
    if (d > Math.min(50, event.intensity * 0.7)) return;
    this.target.copy(event.pos);
    this.memoryTimer = 6.0;
    if (this.state !== 'attack') {
      this.state = 'hunt';
      this.huntDelay = 0.3;        // small windup
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

    // reveal inner silhouette + glow proportional to activity
    const innerOpacity = Math.min(1, this.activity * 1.4);
    for (const part of this._inner) {
      if (part.material) part.material.opacity = innerOpacity;
    }
    this._glow.intensity = this.activity * 1.5;
    // jitter the silhouette when hunting
    if (this._innerGrp) {
      this._innerGrp.position.x = (Math.random() - 0.5) * 0.05 * this.activity;
      this._innerGrp.position.z = (Math.random() - 0.5) * 0.05 * this.activity;
    }
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

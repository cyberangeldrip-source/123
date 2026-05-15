/* =========================================================
 * ai.js
 * Two enemy types, both blind, both react to noise events.
 * Includes waypoint-based pathfinding and patrol behavior.
 * ========================================================= */

import * as THREE from 'three';

// =============================================================
//  Helpers
// =============================================================
function distance2D(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

// =============================================================
//  Simple waypoint pathfinding
// =============================================================
class NavGraph {
  constructor(points) {
    this.points = points || [];
    this.edges = []; // adjacency: edges[i] = [indices reachable from i]
    this._buildEdges();
  }

  _buildEdges() {
    const MAX_EDGE_DIST = 8; // max distance between connected nav points
    this.edges = this.points.map(() => []);
    for (let i = 0; i < this.points.length; i++) {
      for (let j = i + 1; j < this.points.length; j++) {
        const d = distance2D(this.points[i], this.points[j]);
        if (d < MAX_EDGE_DIST) {
          this.edges[i].push(j);
          this.edges[j].push(i);
        }
      }
    }
  }

  /** Find nearest nav point to a world position */
  nearest(pos) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < this.points.length; i++) {
      const d = distance2D(pos, this.points[i]);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /** BFS shortest path from start index to end index, returns array of points */
  findPath(startIdx, endIdx) {
    if (startIdx === endIdx) return [this.points[endIdx]];
    const visited = new Set([startIdx]);
    const queue = [[startIdx]];
    while (queue.length > 0) {
      const path = queue.shift();
      const node = path[path.length - 1];
      for (const neighbor of this.edges[node]) {
        if (neighbor === endIdx) {
          const result = [...path, neighbor];
          return result.map(i => this.points[i]);
        }
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push([...path, neighbor]);
        }
      }
    }
    // No path found - go direct
    return [this.points[endIdx]];
  }

  /** Get a random nav point index */
  randomPoint() {
    return Math.floor(Math.random() * this.points.length);
  }
}

// =============================================================
//  Steering with collision avoidance
// =============================================================
function steerTowards(actor, target, speed, dt, octree) {
  const dx = target.x - actor.position.x;
  const dz = target.z - actor.position.z;
  const len = Math.hypot(dx, dz) || 1;
  const dirX = dx / len;
  const dirZ = dz / len;

  const stepX = dirX * speed * dt;
  const stepZ = dirZ * speed * dt;

  const cap = new THREE.Sphere(
    new THREE.Vector3(actor.position.x + stepX, actor.position.y + 0.6, actor.position.z + stepZ),
    0.35
  );
  const hit = octree?.sphereIntersect(cap);
  if (hit) {
    const slideX = stepX + hit.normal.x * hit.depth;
    const slideZ = stepZ + hit.normal.z * hit.depth;
    actor.position.x += slideX;
    actor.position.z += slideZ;
  } else {
    actor.position.x += stepX;
    actor.position.z += stepZ;
  }

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
const WEEPER_STATES = { IDLE: 'idle', ALERTED: 'alerted', INHALE: 'inhale', SCREAM: 'scream', SEARCH: 'search', PATROL: 'patrol' };

class Weeper {
  constructor(scene, audio, pos, navGraph) {
    this.scene = scene;
    this.audio = audio;
    this.navGraph = navGraph;
    this.spawnPos = pos.clone();

    const grp = new THREE.Group();

    const torso = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.14, 1.4, 7),
      new THREE.MeshLambertMaterial({ color: 0x352c25 })
    );
    torso.position.y = 1.1;
    grp.add(torso);

    const shoulders = new THREE.Mesh(
      new THREE.BoxGeometry(0.55, 0.18, 0.28),
      new THREE.MeshLambertMaterial({ color: 0x2c2520 })
    );
    shoulders.position.y = 1.7;
    grp.add(shoulders);

    const head = new THREE.Mesh(
      new THREE.BoxGeometry(0.30, 0.42, 0.28),
      new THREE.MeshLambertMaterial({ color: 0xc9b89a, emissive: 0x1a0a0a, emissiveIntensity: 0.3 })
    );
    head.position.set(0, 2.0, 0.04);
    head.rotation.x = 0.18;
    grp.add(head);

    for (const s of [-0.07, 0.07]) {
      const socket = new THREE.Mesh(
        new THREE.BoxGeometry(0.08, 0.10, 0.04),
        new THREE.MeshBasicMaterial({ color: 0x000000 })
      );
      socket.position.set(s, 2.04, 0.20);
      grp.add(socket);
    }
    for (const s of [-0.07, 0.07]) {
      const tear = new THREE.Mesh(
        new THREE.BoxGeometry(0.015, 0.20, 0.01),
        new THREE.MeshBasicMaterial({ color: 0x3a0606 })
      );
      tear.position.set(s, 1.85, 0.20);
      grp.add(tear);
    }
    const mouth = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 0.08, 0.03),
      new THREE.MeshBasicMaterial({ color: 0x000000 })
    );
    mouth.position.set(0, 1.82, 0.21);
    grp.add(mouth);
    this._mouth = mouth;

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
      const hand = new THREE.Mesh(
        new THREE.BoxGeometry(0.10, 0.14, 0.08),
        new THREE.MeshLambertMaterial({ color: 0xa89a7c })
      );
      hand.position.y = -1.55;
      armGrp.add(hand);
      grp.add(armGrp);
      this._arms.push(armGrp);
    }

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

    this.state = WEEPER_STATES.PATROL;
    this.target = new THREE.Vector3();
    this.memoryTimer = 0;
    this.stateTimer = 0;
    this.scream = { triggered: false };
    this.speed = 0.9; // reduced 25% from 1.2

    // Patrol state
    this._patrolPath = [];
    this._patrolIdx = 0;
    this._patrolWait = 0;
    this._pickNewPatrolTarget();

    this.cryHandle = audio?.startWeeperCry(() => this.group.position);
    this.cryHandle?.setVolume?.(0.05);

    this._swayPhase = Math.random() * Math.PI * 2;
  }

  _pickNewPatrolTarget() {
    if (!this.navGraph || this.navGraph.points.length === 0) return;
    const startIdx = this.navGraph.nearest(this.group.position);
    const endIdx = this.navGraph.randomPoint();
    this._patrolPath = this.navGraph.findPath(startIdx, endIdx);
    this._patrolIdx = 0;
  }

  hear(event) {
    // Distance-based hearing: further away = less likely to hear
    const d = distance2D(this.group.position, event.pos);
    const maxHearDist = event.intensity * 0.25; // intensity 60 -> 15m
    if (d > maxHearDist) return;

    // Probability decreases with distance
    const hearChance = Math.max(0, 1 - (d / maxHearDist) * 0.7);
    if (Math.random() > hearChance) return;

    // Use pathfinding to reach the sound source
    if (this.navGraph) {
      const startIdx = this.navGraph.nearest(this.group.position);
      const endIdx = this.navGraph.nearest(event.pos);
      this._patrolPath = this.navGraph.findPath(startIdx, endIdx);
      this._patrolIdx = 0;
    }
    this.target.copy(event.pos);
    if (this.state === WEEPER_STATES.IDLE || this.state === WEEPER_STATES.PATROL || this.state === WEEPER_STATES.SEARCH) {
      this.state = WEEPER_STATES.ALERTED;
      this.stateTimer = 0;
    }
    this.memoryTimer = 6.0;
  }

  update(dt, octree, player, noise, stress, onScream) {
    this.stateTimer += dt;
    this.memoryTimer = Math.max(0, this.memoryTimer - dt);

    this._swayPhase += dt * (this.state === WEEPER_STATES.PATROL ? 0.7 : 1.6);
    const sway = Math.sin(this._swayPhase) * 0.18;
    if (this._arms[0]) this._arms[0].rotation.x = -0.05 + sway;
    if (this._arms[1]) this._arms[1].rotation.x = -0.05 - sway;

    let mouthScale = 1.0;
    if (this.state === WEEPER_STATES.INHALE) mouthScale = 1.0 + Math.min(1, this.stateTimer) * 1.4;
    else if (this.state === WEEPER_STATES.SCREAM) mouthScale = 2.6;
    if (this._mouth) this._mouth.scale.set(1, mouthScale, 1);

    const dPlayer = distance2D(this.group.position, player.collider.start);
    const cryVol = Math.max(0.04, Math.min(0.18, 0.3 / (dPlayer + 0.5)));
    this.cryHandle?.setVolume?.(cryVol);
    this.cryHandle?._update?.();

    switch (this.state) {
      case WEEPER_STATES.IDLE: {
        // Transition to patrol after brief pause
        if (this.stateTimer > 2) {
          this.state = WEEPER_STATES.PATROL;
          this.stateTimer = 0;
          this._pickNewPatrolTarget();
        }
        break;
      }
      case WEEPER_STATES.PATROL: {
        // Follow patrol path
        if (this._patrolPath.length > 0 && this._patrolIdx < this._patrolPath.length) {
          const waypoint = this._patrolPath[this._patrolIdx];
          steerTowards(this.group, waypoint, this.speed * 0.4, dt, octree);
          if (distance2D(this.group.position, waypoint) < 1.0) {
            this._patrolIdx++;
            if (this._patrolIdx >= this._patrolPath.length) {
              // Reached end of path, wait then pick new target
              this._patrolWait += dt;
              if (this._patrolWait > 3 + Math.random() * 4) {
                this._patrolWait = 0;
                this._pickNewPatrolTarget();
              }
            }
          }
        } else {
          this._pickNewPatrolTarget();
        }
        break;
      }
      case WEEPER_STATES.ALERTED: {
        // Follow path to sound source
        if (this._patrolPath.length > 0 && this._patrolIdx < this._patrolPath.length) {
          const waypoint = this._patrolPath[this._patrolIdx];
          steerTowards(this.group, waypoint, this.speed, dt, octree);
          if (distance2D(this.group.position, waypoint) < 1.0) {
            this._patrolIdx++;
          }
        } else {
          steerTowards(this.group, this.target, this.speed, dt, octree);
        }
        if (this.stateTimer > 2.0 || distance2D(this.group.position, this.target) < 1.5) {
          this.state = WEEPER_STATES.INHALE;
          this.stateTimer = 0;
        }
        break;
      }
      case WEEPER_STATES.INHALE: {
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
          onScream?.(this);
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
          this.state = WEEPER_STATES.PATROL;
          this.stateTimer = 0;
          this._pickNewPatrolTarget();
        }
        break;
      }
    }

    if (dPlayer < 6) stress?.applyEnemyProximity(dPlayer, dt);
  }

  reset() {
    this.group.position.copy(this.spawnPos);
    this.group.position.y = 0;
    this.state = WEEPER_STATES.PATROL;
    this.stateTimer = 0;
    this.memoryTimer = 0;
    this._pickNewPatrolTarget();
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
  constructor(scene, audio, pos, navGraph) {
    this.scene = scene;
    this.audio = audio;
    this.navGraph = navGraph;
    this.spawnPos = pos.clone();

    const geo = new THREE.IcosahedronGeometry(0.8, 2);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime:     { value: 0 },
        uActivity: { value: 0 },
      },
      vertexShader: `
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
          vFres = pow(1.0 - abs(vN.z), 2.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        varying float vFres;
        uniform float uActivity;
        void main() {
          // Brighter base color so the entity is always visible
          vec3 idleCol = vec3(0.20, 0.05, 0.08);
          vec3 huntCol = vec3(1.0, 0.10, 0.15);
          vec3 col = mix(idleCol, huntCol, uActivity);
          // Stronger fresnel + base glow for visibility
          float a = 0.55 + vFres * (0.35 + uActivity * 0.55);
          gl_FragColor = vec4(col + vFres * 0.3, a);
        }
      `,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.position.copy(pos);
    this.mesh.position.y = 1.4;
    scene.add(this.mesh);

    // Inner silhouette — always somewhat visible (not fully transparent in idle)
    const innerGrp = new THREE.Group();
    const tor = new THREE.Mesh(
      new THREE.CylinderGeometry(0.14, 0.08, 1.1, 6),
      new THREE.MeshBasicMaterial({ color: 0x2a0808, transparent: true, opacity: 0.5 })
    );
    tor.position.y = -0.3;
    innerGrp.add(tor); this._inner = [tor];
    const innerHead = new THREE.Mesh(
      new THREE.BoxGeometry(0.22, 0.26, 0.22),
      new THREE.MeshBasicMaterial({ color: 0x1a0404, transparent: true, opacity: 0.6 })
    );
    innerHead.position.y = 0.36;
    innerGrp.add(innerHead); this._inner.push(innerHead);
    for (const s of [-0.28, -0.1, 0.1, 0.28]) {
      const tendril = new THREE.Mesh(
        new THREE.BoxGeometry(0.05, 0.7, 0.05),
        new THREE.MeshBasicMaterial({ color: 0x150202, transparent: true, opacity: 0.5 })
      );
      tendril.position.set(s, -0.6, 0);
      innerGrp.add(tendril);
      this._inner.push(tendril);
    }
    this.mesh.add(innerGrp);
    this._innerGrp = innerGrp;

    // Always-on red glow (not just when hunting)
    this._glow = new THREE.PointLight(0xff2a2a, 0.6, 5, 2);
    this.mesh.add(this._glow);

    this.state = 'patrol';
    this.target = new THREE.Vector3().copy(pos);
    this.lastHeardAt = -Infinity;
    this.memoryTimer = 0;
    this.attackCooldown = 0;
    this.activity = 0;
    this.speedPatrol = 0.45;
    this.speedHunt   = 3.0;
    this.huntDelay   = 0;

    // Patrol with pathfinding
    this._patrolPath = [];
    this._patrolIdx = 0;
    this._patrolWait = 0;
    this._pickNewPatrolTarget();
  }

  _pickNewPatrolTarget() {
    if (!this.navGraph || this.navGraph.points.length === 0) return;
    const startIdx = this.navGraph.nearest(this.mesh.position);
    const endIdx = this.navGraph.randomPoint();
    this._patrolPath = this.navGraph.findPath(startIdx, endIdx);
    this._patrolIdx = 0;
  }

  /** Line-of-sight check: returns true if no wall between A and B (in xz plane). */
  _hasLOS(octree, a, b) {
    if (!octree) return true;
    const from = new THREE.Vector3(a.x, 1.4, a.z);
    const dir = new THREE.Vector3(b.x - a.x, 0, b.z - a.z);
    const dist = dir.length();
    if (dist < 0.01) return true;
    dir.normalize();
    // Use octree.rayIntersect (Three.js Octree addon supports this)
    const ray = new THREE.Ray(from, dir);
    const hit = octree.rayIntersect ? octree.rayIntersect(ray) : null;
    if (!hit) return true;
    return hit.distance >= dist;
  }

  /** Noise event handler. Probability of "hearing" scales with distance + intensity. */
  hear(event) {
    // Reaction threshold: anything ≥ 20 (covers walking=30, running=60, jumping=65)
    if (event.intensity < 20) return;

    const d = distance2D(this.mesh.position, event.pos);
    // Hearing range: linear with intensity. walk(30)=12m, sprint(60)=24m, scream(100)=40m
    const maxHearDist = Math.min(40, event.intensity * 0.4);
    if (d > maxHearDist) return;

    // Probability falls off with distance (linear). At max distance ~10% chance.
    const hearChance = Math.max(0.1, 1 - (d / maxHearDist) * 0.85);
    if (Math.random() > hearChance) return;

    // Re-path toward sound source
    if (this.navGraph) {
      const startIdx = this.navGraph.nearest(this.mesh.position);
      const endIdx = this.navGraph.nearest(event.pos);
      this._patrolPath = this.navGraph.findPath(startIdx, endIdx);
      this._patrolIdx = 0;
    }
    this.target.copy(event.pos);
    this.lastHeardAt = performance.now();
    this.memoryTimer = 4.0;  // forget after 4 seconds of silence

    if (this.state !== 'attack') {
      this.state = 'hunt';
      this.huntDelay = 0.3;
    }
  }

  update(dt, octree, player, stress, onAttack) {
    this.mesh.material.uniforms.uTime.value += dt;
    this.memoryTimer = Math.max(0, this.memoryTimer - dt);
    this.attackCooldown = Math.max(0, this.attackCooldown - dt);
    this.huntDelay = Math.max(0, this.huntDelay - dt);

    const dPlayer = distance2D(this.mesh.position, player.collider.start);
    const hasLOS = this._hasLOS(octree, this.mesh.position, player.collider.start);

    // Proximity stress ONLY when in line of sight (no through-wall fear)
    if (dPlayer < 4 && hasLOS) {
      stress?.applyEnemyProximity(dPlayer, dt);
    }

    switch (this.state) {
      case 'patrol': {
        if (this._patrolPath.length > 0 && this._patrolIdx < this._patrolPath.length) {
          const waypoint = this._patrolPath[this._patrolIdx];
          steerTowards(this.mesh, waypoint, this.speedPatrol, dt, octree);
          if (distance2D(this.mesh.position, waypoint) < 1.0) {
            this._patrolIdx++;
            if (this._patrolIdx >= this._patrolPath.length) {
              this._patrolWait += dt;
              if (this._patrolWait > 2 + Math.random() * 4) {
                this._patrolWait = 0;
                this._pickNewPatrolTarget();
              }
            }
          }
        } else {
          this._pickNewPatrolTarget();
        }
        this.activity += (0.0 - this.activity) * Math.min(1, dt * 1.5);
        break;
      }

      case 'hunt': {
        if (this.huntDelay > 0) break;

        // Lost the trail — return to patrol
        if (this.memoryTimer <= 0) {
          this.state = 'search';
          this._patrolWait = 0;
          break;
        }

        // Follow path to target
        if (this._patrolPath.length > 0 && this._patrolIdx < this._patrolPath.length) {
          const waypoint = this._patrolPath[this._patrolIdx];
          steerTowards(this.mesh, waypoint, this.speedHunt, dt, octree);
          if (distance2D(this.mesh.position, waypoint) < 1.0) {
            this._patrolIdx++;
          }
        } else {
          steerTowards(this.mesh, this.target, this.speedHunt, dt, octree);
        }

        this.activity += (1.0 - this.activity) * Math.min(1, dt * 3);

        // ATTACK only when truly close AND has line of sight
        if (dPlayer < 1.5 && hasLOS && this.attackCooldown <= 0) {
          this.state = 'attack';
          this.attackCooldown = 4.0;
        }
        break;
      }

      case 'search': {
        // Wander around last heard position for a few seconds, then give up
        this._patrolWait += dt;
        if (this._patrolPath.length === 0 || this._patrolIdx >= this._patrolPath.length) {
          // Pick a random nearby point near last target
          const angle = Math.random() * Math.PI * 2;
          const radius = 2 + Math.random() * 3;
          const wanderPt = new THREE.Vector3(
            this.target.x + Math.cos(angle) * radius,
            0,
            this.target.z + Math.sin(angle) * radius,
          );
          if (this.navGraph) {
            const startIdx = this.navGraph.nearest(this.mesh.position);
            const endIdx = this.navGraph.nearest(wanderPt);
            this._patrolPath = this.navGraph.findPath(startIdx, endIdx);
            this._patrolIdx = 0;
          }
        } else {
          const waypoint = this._patrolPath[this._patrolIdx];
          steerTowards(this.mesh, waypoint, this.speedPatrol * 1.5, dt, octree);
          if (distance2D(this.mesh.position, waypoint) < 1.0) {
            this._patrolIdx++;
          }
        }

        this.activity += (0.4 - this.activity) * Math.min(1, dt * 2);

        // If a new noise comes in during search, hear() will switch state back to hunt.
        // After ~6 sec of fruitless searching, return to patrol.
        if (this._patrolWait > 6) {
          this.state = 'patrol';
          this._patrolWait = 0;
          this._pickNewPatrolTarget();
        }
        break;
      }

      case 'attack': {
        // Final LOS + range check before applying damage
        if (dPlayer < 2.0 && hasLOS) {
          onAttack?.(this);
          stress?.applyLoudSound(40);
          const back = new THREE.Vector3(
            player.collider.start.x - this.mesh.position.x, 0,
            player.collider.start.z - this.mesh.position.z
          ).normalize().multiplyScalar(1.4);
          player.collider.translate(back);
        }
        this.state = 'hunt';
        this.huntDelay = 1.5;
        break;
      }
    }

    this.mesh.material.uniforms.uActivity.value = this.activity;
    this.mesh.position.y = 1.4 + Math.sin(this.mesh.material.uniforms.uTime.value * 1.6) * 0.1;

    // Inner silhouette opacity scales but never fully transparent
    const baseOp = 0.45;
    const huntOp = 1.0;
    const op = baseOp + (huntOp - baseOp) * this.activity;
    for (const part of this._inner) {
      if (part.material) part.material.opacity = op;
    }
    this._glow.intensity = 0.6 + this.activity * 1.2;
    if (this._innerGrp) {
      this._innerGrp.position.x = (Math.random() - 0.5) * 0.06 * this.activity;
      this._innerGrp.position.z = (Math.random() - 0.5) * 0.06 * this.activity;
    }
  }

  reset() {
    this.mesh.position.copy(this.spawnPos);
    this.mesh.position.y = 1.4;
    this.state = 'patrol';
    this.activity = 0;
    this.memoryTimer = 0;
    this.attackCooldown = 0;
    this._patrolWait = 0;
    this._pickNewPatrolTarget();
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
    this.navGraph = null;

    this.weepers = [];
    this.horcror = null;
    this.octree = null;

    this._lastNoiseAt = 0;
    this._silenceTimer = 0;

    noise.listen((ev) => this._onNoise(ev));

    this.callbacks = {
      onWeeperScream: null,
      onHorcrorAttack: null,
    };
  }

  setOctree(octree) { this.octree = octree; }

  setNavPoints(points) {
    this.navGraph = new NavGraph(points);
  }

  spawnWeepers(positions) {
    for (const p of positions) this.weepers.push(new Weeper(this.scene, this.audio, p, this.navGraph));
  }

  spawnHorcror(pos) {
    this.horcror = new Horcror(this.scene, this.audio, pos, this.navGraph);
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

  closestEnemyDistance(point) {
    let best = Infinity;
    for (const w of this.weepers) {
      best = Math.min(best, distance2D(w.group.position, point));
    }
    if (this.horcror) best = Math.min(best, distance2D(this.horcror.mesh.position, point));
    return best;
  }

  /** Reset all enemies to spawn positions and idle state */
  resetAll() {
    for (const w of this.weepers) w.reset();
    this.horcror?.reset();
  }

  destroyAll() {
    for (const w of this.weepers) w.destroy();
    this.weepers.length = 0;
    this.horcror?.destroy(); this.horcror = null;
  }
}

/* =========================================================
 * ai.js
 * Two enemy types, both blind, both react to noise events.
 * Includes waypoint-based pathfinding and patrol behavior.
 * ========================================================= */

import * as THREE from 'three';

// =============================================================
//  Helpers
// =============================================================

// Module-private scratch THREE.Vector3 instances used inside the per-frame
// hot path (hasLOS2D / steerTowards) to avoid the four-Vector3-per-AI-per-
// frame allocation churn the previous implementation paid for. NOT thread-
// safe / NOT re-entrant: the AI tick is single-threaded and neither helper
// calls back into itself, so it's safe to reuse the same instances every
// call.
const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();

function distance2D(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** True if A and B are on the same vertical floor (within 1.5m of each
 *  other in Y). The level uses two play floors at y≈0 (surface) and
 *  y≈-3.5 (basement), so a 1.5m tolerance unambiguously separates them
 *  while still allowing for crouch / capsule height jitter. */
function sameFloor(a, b, tol = 1.5) {
  return Math.abs((a.y || 0) - (b.y || 0)) < tol;
}

/** True if there is no wall between A and B at the given height (xz plane). */
function hasLOS2D(octree, a, b, height = 1.4, doors = null) {
  if (!octree) return true;
  const from = _v3a.set(a.x, height, a.z);
  const dir  = _v3b.set(b.x - a.x, 0, b.z - a.z);
  const dist = dir.length();
  if (dist < 0.01) return true;
  dir.normalize();
  const ray = new THREE.Ray(from, dir);
  const hit = octree.rayIntersect ? octree.rayIntersect(ray) : null;
  if (hit && hit.distance < dist) return false;
  // Also test closed doors — their blockers aren't part of the static octree
  // so we have to ray-vs-AABB them ourselves.
  if (doors && doors.length) {
    for (const d of doors) {
      if (d.open || !d.blockerBox) continue;
      const tHit = rayBoxIntersect(ray, d.blockerBox);
      if (tHit !== null && tHit < dist) return false;
    }
  }
  return true;
}

/** Slab-method ray vs AABB. Returns the entry distance if the ray enters the
 *  box within positive t, else null. Box is a THREE.Box3, ray is THREE.Ray. */
function rayBoxIntersect(ray, box) {
  const ox = ray.origin.x, oy = ray.origin.y, oz = ray.origin.z;
  const dx = ray.direction.x, dy = ray.direction.y, dz = ray.direction.z;
  let tmin = -Infinity, tmax = Infinity;
  for (const axis of ['x', 'y', 'z']) {
    const o = axis === 'x' ? ox : axis === 'y' ? oy : oz;
    const d = axis === 'x' ? dx : axis === 'y' ? dy : dz;
    const minV = box.min[axis], maxV = box.max[axis];
    if (Math.abs(d) < 1e-6) {
      if (o < minV || o > maxV) return null;
      continue;
    }
    const t1 = (minV - o) / d;
    const t2 = (maxV - o) / d;
    const tlo = Math.min(t1, t2);
    const thi = Math.max(t1, t2);
    if (tlo > tmin) tmin = tlo;
    if (thi < tmax) tmax = thi;
    if (tmin > tmax) return null;
  }
  if (tmax < 0) return null;
  return Math.max(0, tmin);
}

// =============================================================
//  Simple waypoint pathfinding
// =============================================================
class NavGraph {
  constructor(points) {
    this.points = points || [];
    this.edges = []; // adjacency: edges[i] = [indices reachable from i]
    this.octree = null;
    this.doors = null;
    // Doors are openable by the AI so we don't filter graph edges by them;
    // this set is reserved for future "really blocked" edges (locked doors,
    // hatches the AI can't operate). Currently always empty.
    this._blockedDoors = new Set();
    this._buildEdges();
  }

  /** Provide the static collision octree (and door list, kept for future
   *  use) so subsequent _buildEdges() calls can prune edges that are
   *  blocked by walls. Doors are deliberately ignored here because the
   *  Horcror opens them — pathing must thread through doorways even when
   *  the door is currently closed. */
  setBlockers(octree, doors) {
    this.octree = octree || null;
    this.doors = doors || null;
    this._buildEdges();
  }

  _buildEdges() {
    // Bumped from 8 → 12m so corridor-spanning waypoints can connect
    // directly without forcing the path through an intermediate node
    // that may not even exist between rooms.
    const MAX_EDGE_DIST = 12;
    this.edges = this.points.map(() => []);
    for (let i = 0; i < this.points.length; i++) {
      for (let j = i + 1; j < this.points.length; j++) {
        const d = distance2D(this.points[i], this.points[j]);
        if (d >= MAX_EDGE_DIST) continue;
        // Refuse edges between waypoints on different floors. distance2D
        // ignores Y, so a surface waypoint and a basement waypoint at the
        // same XZ would otherwise look adjacent and the LOS ray (cast at a
        // fixed height) would not block them. Door stitching deliberately
        // keeps surface/basement door waypoints distinct, so this guard is
        // required to prevent cross-floor pathing.
        if (!sameFloor(this.points[i], this.points[j])) continue;
        // If the octree is available, require an unobstructed line of sight
        // (ignoring doors — the AI opens them). Until setBlockers() is
        // called we fall back to proximity-only edges, which is fine for
        // the brief window between construction and setBlockers wiring.
        if (this.octree && !hasLOS2D(this.octree, this.points[i], this.points[j], 1.4, null)) {
          continue;
        }
        this.edges[i].push(j);
        this.edges[j].push(i);
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

  /** Like nearest(), but prefers a node that the actor can SEE from `pos`
   *  with closed doors counted as blockers (because the actor is currently
   *  AT pos and a closed door must be opened before it can be crossed —
   *  for the very first waypoint we want one that's already reachable
   *  without door interaction). Falls back to absolute nearest when no
   *  candidate within 8m is LOS-visible. */
  nearestReachable(pos) {
    const SEARCH_RADIUS = 8;
    let best = -1, bestD = Infinity;
    for (let i = 0; i < this.points.length; i++) {
      const d = distance2D(pos, this.points[i]);
      if (d > SEARCH_RADIUS) continue;
      if (d >= bestD) continue;
      if (!hasLOS2D(this.octree, pos, this.points[i], 1.4, this.doors)) continue;
      bestD = d;
      best = i;
    }
    if (best >= 0) return best;
    // Nothing visible — fall back to absolute nearest so the caller still
    // gets a usable index. The path may need to open a door before the
    // first hop, but that's preferable to returning -1.
    return this.nearest(pos);
  }

  /** A* shortest path from start index to end index, returns array of points.
   *  Uses 2D distance as both edge cost and heuristic (admissible since
   *  graph edges are world-space distances). The graph is small (~50 nodes
   *  even after door waypoints are stitched in) so a tiny array open list
   *  with a linear min-f scan is faster than maintaining a heap.
   *
   *  Edge cases handled: start === end → returns [points[end]]; no path
   *  found → returns [points[end]] so callers degrade to "walk straight at
   *  the goal" rather than crashing on an empty array. */
  findPath(startIdx, endIdx) {
    if (startIdx === endIdx) return [this.points[endIdx]];
    const goal = this.points[endIdx];
    const open = [startIdx];
    const closed = new Set();
    const parent = new Map();           // child -> parent index
    const gScore = new Map();           // node index -> best known g
    const fScore = new Map();           // node index -> g + h
    gScore.set(startIdx, 0);
    fScore.set(startIdx, distance2D(this.points[startIdx], goal));

    while (open.length > 0) {
      // Pick the open-list entry with the smallest f via linear scan.
      let bestPos = 0;
      let bestF = fScore.get(open[0]);
      for (let i = 1; i < open.length; i++) {
        const f = fScore.get(open[i]);
        if (f < bestF) { bestF = f; bestPos = i; }
      }
      const current = open.splice(bestPos, 1)[0];

      if (current === endIdx) {
        // Reconstruct
        const idxPath = [current];
        let p = parent.get(current);
        while (p !== undefined) {
          idxPath.push(p);
          p = parent.get(p);
        }
        idxPath.reverse();
        return idxPath.map(i => this.points[i]);
      }

      closed.add(current);
      const gCur = gScore.get(current);

      for (const neighbor of this.edges[current]) {
        if (closed.has(neighbor)) continue;
        const tentativeG = gCur + distance2D(this.points[current], this.points[neighbor]);
        const known = gScore.get(neighbor);
        if (known !== undefined && tentativeG >= known) continue;
        parent.set(neighbor, current);
        gScore.set(neighbor, tentativeG);
        fScore.set(neighbor, tentativeG + distance2D(this.points[neighbor], goal));
        if (!open.includes(neighbor)) open.push(neighbor);
      }
    }

    // No path found — degrade gracefully (caller will steer straight at
    // the goal and rely on stuck-detection to recover).
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

/** Cheap "does a sphere of given radius at (x,z,y=0..2) overlap any closed
 *  door's blocker AABB?" Returns true on first overlap. Used to keep AI
 *  from walking through closed doors now that blockers aren't in the octree. */
function spherePassesDoor(x, z, radius, doors) {
  if (!doors || !doors.length) return false;
  for (const d of doors) {
    if (d.open || !d.blockerBox) continue;
    const b = d.blockerBox;
    const cx = Math.max(b.min.x, Math.min(x, b.max.x));
    const cz = Math.max(b.min.z, Math.min(z, b.max.z));
    const dx = x - cx, dz = z - cz;
    if (dx * dx + dz * dz < radius * radius) return true;
  }
  return false;
}

/**
 * Move actor toward target. Returns the actual horizontal distance covered
 * this step so the caller can detect "stuck against a wall" situations.
 * If the straight path is blocked, tries to slide along the wall, and if
 * still blocked tries the two perpendicular directions so corners stop
 * trapping the AI.
 */
function steerTowards(actor, target, speed, dt, octree, doors = null) {
  const startX = actor.position.x;
  const startZ = actor.position.z;

  const dx = target.x - startX;
  const dz = target.z - startZ;
  const len = Math.hypot(dx, dz) || 1;
  const dirX = dx / len;
  const dirZ = dz / len;

  const stepLen = speed * dt;

  // Try a sequence of candidate directions: forward, slid, +90°, -90°.
  // The first one that produces movement is used.
  const candidates = [
    { x: dirX, z: dirZ },                     // straight to target
    { x: -dirZ, z: dirX },                    // perpendicular left
    { x:  dirZ, z: -dirX },                   // perpendicular right
  ];

  let moved = false;
  for (const c of candidates) {
    const stepX = c.x * stepLen;
    const stepZ = c.z * stepLen;
    const newX = startX + stepX;
    const newZ = startZ + stepZ;
    // Reject the candidate outright if it would pass through a closed door
    if (spherePassesDoor(newX, newZ, 0.35, doors)) continue;
    const cap = new THREE.Sphere(
      new THREE.Vector3(newX, actor.position.y + 0.6, newZ),
      0.35
    );
    const hit = octree?.sphereIntersect(cap);
    if (hit) {
      // Slide along the wall and try the slid step
      const slideX = stepX + hit.normal.x * hit.depth;
      const slideZ = stepZ + hit.normal.z * hit.depth;
      const slideMag = Math.hypot(slideX, slideZ);
      if (slideMag > stepLen * 0.05) {
        // Make sure the slid position also doesn't end up inside a door
        if (!spherePassesDoor(startX + slideX, startZ + slideZ, 0.35, doors)) {
          actor.position.x += slideX;
          actor.position.z += slideZ;
          moved = true;
          break;
        }
      }
      // Otherwise try next candidate
      continue;
    }
    actor.position.x = newX;
    actor.position.z = newZ;
    moved = true;
    break;
  }

  // Always face the target direction (visual)
  if (Math.abs(dx) + Math.abs(dz) > 0.01) {
    const targetYaw = Math.atan2(dx, dz);
    let cur = actor.rotation.y;
    let diff = ((targetYaw - cur + Math.PI) % (Math.PI * 2)) - Math.PI;
    actor.rotation.y += diff * Math.min(1, dt * 6);
  }

  // Return how much we actually moved horizontally
  const movedX = actor.position.x - startX;
  const movedZ = actor.position.z - startZ;
  return Math.hypot(movedX, movedZ);
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
    this.doors = [];

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
    this.speed = 0.9 * 1.08; // base 0.9, +8% = ≈ 0.972 m/s

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
    const d = distance2D(this.group.position, event.pos);
    // Cross-floor noise gate (mirrors Horcror logic): only loud events are
    // heard from another floor. Walking quietly on a different floor must
    // not pull a Weeper through the ceiling.
    const crossFloor = !sameFloor(this.group.position, event.pos);
    if (crossFloor && event.intensity < 60) return;

    // Door-open events for Weepers: just transition to SEARCH (calmly walk
    // toward the noise) — never to scream/inhale.
    if (event.kind === 'door_open') {
      if (d > 18) return;
      if (this.navGraph) {
        const startIdx = this.navGraph.nearest(this.group.position);
        const endIdx   = this.navGraph.nearest(event.pos);
        this._patrolPath = this.navGraph.findPath(startIdx, endIdx);
        this._patrolIdx  = 0;
      }
      this.target.copy(event.pos);
      this.memoryTimer = Math.max(this.memoryTimer, 4.0);
      if (this.state === WEEPER_STATES.IDLE
          || this.state === WEEPER_STATES.PATROL
          || this.state === WEEPER_STATES.SEARCH) {
        this.state = WEEPER_STATES.SEARCH;
        this.stateTimer = 0;
      }
      return;
    }

    // GUARANTEED close-range detection: any meaningful noise within 6m
    // always triggers an alert (no probability roll). This ensures every
    // weeper reliably detects player noise nearby.
    const CLOSE_RANGE = 6.0;
    let detected = false;

    if (d <= CLOSE_RANGE && event.intensity >= 25) {
      detected = true;
      // Loud nearby noise (running/jumping) → straight to scream pipeline.
      // Quiet walks within close range → alerted but not auto-screaming.
      const isLoudPlayerAction = event.intensity >= 55;  // sprint=60, jump=65
      if (isLoudPlayerAction && this.state !== WEEPER_STATES.INHALE
          && this.state !== WEEPER_STATES.SCREAM) {
        this.target.copy(event.pos);
        this.state = WEEPER_STATES.INHALE;   // skip alerted, scream soon
        this.stateTimer = 0;
        this.memoryTimer = 6.0;
        return;
      }
    } else {
      // Long-range probabilistic hearing (unchanged behavior)
      const maxHearDist = event.intensity * 0.25;
      if (d > maxHearDist) return;
      const hearChance = Math.max(0.2, 1 - (d / maxHearDist) * 0.7);
      if (Math.random() > hearChance) return;
      detected = true;
    }
    if (!detected) return;

    // Path toward the sound source
    if (this.navGraph) {
      const startIdx = this.navGraph.nearest(this.group.position);
      const endIdx = this.navGraph.nearest(event.pos);
      this._patrolPath = this.navGraph.findPath(startIdx, endIdx);
      this._patrolIdx = 0;
    }
    this.target.copy(event.pos);
    if (this.state === WEEPER_STATES.IDLE
        || this.state === WEEPER_STATES.PATROL
        || this.state === WEEPER_STATES.SEARCH) {
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
          steerTowards(this.group, waypoint, this.speed * 0.4, dt, octree, this.doors);
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
          steerTowards(this.group, waypoint, this.speed, dt, octree, this.doors);
          if (distance2D(this.group.position, waypoint) < 1.0) {
            this._patrolIdx++;
          }
        } else {
          steerTowards(this.group, this.target, this.speed, dt, octree, this.doors);
        }

        // Only scream when the Weeper is actually near the noise source AND
        // has line of sight to the player. Otherwise drop to SEARCH so we
        // never scream through walls from across the map.
        const losPlayer = hasLOS2D(octree, this.group.position, player.collider.start, 1.6, this.doors);
        const distToTarget = distance2D(this.group.position, this.target);
        const distToPlayer = dPlayer;

        if (distToTarget < 1.5 && distToPlayer < 4.0 && losPlayer) {
          this.state = WEEPER_STATES.INHALE;
          this.stateTimer = 0;
        } else if (this.stateTimer > 3.0) {
          // Couldn't reach / couldn't see — search instead of screaming
          this.state = WEEPER_STATES.SEARCH;
          this.stateTimer = 0;
          this.memoryTimer = Math.max(this.memoryTimer, 4.0);
        }
        break;
      }
      case WEEPER_STATES.INHALE: {
        // If the player has clearly moved out of close range / out of sight
        // during the inhale, abort the scream and just search instead.
        const losPlayer = hasLOS2D(octree, this.group.position, player.collider.start, 1.6, this.doors);
        if (dPlayer > 6.0 || !losPlayer) {
          this.state = WEEPER_STATES.SEARCH;
          this.stateTimer = 0;
          this.memoryTimer = Math.max(this.memoryTimer, 4.0);
          break;
        }
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
          steerTowards(this.group, this.target, this.speed * 0.7, dt, octree, this.doors);
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
    this._losLostTimer = 0;
    this._doorCheckTimer = 0;
    this.doors = [];                      // populated by AIManager.setDoors()
    // Speeds: +7% over previous +15%/+15% pass to keep pressure on the
    // player without breaking escapability. Literals stay layered so the
    // tuning history is readable: base × first pass × second pass × +7%.
    this.speedPatrol = 0.45 * 1.15 * 1.15 * 1.07;       // ≈ 0.6367 m/s
    this.speedHunt   = 3.0 * 1.05 * 1.15 * 1.07;        // ≈ 3.876 m/s (player sprint 6.6 — still escapable)
    this.huntDelay   = 0;

    // Fixed attack cadence — ranges +3.5% over base values
    this.attackInterval = 1.2;            // seconds between successive damage ticks (FEAT-004 tighten)
    this.attackRange    = 1.0 * 1.035;    // damage only inside ~1.035m
    this.aggressionRange = 1.5 * 1.035;   // close enough to enter attack state (~1.553m)

    // Patrol with pathfinding
    this._patrolPath = [];
    this._patrolIdx = 0;
    this._patrolWait = 0;

    // Repath / stuck detection (used during hunt)
    this._repathTimer = 0;        // forces a fresh path to the player every 0.5s while hunting
    this._stuckTimer = 0;         // accumulates time spent making no real progress
    this._stuckProbe = 0;         // current sidestep probe direction (-1, 0, +1)
    this._lastPathTarget = null;  // lazily allocated THREE.Vector3, tracks the player pos used for last successful path

    this._pickNewPatrolTarget();
  }

  _pickNewPatrolTarget() {
    if (!this.navGraph || this.navGraph.points.length === 0) return;
    const startIdx = this.navGraph.nearestReachable(this.mesh.position);
    const endIdx = this.navGraph.randomPoint();
    this._patrolPath = this.navGraph.findPath(startIdx, endIdx);
    this._patrolIdx = 0;
  }

  /** Open any closed (non-locked) door within reach.
   *
   *  Door-opening is the FIRST thing the entity does each tick when in hunt /
   *  search / patrol — there's no point trying to slide along a wall when
   *  the actual blocker is a closeable door. The reach radius (1.8m) is wider
   *  than the steer-collision radius (0.35m) so the entity opens the door
   *  *before* steerTowards bounces it off the blocker.
   *
   *  Returns true if any door's open state changed this tick.
   */
  _interactWithDoors(dt, onDoorChange) {
    let changed = false;
    for (const d of this.doors) {
      if (!d || d.locked) continue;
      // Only consider doors on the same floor (basement vs surface)
      const dyBase = (d.yBase || 0);
      const myY    = this.mesh.position.y;
      // Door blocker spans roughly [yBase .. yBase+2.4]; entity sits at y≈1.4
      // on surface, ~-2.1 in basement. ±1.5m tolerance separates the floors.
      if (Math.abs((dyBase + 1.2) - myY) > 2.0) continue;

      const dx = d.worldPos.x - this.mesh.position.x;
      const dz = d.worldPos.z - this.mesh.position.z;
      const dist = Math.hypot(dx, dz);

      // Open if close enough — wider than the steer collision radius (0.35m)
      // so we open before steerTowards bumps off the blocker. The 2.4m radius
      // also lets the entity open doors *as it approaches*, not after stalling
      // (raised from 1.8m in FEAT-004 to cut down on pre-doorway dawdling).
      if (!d.open && dist < 2.4) {
        d.open = true;
        changed = true;
        onDoorChange?.(d, 'open');
      }
    }
    return changed;
  }

  /** Line-of-sight check: returns true if no wall between A and B (in xz plane). */
  _hasLOS(octree, a, b) {
    return hasLOS2D(octree, a, b, 1.4, this.doors);
  }

  /** Noise event handler.
   *
   *  Reaction thresholds (intensity is 0..100, mirrors the player noise meter):
   *   - dPlayer ≤ 4m   (very close)  → react if intensity > 10  (any movement, even crouch)
   *   - 4m  < d ≤ 12m  (medium)      → react if intensity > 40  (sprint, jump, loud)
   *   - dPlayer > 12m  (far)         → react if intensity > 60  (sprint, jump, scream)
   *
   *  Anything else is ignored. Noise from external loud world events
   *  (Weeper screams, glass) bypasses the threshold and uses a longer
   *  hearing range, but Weepers are no longer spawned.
   */
  hear(event) {
    const d = distance2D(this.mesh.position, event.pos);

    // Cross-floor noise must be much louder to be heard. Walking quietly in
    // the basement should not be audible to a Horcror standing on the floor
    // above (and vice-versa) — only screams/jumps with intensity ≥ 60.
    const crossFloor = !sameFloor(this.mesh.position, event.pos);
    if (crossFloor && event.intensity < 60) return;

    // -------- Door-open cue: soft "investigate" signal --------
    // A door opening should make the entity walk *calmly* toward the door
    // (search state, no aggression cry). It does NOT enter hunt — that
    // would play the loud aggression SFX and pull the entity at sprint
    // speed, which is exactly what the player wants to avoid.
    if (event.kind === 'door_open') {
      const HEAR_DOOR = 22;            // doors carry through walls a little
      if (d > HEAR_DOOR) return;
      if (this.navGraph) {
        const startIdx = this.navGraph.nearestReachable(this.mesh.position);
        const endIdx   = this.navGraph.nearest(event.pos);
        this._patrolPath = this.navGraph.findPath(startIdx, endIdx);
        this._patrolIdx  = 0;
      }
      this.target.copy(event.pos);
      this.lastHeardAt = performance.now();
      // Short search memory (just enough to walk to the door and look around)
      this.memoryTimer = Math.max(this.memoryTimer, 4.0);
      // Don't override an active hunt or attack — door cue is only
      // meaningful when the entity isn't already chasing the player.
      if (this.state === 'patrol' || this.state === 'search') {
        this.state = 'search';
        this._patrolWait = 0;
        this._stuckTimer = 0;
      }
      return;
    }

    let threshold;
    let maxRange;
    const isLoudWorldEvent = event.intensity >= 80;

    if (isLoudWorldEvent) {
      threshold = 1;          // always reacts to loud world events
      maxRange  = 40;
    } else if (d <= 4) {
      threshold = 10;
      maxRange  = 4;
    } else if (d <= 12) {
      threshold = 40;
      maxRange  = 12;
    } else {
      threshold = 60;
      maxRange  = 25;          // reasonable upper bound on player-generated hearing
    }

    if (event.intensity < threshold) return;
    if (d > maxRange) return;
    // Re-path toward sound source via NavGraph so AI can navigate around walls
    if (this.navGraph) {
      const startIdx = this.navGraph.nearestReachable(this.mesh.position);
      const endIdx   = this.navGraph.nearest(event.pos);
      this._patrolPath = this.navGraph.findPath(startIdx, endIdx);
      this._patrolIdx  = 0;
    }
    this.target.copy(event.pos);
    this.lastHeardAt = performance.now();
    // Memory: how long we keep chasing after silence falls. Short, so the
    // entity reliably "loses" the player when they stop making noise.
    this.memoryTimer = 3.0;

    if (this.state !== 'attack') {
      this.state = 'hunt';
      this.huntDelay = 0.15;
    }
  }

  update(dt, octree, player, stress, onAttack, onDoorChange, noise, onHunt) {
    this.mesh.material.uniforms.uTime.value += dt;
    this.memoryTimer = Math.max(0, this.memoryTimer - dt);
    this.attackCooldown = Math.max(0, this.attackCooldown - dt);
    this.huntDelay = Math.max(0, this.huntDelay - dt);

    // Track state transition into hunt for one-shot callbacks (aggression sfx etc.)
    const prevState = this._prevState;

    const dPlayer = distance2D(this.mesh.position, player.collider.start);
    const hasLOS = this._hasLOS(octree, this.mesh.position, player.collider.start);
    // Vertical separation gate: when the player is on a different floor
    // (basement vs surface), the Horcror is rendered on the floor above
    // and the player is several metres below; without this guard distance2D
    // (which ignores Y) would still report a small distance and the entity
    // would deal damage / cause stress straight through the ceiling.
    const onSameFloor = sameFloor(this.mesh.position, player.collider.start);

    // Cache for door-close logic
    this._lastPlayerPos = { x: player.collider.start.x, z: player.collider.start.z };

    // -------- Direct noise-meter polling --------
    // Per-frame check on the player's noise meter (same value shown in HUD).
    // This is the primary detection path: as soon as the meter rises above
    // the distance-band threshold, the entity goes into hunt mode toward
    // the player's current position. This is independent of discrete
    // footstep events so jumping/walking in place reliably triggers a hunt.
    //
    // Cross-floor noise is dampened: the meter is effectively halved when
    // the player is on a different floor, so quiet movement in the basement
    // does not pull a surface-floor Horcror into hunt mode.
    if (noise) {
      const meterRaw = noise.meter || 0;
      const meter = onSameFloor ? meterRaw : meterRaw * 0.5;
      let trigger = false;
      if (dPlayer <= 4 && meter > 10)        trigger = true;
      else if (dPlayer <= 12 && meter > 40)  trigger = true;
      else if (dPlayer <= 25 && meter >= 60) trigger = true;

      if (trigger) {
        // Always update the "last heard" position to the player's current spot.
        // The actual movement strategy (chase directly vs follow a path) is
        // decided later in the hunt state based on line-of-sight.
        this.target.copy(player.collider.start);
        this.lastHeardAt = performance.now();
        this.memoryTimer = 3.0;          // stays in hunt for 3s after last qualifying noise
        if (this.state !== 'attack' && this.state !== 'hunt') {
          this.state = 'hunt';
          this.huntDelay = 0;
          this._stuckTimer = 0;
          this._repathTimer = 0;
          this._patrolPath = [];           // start from a clean path
          this._patrolIdx = 0;
        }
      }
    }

    // Door interaction — run in EVERY active state so the entity opens
    // closed (non-locked) doors whether it's patrolling, searching or
    // hunting. Without this in patrol, the Horcror would dawdle behind
    // a closed door for many seconds before the player makes any noise.
    if (this.state === 'hunt' || this.state === 'search' || this.state === 'patrol') {
      this._interactWithDoors(dt, onDoorChange);
    }

    // Proximity stress ONLY when in line of sight AND on the same floor
    if (dPlayer < 4 && hasLOS && onSameFloor) {
      stress?.applyEnemyProximity(dPlayer, dt);
    }

    switch (this.state) {
      case 'patrol': {
        // Track actual movement so we can detect "stuck on furniture / corner"
        // and force a fresh patrol target. Without this the entity could
        // stand idle for a very long time pressing into a wall.
        let actualMove = 0;
        if (this._patrolPath.length > 0 && this._patrolIdx < this._patrolPath.length) {
          const waypoint = this._patrolPath[this._patrolIdx];
          actualMove = steerTowards(this.mesh, waypoint, this.speedPatrol, dt, octree, this.doors);
          if (distance2D(this.mesh.position, waypoint) < 1.0) {
            this._patrolIdx++;
            this._stuckTimer = 0;
            if (this._patrolIdx >= this._patrolPath.length) {
              this._patrolWait += dt;
              if (this._patrolWait > 0.5 + Math.random() * 1.5) {
                this._patrolWait = 0;
                this._pickNewPatrolTarget();
              }
            }
          }
        } else {
          this._pickNewPatrolTarget();
        }
        // Stuck detection during patrol — same logic as hunt but more lenient
        // (1.0s window vs 0.5s) since patrol speed is much slower.
        const expectedPatrol = this.speedPatrol * dt;
        if (actualMove < expectedPatrol * 0.25) {
          this._stuckTimer += dt;
          if (this._stuckTimer > 1.0) {
            this._stuckTimer = 0;
            this._pickNewPatrolTarget();
          }
        } else {
          this._stuckTimer = 0;
        }
        this.activity += (0.0 - this.activity) * Math.min(1, dt * 1.5);
        break;
      }

      case 'hunt': {
        if (this.huntDelay > 0) break;

        // Memory expired entirely — fall through to search at last heard position.
        // Note: we do NOT bail out the moment the player goes silent; the entity
        // first walks to the spot it last heard the player, THEN searches.
        if (this.memoryTimer <= 0 && distance2D(this.mesh.position, this.target) < 1.2) {
          this.state = 'search';
          this._patrolWait = 0;
          break;
        }

        // ---- Pick a movement target for THIS frame ----
        // Priority 1: clear line of sight to the player → run straight at them.
        //             No navgraph, no waypoints, no path resets — just charge.
        // Priority 2: no LOS → A*-style path to the last-heard position so the
        //             entity navigates around walls, doors, etc.
        let actualMove = 0;

        if (hasLOS) {
          // Reset path tracking — we'll rebuild it the moment LOS is lost again
          this._patrolPath = [];
          this._patrolIdx = 0;
          this._repathTimer = 0;
          this._losLostTimer = 0;
          actualMove = steerTowards(this.mesh, this.target, this.speedHunt, dt, octree, this.doors);
        } else {
          // No LOS: navigate via NavGraph to the last heard position
          this._losLostTimer = (this._losLostTimer || 0) + dt;

          // Build / refresh the path periodically (every 0.5s) or if we don't have one,
          // and ALSO when the player target has moved >2.5m from the spot we last
          // pathed to. The third condition kills the "monster keeps walking toward
          // a stale spot when the player has relocated to another room" case.
          this._repathTimer -= dt;
          const targetMovedFar = this._lastPathTarget
            ? distance2D(this.target, this._lastPathTarget) > 2.5
            : false;
          const needNewPath = this._patrolPath.length === 0
                            || this._patrolIdx >= this._patrolPath.length
                            || this._repathTimer <= 0
                            || targetMovedFar;
          if (needNewPath && this.navGraph) {
            this._repathTimer = 0.5;
            const startIdx = this.navGraph.nearestReachable(this.mesh.position);
            const endIdx   = this.navGraph.nearest(this.target);
            this._patrolPath = this.navGraph.findPath(startIdx, endIdx);
            this._patrolIdx  = 0;
            if (!this._lastPathTarget) this._lastPathTarget = new THREE.Vector3();
            this._lastPathTarget.copy(this.target);

            // Skip the first waypoint if it's behind us (i.e. closer to current
            // position than the next one). Prevents the "step backward then forward"
            // jitter that happened when the nearest navpoint was between the
            // entity and the wall it was facing.
            if (this._patrolPath.length >= 2) {
              const w0 = this._patrolPath[0];
              const w1 = this._patrolPath[1];
              if (distance2D(this.mesh.position, w0) < 1.2
                  || distance2D(this.mesh.position, w1) < distance2D(w0, w1)) {
                this._patrolIdx = 1;
              }
            }
          }

          if (this._patrolPath.length > 0 && this._patrolIdx < this._patrolPath.length) {
            const waypoint = this._patrolPath[this._patrolIdx];
            actualMove = steerTowards(this.mesh, waypoint, this.speedHunt, dt, octree, this.doors);
            if (distance2D(this.mesh.position, waypoint) < 1.0) {
              this._patrolIdx++;
              this._stuckTimer = 0;
            }
          } else {
            // Fallback — just walk straight toward the last heard point
            actualMove = steerTowards(this.mesh, this.target, this.speedHunt, dt, octree, this.doors);
          }
        }

        // ---- Stuck detection ----
        // If we covered <30% of expected distance for >0.5s, advance the
        // current waypoint and force a repath next tick. Resets cleanly
        // so it doesn't fire while we're naturally slowing near a goal.
        const expected = this.speedHunt * dt;
        if (actualMove < expected * 0.3 && distance2D(this.mesh.position, this.target) > 1.5) {
          this._stuckTimer += dt;
          if (this._stuckTimer > 0.5) {
            this._stuckTimer = 0;
            this._patrolIdx++;
            this._repathTimer = 0;
          }
        } else {
          this._stuckTimer = 0;
        }

        this.activity += (1.0 - this.activity) * Math.min(1, dt * 3);

        // Enter attack state only when very close AND has direct line of sight
        // AND is on the same floor (no damage through the basement ceiling).
        if (dPlayer < this.aggressionRange && hasLOS && onSameFloor && this.attackCooldown <= 0) {
          this.state = 'attack';
        }
        break;
      }

      case 'search': {
        // Wander around last heard position for a few seconds, then give up
        this._patrolWait += dt;
        let actualMove = 0;
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
            const startIdx = this.navGraph.nearestReachable(this.mesh.position);
            const endIdx = this.navGraph.nearest(wanderPt);
            this._patrolPath = this.navGraph.findPath(startIdx, endIdx);
            this._patrolIdx = 0;
          }
        } else {
          const waypoint = this._patrolPath[this._patrolIdx];
          actualMove = steerTowards(this.mesh, waypoint, this.speedPatrol * 1.5, dt, octree, this.doors);
          if (distance2D(this.mesh.position, waypoint) < 1.0) {
            this._patrolIdx++;
            this._stuckTimer = 0;
          }
        }

        // Stuck-while-searching: pick a new wander point if we made no
        // progress for a second. Combined with door-opening this should
        // eliminate the long idle pauses near doorways.
        const expectedSearch = this.speedPatrol * 1.5 * dt;
        if (actualMove < expectedSearch * 0.25) {
          this._stuckTimer += dt;
          if (this._stuckTimer > 1.0) {
            this._stuckTimer = 0;
            this._patrolPath = [];
            this._patrolIdx  = 0;
          }
        } else {
          this._stuckTimer = 0;
        }

        this.activity += (0.4 - this.activity) * Math.min(1, dt * 2);

        // If a new noise comes in during search, hear() will switch state back to hunt.
        // After ~4 sec of fruitless searching, return to patrol (was 6s; FEAT-004 cut).
        if (this._patrolWait > 4) {
          this.state = 'patrol';
          this._patrolWait = 0;
          this._pickNewPatrolTarget();
        }
        break;
      }

      case 'attack': {
        // Strict damage gate: ≤1m AND clear line of sight AND on the
        // same floor as the player. No through-wall hits, no through-
        // ceiling hits when the player descends to the basement.
        if (dPlayer < this.attackRange && hasLOS && onSameFloor) {
          onAttack?.(this);
          stress?.applyLoudSound(40);
          // Knockback is delegated to the player so it goes through the same
          // collision resolution as normal movement — this prevents the
          // player from being shoved through a wall when standing flush to it.
          const dx = player.collider.start.x - this.mesh.position.x;
          const dz = player.collider.start.z - this.mesh.position.z;
          const len = Math.hypot(dx, dz) || 1;
          const push = 0.6;
          if (typeof player.knockback === 'function') {
            player.knockback((dx / len) * push, (dz / len) * push);
          } else {
            // Fallback (shouldn't happen) — old un-collided behaviour
            player.collider.translate(new THREE.Vector3((dx / len) * push, 0, (dz / len) * push));
          }
          this.attackCooldown = this.attackInterval;
        }
        // Whether we hit or missed, return to hunt to track player
        this.state = 'hunt';
        this.huntDelay = 0;
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

    // One-shot hunt callback: fired when state transitions INTO 'hunt'.
    // Used by game.js to play the aggression SFX exactly once per chase.
    if (this.state === 'hunt' && prevState !== 'hunt' && prevState !== 'attack') {
      onHunt?.(this);
    }
    this._prevState = this.state;
  }

  reset() {
    this.mesh.position.copy(this.spawnPos);
    this.mesh.position.y = 1.4;
    this.state = 'patrol';
    this.activity = 0;
    this.memoryTimer = 0;
    this.attackCooldown = 0;
    this._patrolWait = 0;
    this._stuckTimer = 0;
    this._repathTimer = 0;
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
    this.doors = [];           // door array (for AI to open/close)

    this.weepers = [];
    this.horcror = null;
    this.octree = null;

    this._lastNoiseAt = 0;
    this._silenceTimer = 0;

    noise.listen((ev) => this._onNoise(ev));

    this.callbacks = {
      onWeeperScream: null,
      onHorcrorAttack: null,
      onHorcrorHunt: null,    // fires once when Horcror transitions into hunt mode
      onDoorChange: null,
    };
  }

  setOctree(octree) {
    this.octree = octree;
    // Forward to the nav graph so its edges get LOS-pruned. Safe to call
    // before setNavPoints() — navGraph is null then and we just store the
    // octree; the next setNavPoints() / setDoors() will re-run setBlockers.
    this.navGraph?.setBlockers?.(octree, this.doors);
  }

  setNavPoints(points) {
    this.navGraph = new NavGraph(points);
    // If octree / doors were already wired (game.js may call these in any
    // order), re-stitch door waypoints and re-run setBlockers so the new
    // graph has the same enrichments as the old one.
    if (this.doors && this.doors.length) this._stitchDoorWaypoints();
    if (this.octree) this.navGraph.setBlockers(this.octree, this.doors);
  }

  /** Provide door list so AI can open/close blocking doors when path-finding. */
  setDoors(doors) {
    this.doors = doors || [];
    if (this.horcror) this.horcror.doors = this.doors;
    for (const w of this.weepers) w.doors = this.doors;
    // Stitch each door's worldPos into the nav graph as a waypoint so the
    // path naturally threads through doorways. Then rebuild edges (which
    // also picks up the new octree if setOctree was called first).
    if (this.navGraph) {
      this._stitchDoorWaypoints();
      this.navGraph.setBlockers(this.octree, this.doors);
    }
  }

  /** Push each door's worldPos into the nav graph, deduplicated against
   *  existing points by 0.5m proximity. Idempotent: safe to call multiple
   *  times as wiring order changes. */
  _stitchDoorWaypoints() {
    if (!this.navGraph || !this.doors) return;
    for (const d of this.doors) {
      if (!d || !d.worldPos) continue;
      const wp = new THREE.Vector3(d.worldPos.x, d.yBase || 0, d.worldPos.z);
      let dup = false;
      for (const p of this.navGraph.points) {
        if (distance2D(p, wp) < 0.5 && Math.abs((p.y || 0) - wp.y) < 1.0) {
          dup = true;
          break;
        }
      }
      if (!dup) this.navGraph.points.push(wp);
    }
  }

  spawnWeepers(positions) {
    for (const p of positions) this.weepers.push(new Weeper(this.scene, this.audio, p, this.navGraph));
  }

  spawnHorcror(pos) {
    this.horcror = new Horcror(this.scene, this.audio, pos, this.navGraph);
    this.horcror.doors = this.doors;
  }

  /** Notify AI manager that a door's open state changed (for callback wiring). */
  notifyDoorChanged() {
    // future hook — currently doors are checked each AI tick
  }

  _onNoise(event) {
    this._lastNoiseAt = performance.now();
    for (const w of this.weepers) w.hear(event);
    this.horcror?.hear(event);
  }

  update(dt, player, stress) {
    this._tickFrame = (this._tickFrame || 0) + 1;
    const skipWeeperHeavy = (this._tickFrame & 1) === 0;
    for (const w of this.weepers) {
      // Pure-perf gate: skip the FULL Weeper.update on alternate ticks
      // when the Weeper is patrolling/idle AND >12m from the player. The
      // procedural cry audio is tolerant of one missed _update per ~33ms
      // (it's all noise modulation, no envelope crossings) and patrol
      // movement at <1 m/s is invisible at 30Hz vs 60Hz. Behaviour-
      // critical states (alerted/inhale/scream/search) always run at full
      // tick rate. Choice rationale documented in FEAT-004 findings.
      const dPlayer = distance2D(w.group.position, player.collider.start);
      const inLazyState = w.state === WEEPER_STATES.PATROL || w.state === WEEPER_STATES.IDLE;
      if (skipWeeperHeavy && inLazyState && dPlayer > 12) continue;
      w.update(dt, this.octree, player, this.noise, stress,
        (weeper) => this.callbacks.onWeeperScream?.(weeper)
      );
    }
    this.horcror?.update(dt, this.octree, player, stress,
      (h) => this.callbacks.onHorcrorAttack?.(h),
      (door, action) => this.callbacks.onDoorChange?.(door, action),
      this.noise,
      (h) => this.callbacks.onHorcrorHunt?.(h),
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

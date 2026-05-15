/* =========================================================
 * level.js
 * Procedural level builder — Soviet checkpoint + residential
 * corridor + apartment, all merged into a single root for the
 * player Octree. Returns:
 *   { root, spawn, lampPositions, doors, pickups, surfaces,
 *     triggers, weeperSpawns, horcrorSpawn }
 * ========================================================= */

import * as THREE from 'three';
import {
  concreteTexture, plasterTexture, tileTexture,
  woodTexture, metalTexture, asphaltTexture,
} from './textures.js';

const WALL_H = 3.0;
const WALL_T = 0.2;

// helper: tinted lambert material with optional emissive
function mat(color, map, opts = {}) {
  return new THREE.MeshLambertMaterial({
    color, map: map || null,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 1,
    side: opts.side ?? THREE.FrontSide,
  });
}

// helper: box wall (axis-aligned)
function box(w, h, d, material) {
  const g = new THREE.BoxGeometry(w, h, d);
  return new THREE.Mesh(g, material);
}

export function buildLevel(scene) {
  const root = new THREE.Group();
  root.name = 'Level';
  scene.add(root);

  // Doors live in a separate group so they don't bake into the player's
  // collision octree (otherwise opened doors would still block the capsule).
  const doorsRoot = new THREE.Group();
  doorsRoot.name = 'Doors';
  scene.add(doorsRoot);

  // ----- shared materials -----
  const mConcrete = mat(0xffffff, concreteTexture());
  const mPlaster  = mat(0xffffff, plasterTexture());
  const mTile     = mat(0xffffff, tileTexture());
  const mWood     = mat(0xffffff, woodTexture());
  const mMetal    = mat(0xffffff, metalTexture());
  const mAsphalt  = mat(0xffffff, asphaltTexture());
  const mDark     = mat(0x111111);

  // (lampPositions returned to LightingSystem)
  const lampPositions = [];
  const doors = [];
  const pickups = [];
  const triggers = [];
  const surfaces = []; // for noise material lookup (e.g. tile = louder)

  // ===== big floor (asphalt-like for outside, concrete inside) =====
  const FLOOR_SIZE = 80;
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE),
    mConcrete
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0;
  root.add(floor);
  surfaces.push({ mesh: floor, type: 'concrete' });

  // ceiling for the indoor sections (covers most playable area)
  const ceil = new THREE.Mesh(
    new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE),
    mPlaster
  );
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = WALL_H;
  root.add(ceil);

  // ----- helper builders -----
  function wall(x, z, w, d, m = mPlaster, h = WALL_H) {
    const wmesh = box(w, h, d, m);
    wmesh.position.set(x, h / 2, z);
    root.add(wmesh);
    return wmesh;
  }

  function room(x, z, w, d, mFloor = mConcrete, mWall = mPlaster) {
    // Walls (open on north side by default — caller adds where needed)
    // We use simple axis-aligned walls; doorways are gaps left explicitly.
    return { x, z, w, d, mFloor, mWall };
  }

  function lamp(x, z, opts = {}) {
    lampPositions.push({ pos: new THREE.Vector3(x, WALL_H - 0.15, z), opts });
  }

  function door(x, z, rotY = 0, opts = {}) {
    const dgrp = new THREE.Group();
    // Hinge group: rotates the slab around its left edge
    const hinge = new THREE.Group();
    const slabGeo = new THREE.BoxGeometry(1.0, 2.1, 0.08);
    slabGeo.translate(0.5, 1.05, 0); // origin at slab's left/bottom edge
    const slab = new THREE.Mesh(slabGeo, mWood);
    hinge.add(slab);
    // handle (relative to slab geometry, which now starts at x=0)
    const handle = box(0.06, 0.06, 0.18, mMetal);
    handle.position.set(0.85, 1.0, 0.06);
    hinge.add(handle);
    // place hinge at -0.5 inside the door group so closed slab spans -0.5..0.5
    hinge.position.set(-0.5, 0, 0);
    dgrp.add(hinge);
    dgrp.position.set(x, 0, z);
    dgrp.rotation.y = rotY;
    doorsRoot.add(dgrp);
    const doorObj = {
      group: dgrp, hinge, slab, open: false,
      origRotY: rotY,
      worldPos: new THREE.Vector3(x, 1, z),
      ...opts,
    };
    doors.push(doorObj);
    return doorObj;
  }

  function pickupBox(x, z, type, label) {
    const colors = {
      flashlight_battery: 0xc8b04a,
      recorder_battery:   0x88aa44,
      tape:               0x6e6e6e,
      flashlight:         0x886633,
      recorder:           0x444444,
      key:                0xb8a060,
    };
    const g = new THREE.BoxGeometry(0.18, 0.08, 0.10);
    const m = new THREE.MeshLambertMaterial({ color: colors[type] || 0xffffff });
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(x, 0.85, z);
    doorsRoot.add(mesh); // non-collidable group
    const obj = {
      mesh, type, label: label || type, taken: false,
      pos: mesh.position,
    };
    // pedestal — also non-collidable so player can stand close
    const ped = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.22, 0.8, 8),
      mMetal
    );
    ped.position.set(x, 0.4, z);
    doorsRoot.add(ped);
    pickups.push(obj);
    return obj;
  }

  function trigger(x, z, w, d, payload) {
    triggers.push({
      min: new THREE.Vector2(x - w / 2, z - d / 2),
      max: new THREE.Vector2(x + w / 2, z + d / 2),
      fired: false,
      ...payload,
    });
  }

  // =====================================================
  //  LEVEL 1 — CHECKPOINT (south end, small rooms)
  //  Player spawns here. Tutorial: walk, pick up flashlight,
  //  pick up recorder, learn calming, listen to first tape.
  // =====================================================
  // Outer perimeter walls of "checkpoint" (an L-shaped building)
  // Coordinate convention: +X east, +Z south. Player spawn at z=18.
  // Building bounding rectangle: x in [-8..8], z in [12..22]
  // South wall (with door gap)
  wall(-5, 22, 6, WALL_T, mPlaster);
  wall( 5, 22, 6, WALL_T, mPlaster);
  // North wall (opens into corridor)
  wall(-6, 12, 4, WALL_T, mPlaster);
  wall( 6, 12, 4, WALL_T, mPlaster);
  // East wall
  wall(8, 17, WALL_T, 10, mPlaster);
  // West wall
  wall(-8, 17, WALL_T, 10, mPlaster);

  // Internal partition splitting checkpoint into 2 rooms
  wall(0, 19, WALL_T, 6, mPlaster);
  // doorway gap at z=16 in partition (handled by leaving wall ending at 19±3)

  // Front door (entrance from 'outside')
  door(0, 22, 0, { id: 'front_door', locked: true });

  // Pickups in checkpoint
  pickupBox(-5, 19, 'flashlight', 'Flashlight');
  pickupBox( 5, 19, 'recorder',   'Tape Recorder');
  pickupBox(-3, 14, 'tape',       'Tape #1: "Beginning"');

  // Lamps
  lamp(-4, 19, { broken: true });
  lamp( 4, 19, { intensity: 0.9 });
  lamp( 0, 14, { intensity: 0.8 });

  // =====================================================
  //  CORRIDOR (connects checkpoint to apartments)
  //  z in [-2..12], x in [-3..3]
  // =====================================================
  wall(-3, 5, WALL_T, 14, mPlaster);
  wall( 3, 5, WALL_T, 14, mPlaster);

  // Lamps along corridor (some broken to spawn dread)
  lamp(0, 10, { intensity: 1.0 });
  lamp(0, 6,  { broken: true, intensity: 0.6 });
  lamp(0, 2,  { red: true, intensity: 1.2 });

  // Tape #2 mid-corridor
  pickupBox(0, 8, 'flashlight_battery', 'Flashlight Battery');
  pickupBox(2, 4, 'recorder_battery',   'Recorder Battery');

  // First Weeper trigger (spawns ambience + first encounter prompt)
  trigger(0, 4, 4, 2, {
    type: 'subtitle',
    text: '...something is breathing further down...',
    once: true,
  });

  // =====================================================
  //  LEVEL 2 — RESIDENTIAL SECTOR (north end)
  //  Big hub with 4 apartments off a central area.
  //  z in [-22..-2], x in [-12..12]
  // =====================================================
  // Outer walls of hub
  wall(-9, -2, 6,    WALL_T, mPlaster);  // south-west of opening
  wall( 9, -2, 6,    WALL_T, mPlaster);  // south-east of opening
  wall(-12, -12, WALL_T, 20, mPlaster);   // west wall
  wall( 12, -12, WALL_T, 20, mPlaster);   // east wall
  wall(-6, -22, 12,    WALL_T, mPlaster); // north wall LEFT
  wall( 6, -22, 12,    WALL_T, mPlaster); // north wall RIGHT
  // playground gap on north wall

  // Internal partitions creating 4 apartments around a courtyard
  // Apartments: NW (-9, -16), NE (9, -16), SW (-9, -6), SE (9, -6)
  // (kept loose so player has room to navigate)

  // SW apartment shell
  wall(-6, -6, WALL_T, 8, mPlaster);  // east wall of SW
  wall(-9, -10, 6, WALL_T, mPlaster); // north wall of SW
  // SW door
  door(-6, -4, Math.PI / 2, { id: 'apt_sw' });

  // SE apartment shell
  wall(6, -6, WALL_T, 8, mPlaster);
  wall(9, -10, 6, WALL_T, mPlaster);
  door(6, -4, -Math.PI / 2, { id: 'apt_se' });

  // NW apartment shell
  wall(-6, -16, WALL_T, 6, mPlaster);
  wall(-9, -14, 6, WALL_T, mPlaster);
  door(-6, -14, Math.PI / 2, { id: 'apt_nw' });

  // NE apartment shell
  wall(6, -16, WALL_T, 6, mPlaster);
  wall(9, -14, 6, WALL_T, mPlaster);
  door(6, -14, -Math.PI / 2, { id: 'apt_ne' });

  // Hub lamps (one heavily broken — will be killed by horcror later)
  lamp(-6, -6, { broken: true });
  lamp( 6, -6 );
  lamp( 0, -10, { red: true, intensity: 1.4, distance: 9 });
  lamp(-6, -16, { broken: true });
  lamp( 6, -16);

  // Apartment pickups (tape #3, batteries)
  pickupBox(-10, -6, 'tape', 'Tape #2: "Sleeplessness"');
  pickupBox( 10, -6, 'flashlight_battery', 'Flashlight Battery');
  pickupBox(-10, -18, 'tape', 'Tape #3: "The Ones Who Cry"');
  pickupBox( 10, -18, 'recorder_battery', 'Recorder Battery');

  // Final tape — north end "Institute" stub
  // We sketch a doorway leading off-map (locked: ending choice)
  pickupBox(0, -21, 'tape', 'Tape #FINAL: "Anatomy of Silence"');

  // Endgame trigger zone: when player picks up final tape and stands here
  trigger(0, -21, 4, 2, {
    type: 'final_choice',
    once: false,           // re-armed by game logic
  });

  // Decorative props inside apartments + benches
  function bench(x, z, rotY = 0) {
    const g = new THREE.BoxGeometry(1.4, 0.4, 0.4);
    const m = new THREE.Mesh(g, mWood);
    m.position.set(x, 0.2, z);
    m.rotation.y = rotY;
    root.add(m);
  }
  bench(-9, -7);
  bench( 9, -7);
  bench(-9, -17);
  bench( 9, -17);
  bench(0, -2.5);

  // Lockers near east wall (metal noise / rust visible)
  for (let i = 0; i < 4; i++) {
    const lk = box(0.7, 1.9, 0.4, mMetal);
    lk.position.set(11.5, 0.95, -8 - i * 1.1);
    root.add(lk);
  }

  // ===== Weeper / Horcror spawn anchors =====
  const weeperSpawns = [
    new THREE.Vector3(0, 0, 4),       // mid-corridor
    new THREE.Vector3(-10, 0, -10),   // near SW apt
    new THREE.Vector3(10, 0, -16),    // near NE apt
  ];
  const horcrorSpawn = new THREE.Vector3(0, 0, -18);

  // ===== Spawn point (player) =====
  const spawn = new THREE.Vector3(0, 0, 18);

  // ----- attach a "type" tag to floor so noise system can read surface
  // (For now whole world treated as "concrete" except tile floor patches.)

  // Tile patch (bathroom of NW apt) — louder footsteps
  const tileFloor = new THREE.Mesh(
    new THREE.PlaneGeometry(3, 3),
    mTile
  );
  tileFloor.rotation.x = -Math.PI / 2;
  tileFloor.position.set(-10, 0.001, -18);
  root.add(tileFloor);
  surfaces.push({ mesh: tileFloor, type: 'tile' });

  // Outside reach: small playground prop set north of north wall
  const swing = new THREE.Group();
  const post1 = box(0.1, 2.5, 0.1, mMetal); post1.position.set(-1, 1.25, 0); swing.add(post1);
  const post2 = box(0.1, 2.5, 0.1, mMetal); post2.position.set( 1, 1.25, 0); swing.add(post2);
  const top   = box(2.2, 0.1, 0.1, mMetal); top.position.set(0, 2.45, 0);    swing.add(top);
  const seat  = box(0.6, 0.05, 0.2, mWood); seat.position.set(0, 1.0, 0);     swing.add(seat);
  swing.position.set(0, 0, -25);
  root.add(swing);

  return {
    root,
    doorsRoot,
    spawn,
    lampPositions,
    doors,
    pickups,
    triggers,
    surfaces,
    weeperSpawns,
    horcrorSpawn,
  };
}

/** Open/close a door by interpolating its hinge rotation. */
export function toggleDoor(door, dt) {
  const target = door.open ? Math.PI / 1.3 : 0;
  const k = Math.min(1, dt * 6);
  door.hinge.rotation.y += (target - door.hinge.rotation.y) * k;
}

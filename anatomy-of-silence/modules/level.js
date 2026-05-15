/* =========================================================
 * level.js
 * Hand-authored Soviet-decay level: КПП → коридор → жилой
 * сектор с 4 квартирами → подвальный алтарь.
 *
 * Returns:
 *   { root, doorsRoot, spawn, lampPositions, doors, pickups,
 *     surfaces, triggers, notes, weeperSpawns, horcrorSpawn }
 * ========================================================= */

import * as THREE from 'three';
import {
  concreteTexture, plasterTexture, tileTexture,
  woodTexture, metalTexture, ceilingTexture, noteTexture,
} from './textures.js';
import { RU } from './i18n.js';

const WALL_H = 3.0;
const WALL_T = 0.2;

function mat(color, map, opts = {}) {
  return new THREE.MeshLambertMaterial({
    color, map: map || null,
    side: opts.side ?? THREE.FrontSide,
  });
}
function box(w, h, d, material) {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
}

/** Apply per-instance UV repeat by giving each big surface its own texture clone. */
function tiledMat(srcMap, repeatX, repeatY) {
  const tex = srcMap.clone();
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.needsUpdate = true;
  return new THREE.MeshLambertMaterial({ map: tex });
}

export function buildLevel(scene) {
  const root = new THREE.Group();
  root.name = 'Level';
  scene.add(root);

  // Doors + pickups — non-collidable visual layer.
  const doorsRoot = new THREE.Group();
  doorsRoot.name = 'Props';
  scene.add(doorsRoot);

  const mConcrete = mat(0xffffff, concreteTexture());
  const mPlaster  = mat(0xffffff, plasterTexture());
  const mTile     = mat(0xffffff, tileTexture());
  const mWood     = mat(0xffffff, woodTexture());
  const mMetal    = mat(0xffffff, metalTexture());
  const mCeil     = mat(0xffffff, ceilingTexture());
  const mNote     = mat(0xffffff, noteTexture());

  // Source maps for per-wall tiling
  const TX_PLASTER  = plasterTexture();
  const TX_CONCRETE = concreteTexture();
  const TX_CEIL     = ceilingTexture();

  const lampPositions = [];
  const doors = [];
  const pickups = [];
  const triggers = [];
  const surfaces = [];
  const notes = []; // [{worldPos, text, mesh}]

  // ===================================================================
  // FLOOR + CEILING (split into two — you SEE different textures up/down)
  // ===================================================================
  const FLOOR_SIZE = 80;
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE),
    mConcrete
  );
  floor.rotation.x = -Math.PI / 2;
  root.add(floor);
  surfaces.push({ mesh: floor, type: 'concrete' });

  const ceil = new THREE.Mesh(
    new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE),
    mCeil
  );
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = WALL_H;
  root.add(ceil);

  // ===================================================================
  // BUILDERS
  // ===================================================================
  function wall(x, z, w, d, m = mPlaster, h = WALL_H) {
    // For wide plaster walls, generate a unique tiled material so the
    // texture repeats nicely along the wall length. Thin walls use the
    // shared one (which is already plastered-ish).
    let useMat = m;
    if (m === mPlaster) {
      const longest = Math.max(w, d);
      if (longest > 1.5) {
        useMat = tiledMat(TX_PLASTER, Math.max(1, longest / 2.5), Math.max(1, h / 2.5));
      }
    }
    const wmesh = box(w, h, d, useMat);
    wmesh.position.set(x, h / 2, z);
    root.add(wmesh);
    return wmesh;
  }

  function lamp(x, z, opts = {}) {
    lampPositions.push({ pos: new THREE.Vector3(x, WALL_H - 0.18, z), opts });
  }

  function door(x, z, rotY = 0, opts = {}) {
    const dgrp = new THREE.Group();
    const hinge = new THREE.Group();
    const slabGeo = new THREE.BoxGeometry(1.0, 2.1, 0.08);
    slabGeo.translate(0.5, 1.05, 0);
    const slab = new THREE.Mesh(slabGeo, mWood);
    hinge.add(slab);
    const handle = box(0.06, 0.06, 0.18, mMetal);
    handle.position.set(0.85, 1.0, 0.06);
    hinge.add(handle);
    // door frame (decorative, on doorsRoot so it doesn't block octree gap)
    const frameTop = box(1.4, 0.18, 0.12, mWood);
    frameTop.position.set(0, 2.18, 0);
    hinge.add(frameTop);

    hinge.position.set(-0.5, 0, 0);
    dgrp.add(hinge);
    dgrp.position.set(x, 0, z);
    dgrp.rotation.y = rotY;
    doorsRoot.add(dgrp);
    const doorObj = {
      group: dgrp, hinge, slab, open: false,
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
    const g = new THREE.BoxGeometry(0.20, 0.10, 0.12);
    const m = new THREE.MeshLambertMaterial({ color: colors[type] || 0xffffff });
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(x, 0.95, z);
    doorsRoot.add(mesh);
    const obj = { mesh, type, label: label || type, taken: false, pos: mesh.position };
    // pedestal (rusty crate)
    const ped = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.85, 0.5),
      mMetal
    );
    ped.position.set(x, 0.42, z);
    doorsRoot.add(ped);
    pickups.push(obj);
    return obj;
  }

  function trigger(x, z, w, d, payload) {
    triggers.push({
      min: new THREE.Vector2(x - w / 2, z - d / 2),
      max: new THREE.Vector2(x + w / 2, z + d / 2),
      ...payload,
    });
  }

  /** Wall-mounted note (paper). Read with [E] like a pickup. */
  function noteOnWall(x, z, rotY, textKey) {
    const g = new THREE.PlaneGeometry(0.6, 0.4);
    const mesh = new THREE.Mesh(g, mNote);
    mesh.position.set(x, 1.6, z);
    mesh.rotation.y = rotY;
    doorsRoot.add(mesh);
    notes.push({ mesh, worldPos: new THREE.Vector3(x, 1.6, z), text: RU[textKey] });
  }

  function bench(x, z, rotY = 0) {
    const g = new THREE.BoxGeometry(1.4, 0.4, 0.4);
    const m = new THREE.Mesh(g, mWood);
    m.position.set(x, 0.2, z);
    m.rotation.y = rotY;
    root.add(m);
  }

  function locker(x, z, rotY = 0) {
    const lk = box(0.7, 1.9, 0.4, mMetal);
    lk.position.set(x, 0.95, z);
    lk.rotation.y = rotY;
    root.add(lk);
  }

  function pipe(x, z, h = 2.8) {
    const g = new THREE.CylinderGeometry(0.06, 0.06, h, 8);
    const m = new THREE.Mesh(g, mMetal);
    m.position.set(x, h / 2 + 0.05, z);
    root.add(m);
  }

  // ===================================================================
  //  ZONE 1 — КПП (checkpoint) — south side, z ∈ [12..22]
  //  Player spawns at (0, 0, 18) facing north.
  // ===================================================================
  // South wall (with central door gap)
  wall(-5, 22, 6, WALL_T, mPlaster);
  wall( 5, 22, 6, WALL_T, mPlaster);
  // North wall (gap to corridor at center)
  wall(-6, 12, 4, WALL_T, mPlaster);
  wall( 6, 12, 4, WALL_T, mPlaster);
  // East / West walls
  wall(8, 17, WALL_T, 10, mPlaster);
  wall(-8, 17, WALL_T, 10, mPlaster);
  // Internal partition (with z=16 gap so player can walk through)
  wall(0, 20.5, WALL_T, 3, mPlaster);
  wall(0, 13.5, WALL_T, 3, mPlaster);

  // Front (south) door — locked, atmospheric only
  door(0, 22, 0, { id: 'front_door', locked: true });

  // Pickups — flashlight on east desk, recorder on west desk, tape on bench
  pickupBox(-5, 19, 'flashlight', RU.item_flashlight);
  pickupBox( 5, 19, 'recorder',   RU.item_recorder);
  pickupBox(-3, 14, 'tape',       RU.tape_1);

  // Notes (the FIRST one is right next to the spawn — guarantees the player reads it)
  noteOnWall(-1.2, 17.95, 0,            'note_kpp_1');     // on east wall behind spawn
  noteOnWall( 4.8, 14, -Math.PI / 2,    'note_kpp_2');     // on east internal wall

  // Furniture
  bench(-5, 18.2);
  bench( 5, 18.2);
  locker(7.6, 14.5);
  locker(7.6, 15.5);
  locker(-7.6, 14.5);
  locker(-7.6, 15.5);

  // Lamps (warm working lights here so player can see + know they're SAFE here)
  lamp(-4, 19, { intensity: 1.2 });
  lamp( 4, 19, { intensity: 1.2 });
  lamp( 0, 14, { broken: true, intensity: 0.7 });

  // ===================================================================
  //  ZONE 2 — CORRIDOR (z ∈ [-2 .. 12], x ∈ [-3 .. 3])
  //  Tighter, darker. Red emergency light at the end.
  // ===================================================================
  wall(-3, 5, WALL_T, 14, mPlaster);
  wall( 3, 5, WALL_T, 14, mPlaster);
  // Pipes running along the corridor (visible above head)
  for (let z = 11; z >= -1; z -= 2) pipe(-2.6, z, 0.4);
  for (let z = 11; z >= -1; z -= 2) pipe( 2.6, z, 0.4);

  // Lamps (one broken, one red emergency)
  lamp(0, 10, { intensity: 1.0 });
  lamp(0, 6,  { broken: true, intensity: 0.5 });
  lamp(0, 2,  { red: true, intensity: 1.4, distance: 8 });

  // Pickups in corridor (a battery + a battery)
  pickupBox(0, 8, 'flashlight_battery', RU.item_flash_battery);
  pickupBox(2, 4, 'recorder_battery',   RU.item_rec_battery);

  // Mid-corridor narrative trigger
  trigger(0, 4, 4, 2, { type: 'subtitle', text: RU.trig_breath, once: true });
  trigger(0, 11, 4, 2, { type: 'subtitle', text: RU.trig_first_red, once: true });
  noteOnWall(-2.85, 7, Math.PI / 2, 'note_corridor');

  // ===================================================================
  //  ZONE 3 — RESIDENTIAL HUB (z ∈ [-22..-2], x ∈ [-12..12])
  //  Central courtyard with 4 apartments around it.
  // ===================================================================
  // Hub south opening from corridor → walls flanking the entrance
  wall(-7.5, -2, 9,  WALL_T, mPlaster);
  wall( 7.5, -2, 9,  WALL_T, mPlaster);
  // West / East outer walls
  wall(-12, -12, WALL_T, 20, mPlaster);
  wall( 12, -12, WALL_T, 20, mPlaster);
  // North outer (with gap leading to basement/altar at x≈0)
  wall(-7, -22, 10, WALL_T, mPlaster);
  wall( 7, -22, 10, WALL_T, mPlaster);

  // Internal partitions for 4 apartments. Each apartment is roughly
  // 5×5m, with a doorway opening on the courtyard side.
  // Layout (looking down):
  //   NW(-9,-16)   |  hallway  |  NE(9,-16)
  //   ----wall---- (x in -3..3 open)
  //   SW(-9,-6)    |  hallway  |  SE(9,-6)

  // SW apartment: walls
  wall(-6, -7,  WALL_T, 10, mPlaster);   // east wall
  wall(-9.5, -10, 5, WALL_T, mPlaster);  // north wall (gap at x=-7)
  // SE apartment: walls
  wall( 6, -7,  WALL_T, 10, mPlaster);
  wall( 9.5, -10, 5, WALL_T, mPlaster);
  // NW apartment: walls
  wall(-6, -16, WALL_T, 8, mPlaster);
  wall(-9.5, -14, 5, WALL_T, mPlaster);
  // NE apartment: walls
  wall( 6, -16, WALL_T, 8, mPlaster);
  wall( 9.5, -14, 5, WALL_T, mPlaster);

  // Apartment doors (wooden) — all open to the central hallway
  door(-6, -4, Math.PI / 2,  { id: 'apt_sw' });
  door( 6, -4, -Math.PI / 2, { id: 'apt_se' });
  door(-6, -14, Math.PI / 2, { id: 'apt_nw' });
  door( 6, -14, -Math.PI / 2,{ id: 'apt_ne' });

  // Hub lamps — sparse, mostly broken/red
  lamp(-6, -4, { broken: true });
  lamp( 6, -4 );
  lamp( 0, -10, { red: true, intensity: 1.5, distance: 9 });
  lamp(-6, -14, { broken: true });
  lamp( 6, -14);
  lamp( 0, -19, { red: true, intensity: 1.6, distance: 8 });

  // Tiles patch — bathroom of NW apt (loud footsteps)
  const tileFloor = new THREE.Mesh(
    new THREE.PlaneGeometry(3, 3),
    mTile
  );
  tileFloor.rotation.x = -Math.PI / 2;
  tileFloor.position.set(-10, 0.001, -18);
  root.add(tileFloor);
  surfaces.push({ mesh: tileFloor, type: 'tile' });

  // Apartment pickups — the THREE story tapes are here
  pickupBox(-9.5, -7, 'tape', RU.tape_2);                 // SW apartment
  pickupBox( 9.5, -7, 'flashlight_battery', RU.item_flash_battery);
  pickupBox(-9.5, -17, 'tape', RU.tape_3);                // NW apartment
  pickupBox( 9.5, -17, 'recorder_battery', RU.item_rec_battery);
  pickupBox( 9.5, -19, 'tape', RU.tape_F);                // NE apartment — FINAL tape

  // Notes inside apartments
  noteOnWall(-8.5, -9.85, Math.PI,            'note_apt');
  noteOnWall(-9.5, -19.85, Math.PI,           'note_basement');

  // Furniture in apartments (benches, lockers)
  bench(-10, -7);
  bench( 10, -7);
  bench(-10, -17);
  bench( 10, -17);
  bench(0, -3.5);
  for (let i = 0; i < 4; i++) locker(11.6, -8 - i * 1.0);
  for (let i = 0; i < 4; i++) locker(-11.6, -8 - i * 1.0);

  // ===================================================================
  //  ZONE 4 — ALTAR ROOM (north of hub, behind a gap at z = -22, x ∈ [-3..3])
  //  Dark hallway → small altar chamber where final choice happens.
  // ===================================================================
  wall(-3, -25, WALL_T, 6, mPlaster);
  wall( 3, -25, WALL_T, 6, mPlaster);
  // back wall
  wall(0, -28, 6, WALL_T, mPlaster);
  // Altar mesh — a low concrete plinth with a faint red glow
  const altar = new THREE.Mesh(
    new THREE.BoxGeometry(1.4, 0.5, 0.8),
    new THREE.MeshLambertMaterial({ color: 0x554a3a, emissive: 0x250000, emissiveIntensity: 0.6 })
  );
  altar.position.set(0, 0.25, -27);
  doorsRoot.add(altar);
  // candles around it (tiny boxes)
  for (const dx of [-0.5, 0.5]) {
    for (const dz of [-0.3, 0.3]) {
      const candle = new THREE.Mesh(
        new THREE.CylinderGeometry(0.03, 0.03, 0.18, 6),
        new THREE.MeshLambertMaterial({ color: 0xddc88a, emissive: 0xff8000, emissiveIntensity: 1.0 })
      );
      candle.position.set(0 + dx, 0.6, -27 + dz);
      doorsRoot.add(candle);
    }
  }
  lamp(0, -27, { red: true, intensity: 1.3, distance: 5 });

  // Final-choice trigger
  trigger(0, -27, 3, 2, { type: 'final_choice' });

  // ===================================================================
  //  Spawn / AI anchors
  // ===================================================================
  const spawn = new THREE.Vector3(0, 0, 18);
  const weeperSpawns = [
    new THREE.Vector3(0, 0, 4),       // mid-corridor
    new THREE.Vector3(-9.5, 0, -10),  // SW apt
    new THREE.Vector3(9.5, 0, -16),   // NE apt
  ];
  const horcrorSpawn = new THREE.Vector3(0, 0, -22);

  return {
    root,
    doorsRoot,
    spawn,
    lampPositions,
    doors,
    pickups,
    triggers,
    surfaces,
    notes,
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

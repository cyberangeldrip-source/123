/* =========================================================
 * level.js
 * Hand-authored Soviet-decay level: КПП → коридор → жилой
 * сектор с 4 квартирами → подвальный алтарь.
 *
 * Returns:
 *   { root, doorsRoot, spawn, lampPositions, doors, pickups,
 *     surfaces, triggers, notes, weeperSpawns, horcrorSpawn,
 *     navPoints }
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
  const navPoints = []; // waypoints for AI pathfinding

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

  /**
   * Door that physically blocks a passage.
   * The door slab is added to `root` (collidable) when closed,
   * and moved to `doorsRoot` (non-collidable) when open.
   */
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
    // door frame (decorative)
    const frameTop = box(1.4, 0.18, 0.12, mWood);
    frameTop.position.set(0, 2.18, 0);
    hinge.add(frameTop);

    hinge.position.set(-0.5, 0, 0);
    dgrp.add(hinge);
    dgrp.position.set(x, 0, z);
    dgrp.rotation.y = rotY;

    // Door blocker - a thin invisible wall in root (collidable) when closed
    const blockerGeo = new THREE.BoxGeometry(1.2, 2.4, 0.15);
    const blockerMat = new THREE.MeshBasicMaterial({ visible: false });
    const blocker = new THREE.Mesh(blockerGeo, blockerMat);
    blocker.position.set(x, 1.2, z);
    blocker.rotation.y = rotY;

    // Start closed: visual on doorsRoot, blocker on root
    doorsRoot.add(dgrp);
    root.add(blocker);

    const doorObj = {
      group: dgrp, hinge, slab, blocker, open: false,
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

  /** Wall-mounted note (paper). Offset slightly from wall so it renders on surface. */
  function noteOnWall(x, z, rotY, textKey, wallOffset = 0.02) {
    const g = new THREE.PlaneGeometry(0.6, 0.4);
    const mesh = new THREE.Mesh(g, mNote);
    // Offset the note slightly away from the wall to prevent z-fighting
    const offsetX = Math.sin(rotY) * wallOffset;
    const offsetZ = Math.cos(rotY) * wallOffset;
    mesh.position.set(x + offsetX, 1.6, z + offsetZ);
    mesh.rotation.y = rotY;
    doorsRoot.add(mesh);
    notes.push({ mesh, worldPos: new THREE.Vector3(x + offsetX, 1.6, z + offsetZ), text: RU[textKey] });
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

  function nav(x, z) {
    const p = new THREE.Vector3(x, 0, z);
    navPoints.push(p);
    return p;
  }

  // ===================================================================
  //  ZONE 1 — КПП (checkpoint) — south side, z ∈ [12..22]
  //  Player spawns at (0, 0, 18) facing north.
  // ===================================================================
  // South wall (with central door gap — 1.2m opening)
  wall(-5.6, 22, 5, WALL_T, mPlaster);
  wall( 5.6, 22, 5, WALL_T, mPlaster);
  // North wall (gap to corridor at center — 3m opening)
  wall(-6, 12, 4, WALL_T, mPlaster);
  wall( 6, 12, 4, WALL_T, mPlaster);
  // East / West walls
  wall(8, 17, WALL_T, 10, mPlaster);
  wall(-8, 17, WALL_T, 10, mPlaster);
  // Internal partition (with z=16 gap so player can walk through)
  wall(0, 20.5, WALL_T, 3, mPlaster);
  wall(0, 13.5, WALL_T, 3, mPlaster);

  // Front (south) door — locked, blocks the south entrance
  door(0, 22, 0, { id: 'front_door', locked: true });

  // North door — blocks exit from KPP to corridor  
  door(0, 12, 0, { id: 'kpp_exit' });

  // Pickups
  pickupBox(-5, 19, 'flashlight', RU.item_flashlight);
  pickupBox( 5, 19, 'recorder',   RU.item_recorder);
  pickupBox(-3, 14, 'tape',       RU.tape_1);

  // Notes — attached to walls with correct facing
  noteOnWall(-7.8, 18, Math.PI / 2, 'note_kpp_1');     // on west wall, facing east
  noteOnWall( 7.8, 14, -Math.PI / 2, 'note_kpp_2');    // on east wall, facing west

  // Furniture
  bench(-5, 18.2);
  bench( 5, 18.2);
  locker(7.6, 14.5);
  locker(7.6, 15.5);
  locker(-7.6, 14.5);
  locker(-7.6, 15.5);

  // Lamps
  lamp(-4, 19, { intensity: 1.2 });
  lamp( 4, 19, { intensity: 1.2 });
  lamp( 0, 14, { broken: true, intensity: 0.7 });
  lamp( 0, 18, { intensity: 1.0 }); // extra lamp at spawn

  // Nav points for KPP
  nav(0, 18); nav(0, 14); nav(-5, 18); nav(5, 18);

  // ===================================================================
  //  ZONE 2 — CORRIDOR (z ∈ [-2 .. 12], x ∈ [-3 .. 3])
  //  Tighter, darker. Red emergency light at the end.
  // ===================================================================
  wall(-3, 5, WALL_T, 14, mPlaster);
  wall( 3, 5, WALL_T, 14, mPlaster);
  // Pipes running along the corridor
  for (let z = 11; z >= -1; z -= 2) pipe(-2.6, z, 0.4);
  for (let z = 11; z >= -1; z -= 2) pipe( 2.6, z, 0.4);

  // Lamps
  lamp(0, 10, { intensity: 1.0 });
  lamp(0, 6,  { broken: true, intensity: 0.5 });
  lamp(0, 2,  { red: true, intensity: 1.4, distance: 8 });
  lamp(0, -1, { intensity: 0.8 }); // extra light at corridor end

  // Pickups in corridor
  pickupBox(0, 8, 'flashlight_battery', RU.item_flash_battery);
  pickupBox(2, 4, 'recorder_battery',   RU.item_rec_battery);

  // Mid-corridor narrative trigger
  trigger(0, 4, 4, 2, { type: 'subtitle', text: RU.trig_breath, once: true });
  trigger(0, 11, 4, 2, { type: 'subtitle', text: RU.trig_first_red, once: true });
  noteOnWall(-2.8, 7, Math.PI / 2, 'note_corridor'); // on west wall facing east

  // Nav points for corridor
  nav(0, 10); nav(0, 6); nav(0, 2); nav(0, -1);

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
  // North outer (with gap leading to basement/altar at x≈0, 3m opening)
  wall(-7, -22, 10, WALL_T, mPlaster);
  wall( 7, -22, 10, WALL_T, mPlaster);

  // Internal partitions for 4 apartments with doorway gaps
  // SW apartment: walls (gap at x=-6 for door)
  wall(-6, -7,  WALL_T, 10, mPlaster);
  wall(-9.5, -10, 5, WALL_T, mPlaster);
  // SE apartment: walls (gap at x=6 for door)
  wall( 6, -7,  WALL_T, 10, mPlaster);
  wall( 9.5, -10, 5, WALL_T, mPlaster);
  // NW apartment: walls (gap at x=-6 for door)
  wall(-6, -16, WALL_T, 8, mPlaster);
  wall(-9.5, -14, 5, WALL_T, mPlaster);
  // NE apartment: walls (gap at x=6 for door)
  wall( 6, -16, WALL_T, 8, mPlaster);
  wall( 9.5, -14, 5, WALL_T, mPlaster);

  // Apartment doors — block passage into each apartment
  door(-6, -4, Math.PI / 2,  { id: 'apt_sw' });
  door( 6, -4, -Math.PI / 2, { id: 'apt_se' });
  door(-6, -14, Math.PI / 2, { id: 'apt_nw' });
  door( 6, -14, -Math.PI / 2,{ id: 'apt_ne' });

  // Door to altar zone — blocks passage north
  door(0, -22, 0, { id: 'altar_door' });

  // Hub lamps — more lamps for better coverage
  lamp(-6, -4);
  lamp( 6, -4);
  lamp( 0, -6, { intensity: 0.9 });
  lamp( 0, -10, { red: true, intensity: 1.5, distance: 9 });
  lamp(-6, -14);
  lamp( 6, -14);
  lamp( 0, -19, { red: true, intensity: 1.6, distance: 8 });
  lamp(-9, -7, { intensity: 0.8 });   // inside SW apt
  lamp( 9, -7, { intensity: 0.8 });   // inside SE apt
  lamp(-9, -17, { intensity: 0.7 });  // inside NW apt
  lamp( 9, -17, { intensity: 0.7 });  // inside NE apt
  lamp( 0, -3, { intensity: 0.9 });   // hub entrance

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

  // Notes inside apartments — properly attached to walls
  noteOnWall(-11.8, -9, Math.PI / 2, 'note_apt');          // on west wall of SW apt facing east
  noteOnWall(-11.8, -18, Math.PI / 2, 'note_basement');    // on west wall of NW apt facing east

  // Furniture in apartments
  bench(-10, -7);
  bench( 10, -7);
  bench(-10, -17);
  bench( 10, -17);
  bench(0, -3.5);
  for (let i = 0; i < 4; i++) locker(11.6, -8 - i * 1.0);
  for (let i = 0; i < 4; i++) locker(-11.6, -8 - i * 1.0);

  // Nav points for hub
  nav(0, -3); nav(0, -6); nav(0, -10); nav(0, -14); nav(0, -19);
  nav(-4, -4); nav(4, -4); nav(-4, -14); nav(4, -14);
  nav(-9, -7); nav(9, -7); nav(-9, -17); nav(9, -17);
  nav(-6, -10); nav(6, -10);

  // ===================================================================
  //  ZONE 4 — ALTAR ROOM (north of hub, behind a gap at z = -22, x ∈ [-3..3])
  //  Dark hallway → small altar chamber where final choice happens.
  // ===================================================================
  wall(-3, -25, WALL_T, 6, mPlaster);
  wall( 3, -25, WALL_T, 6, mPlaster);
  // back wall
  wall(0, -28, 6, WALL_T, mPlaster);

  // Altar mesh — a low concrete plinth with a faint red glow
  // NOW ADDED TO ROOT for collision
  const altar = new THREE.Mesh(
    new THREE.BoxGeometry(1.4, 0.5, 0.8),
    new THREE.MeshLambertMaterial({ color: 0x554a3a, emissive: 0x250000, emissiveIntensity: 0.6 })
  );
  altar.position.set(0, 0.25, -27);
  root.add(altar); // root = collidable!

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
  lamp(0, -24, { intensity: 0.7 }); // extra light in altar hallway

  // Final-choice trigger — use V key instead of G to avoid conflict with calming
  trigger(0, -27, 3, 2, { type: 'final_choice' });

  // Nav points for altar
  nav(0, -22); nav(0, -25); nav(0, -27);

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
    navPoints,
    weeperSpawns,
    horcrorSpawn,
  };
}

/** Open/close a door by interpolating its hinge rotation.
 *  Also moves blocker between root (collidable) and doorsRoot (non-collidable).
 */
export function toggleDoor(door, dt, levelRoot, doorsRoot) {
  const target = door.open ? Math.PI / 1.3 : 0;
  const k = Math.min(1, dt * 6);
  door.hinge.rotation.y += (target - door.hinge.rotation.y) * k;

  // Move blocker based on door state
  if (door.blocker) {
    if (door.open && door.blocker.parent === levelRoot) {
      levelRoot.remove(door.blocker);
      doorsRoot.add(door.blocker);
    } else if (!door.open && door.blocker.parent === doorsRoot) {
      doorsRoot.remove(door.blocker);
      levelRoot.add(door.blocker);
    }
  }
}

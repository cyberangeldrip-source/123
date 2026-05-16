/* =========================================================
 * level.js
 * Hand-authored Soviet-decay level with proper door
 * placement: every door fills an actual passage gap
 * between rooms.
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
const DOOR_W = 1.4;        // standard door width — used for both slab and gap
const DOOR_H = 2.1;

function mat(color, map, opts = {}) {
  return new THREE.MeshLambertMaterial({
    color, map: map || null,
    side: opts.side ?? THREE.FrontSide,
  });
}
function box(w, h, d, material) {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
}

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

  const TX_PLASTER = plasterTexture();

  const lampPositions = [];
  const doors = [];
  const pickups = [];
  const triggers = [];
  const surfaces = [];
  const notes = [];
  const navPoints = [];

  // ===================================================================
  // FLOOR + CEILING
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
   * Door that fills a passage gap of DOOR_W width.
   * @param {number} x,z  center of the doorway
   * @param {number} rotY  rotation of the door (0 = wall along X axis with gap; π/2 = wall along Z axis)
   */
  function door(x, z, rotY = 0, opts = {}) {
    const dgrp = new THREE.Group();
    const hinge = new THREE.Group();

    // Slab: full doorway width, pivots at left edge
    const slabGeo = new THREE.BoxGeometry(DOOR_W, DOOR_H, 0.06);
    slabGeo.translate(DOOR_W / 2, DOOR_H / 2, 0);
    const slab = new THREE.Mesh(slabGeo, mWood);
    hinge.add(slab);

    // Door handle on the swinging end
    const handle = box(0.06, 0.06, 0.18, mMetal);
    handle.position.set(DOOR_W - 0.15, 1.0, 0.06);
    hinge.add(handle);

    // Frame (top lintel)
    const frameTop = box(DOOR_W + 0.4, 0.18, 0.14, mWood);
    frameTop.position.set(DOOR_W / 2, DOOR_H + 0.10, 0);
    hinge.add(frameTop);
    // Frame side jambs
    const jambL = box(0.12, DOOR_H + 0.18, 0.14, mWood);
    jambL.position.set(-0.06, (DOOR_H + 0.18) / 2, 0);
    hinge.add(jambL);
    const jambR = box(0.12, DOOR_H + 0.18, 0.14, mWood);
    jambR.position.set(DOOR_W + 0.06, (DOOR_H + 0.18) / 2, 0);
    hinge.add(jambR);

    // Hinge pivot is at left edge of doorway → place hinge at -DOOR_W/2 in local space
    hinge.position.set(-DOOR_W / 2, 0, 0);
    dgrp.add(hinge);
    dgrp.position.set(x, 0, z);
    dgrp.rotation.y = rotY;

    // Invisible blocker that fills the entire doorway when closed.
    // NOTE: We DO NOT add this blocker to any collidable scene group anymore.
    // The level octree is built only from the static geometry (walls, floor,
    // furniture) and never needs to be rebuilt when doors open/close.
    // Closed-door collision is handled separately via blocker.boxAABB
    // by Player and AI. This eliminates the per-door octree rebuild stutter.
    const blockerGeo = new THREE.BoxGeometry(DOOR_W, 2.4, 0.22);
    const blockerMat = new THREE.MeshBasicMaterial({ visible: false });
    const blocker = new THREE.Mesh(blockerGeo, blockerMat);
    blocker.position.set(x, 1.2, z);
    blocker.rotation.y = rotY;
    blocker.updateMatrixWorld(true);
    // Pre-compute world-space AABB used for closed-door collision tests.
    // All doors rotate by 0 or +/- pi/2 so this AABB is exact, not an over-estimate.
    const blockerBox = new THREE.Box3().setFromObject(blocker);

    // ----- Transom (wall above the door) -----
    // Door frame top sits at y = DOOR_H + 0.18 = 2.28m; ceiling is at WALL_H = 3.0m
    // → vertical gap of ~0.72m above the door used to be empty. Fill it with a
    // wall slab so the room properly closes off above the doorway.
    const transomH  = WALL_H - (DOOR_H + 0.18);
    const transomY  = (DOOR_H + 0.18) + transomH / 2;
    const transomMat = tiledMat(TX_PLASTER, Math.max(1, (DOOR_W + 0.4) / 2.5), Math.max(1, transomH / 2.5));
    const transom = new THREE.Mesh(
      new THREE.BoxGeometry(DOOR_W + 0.4, transomH, WALL_T),
      transomMat
    );
    transom.position.set(x, transomY, z);
    transom.rotation.y = rotY;
    root.add(transom);

    doorsRoot.add(dgrp);
    // blocker is intentionally NOT added to root or doorsRoot — see comment
    // above. It exists only as a Mesh to provide its AABB for collision tests.

    const doorObj = {
      group: dgrp, hinge, slab, blocker, blockerBox, open: false,
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

    // pedestal (rusty crate) — sits on the floor under the pickup. Added to
    // root so it has collision (the player should not be able to walk through
    // crates). It stays even after the pickup is taken.
    const ped = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.85, 0.5),
      mMetal
    );
    ped.position.set(x, 0.42, z);
    root.add(ped);
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

  /** Wall-mounted note. wallOffset pushes the note slightly forward along its facing direction. */
  function noteOnWall(x, z, rotY, textKey, wallOffset = 0.06) {
    const g = new THREE.PlaneGeometry(0.55, 0.38);
    const mesh = new THREE.Mesh(g, mNote);
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

  /** Locker stands flush against a wall — wallSide is 'N','S','E','W' to flush properly. */
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
  //  ZONE 1 — КПП  (z ∈ [12..22], x ∈ [-8..8])
  //  Spawn at (0, 0, 18) facing north.
  //  South wall is locked (front door — atmospheric only).
  //  North wall has the exit-to-corridor door.
  // ===================================================================

  // South outer wall (z=22). Gap of DOOR_W centered at x=0 for the locked front door.
  // Wall-left covers x=-8..-0.7  → center=-4.35, width=7.3
  wall(-4.35, 22, 7.3, WALL_T);
  // Wall-right covers x=0.7..8   → center=4.35, width=7.3
  wall( 4.35, 22, 7.3, WALL_T);
  door(0, 22, 0, { id: 'front_door', locked: true });

  // North wall (z=12). Gap centered at x=0 for the exit door.
  wall(-4.35, 12, 7.3, WALL_T);
  wall( 4.35, 12, 7.3, WALL_T);
  door(0, 12, 0, { id: 'kpp_exit' });

  // East/West outer walls
  wall( 8, 17, WALL_T, 10);
  wall(-8, 17, WALL_T, 10);

  // Pickups in KPP — clearly placed on pedestals against the walls
  pickupBox(-5, 19, 'flashlight', RU.item_flashlight);
  pickupBox( 5, 19, 'recorder',   RU.item_recorder);
  pickupBox(-3, 14, 'tape',       RU.tape_1);

  // Notes (offset forward 0.06m so they don't z-fight)
  noteOnWall(-7.9, 18,  Math.PI / 2,  'note_kpp_1');   // on west wall, faces east
  noteOnWall( 7.9, 14, -Math.PI / 2,  'note_kpp_2');   // on east wall, faces west

  // Furniture — benches near the pickups, lockers along the corners
  bench(-5, 18.2);
  bench( 5, 18.2);
  locker(-7.4, 13.5);
  locker(-7.4, 14.5);
  locker( 7.4, 13.5);
  locker( 7.4, 14.5);

  // Lamps
  lamp(-4, 19, { intensity: 1.2 });
  lamp( 4, 19, { intensity: 1.2 });
  lamp( 0, 18, { intensity: 1.0 });
  lamp( 0, 14, { broken: true, intensity: 0.7 });

  // Nav
  nav(0, 18); nav(0, 14); nav(-5, 18); nav(5, 18);

  // ===================================================================
  //  ZONE 2 — CORRIDOR (z ∈ [-2..12], x ∈ [-3..3])
  // ===================================================================
  wall(-3, 5, WALL_T, 14);
  wall( 3, 5, WALL_T, 14);

  // Pipes overhead
  for (let z = 11; z >= -1; z -= 2) pipe(-2.7, z, 0.4);
  for (let z = 11; z >= -1; z -= 2) pipe( 2.7, z, 0.4);

  // Lamps
  lamp(0, 10, { intensity: 1.0 });
  lamp(0, 6,  { broken: true, intensity: 0.6 });
  lamp(0, 2,  { red: true, intensity: 1.4, distance: 8 });
  lamp(0, -1, { intensity: 0.8 });

  // Pickups — placed deliberately near walls
  pickupBox(-2, 8, 'flashlight_battery', RU.item_flash_battery);
  pickupBox( 2, 4, 'recorder_battery',   RU.item_rec_battery);

  // Triggers
  trigger(0, 4, 4, 2, { type: 'subtitle', text: RU.trig_breath, once: true });
  trigger(0, 11, 4, 2, { type: 'subtitle', text: RU.trig_first_red, once: true });
  noteOnWall(-2.85, 7, Math.PI / 2, 'note_corridor');

  // Nav
  nav(0, 10); nav(0, 6); nav(0, 2); nav(0, -1);

  // ===================================================================
  //  ZONE 3 — RESIDENTIAL HUB (z ∈ [-22..-2], x ∈ [-12..12])
  //  Center hallway: x ∈ [-6..6], z ∈ [-2..-22]
  //  4 apartments around it. Each apt has a door in its inner wall.
  // ===================================================================

  // Hub south wall (z=-2). The corridor (x=-3..3) is the natural opening here — no door.
  // Wall covers x=-12..-3 and x=3..12.
  wall(-7.5, -2, 9, WALL_T); // x=-12..-3
  wall( 7.5, -2, 9, WALL_T); // x= 3..12

  // Hub west outer wall (x=-12, z=-2..-22)
  wall(-12, -12, WALL_T, 20);
  // Hub east outer wall (x= 12)
  wall( 12, -12, WALL_T, 20);

  // Hub north wall (z=-22) with a 1.4m gap at x=0 for the altar door
  wall(-6.7, -22, 10.6, WALL_T); // x=-12..-1.4
  wall( 6.7, -22, 10.6, WALL_T); // x= 1.4..12
  // Fill narrow gaps between main walls and the door frame (0.7m each side)
  wall(-1.05, -22, 0.7, WALL_T); // x=-1.4..-0.7
  wall( 1.05, -22, 0.7, WALL_T); // x= 0.7..1.4
  door(0, -22, 0, { id: 'altar_door' });

  // ----- SW Apartment (x=-12..-6, z=-2..-12) -----
  // Inner east wall (x=-6, z=-2..-12) split with a door at z=-7 (1.4m gap z=-6.3..-7.7)
  wall(-6, -4.15, WALL_T, 4.3); // z=-2..-6.3
  wall(-6, -9.85, WALL_T, 4.3); // z=-7.7..-12
  door(-6, -7, Math.PI / 2, { id: 'apt_sw' });
  // North wall separating SW from NW (z=-12, x=-12..-6) — full wall (apts isolated)
  wall(-9, -12, 6, WALL_T);
  // SW interior: pickup (TAPE 2), bench, lockers
  pickupBox(-9, -8, 'tape', RU.tape_2);
  bench(-10, -5);
  locker(-11.6, -10);
  noteOnWall(-11.85, -8, Math.PI / 2, 'note_apt');

  // ----- SE Apartment (x=6..12, z=-2..-12) -----
  wall(6, -4.15, WALL_T, 4.3);
  wall(6, -9.85, WALL_T, 4.3);
  door(6, -7, -Math.PI / 2, { id: 'apt_se' });
  wall(9, -12, 6, WALL_T);
  pickupBox( 9, -8, 'flashlight_battery', RU.item_flash_battery);
  bench(10, -5);
  locker(11.6, -10);

  // ----- NW Apartment (x=-12..-6, z=-12..-22) -----
  wall(-6, -14.15, WALL_T, 4.3); // z=-12..-16.3
  wall(-6, -19.85, WALL_T, 4.3); // z=-17.7..-22
  door(-6, -17, Math.PI / 2, { id: 'apt_nw' });
  pickupBox(-9, -18, 'tape', RU.tape_3);
  bench(-10, -15);
  locker(-11.6, -20);
  noteOnWall(-11.85, -18, Math.PI / 2, 'note_basement');

  // Bathroom tile patch (NW apt)
  const tileFloor = new THREE.Mesh(
    new THREE.PlaneGeometry(3, 3),
    mTile
  );
  tileFloor.rotation.x = -Math.PI / 2;
  tileFloor.position.set(-10, 0.005, -20);
  root.add(tileFloor);
  surfaces.push({ mesh: tileFloor, type: 'tile' });

  // ----- NE Apartment (x=6..12, z=-12..-22) -----
  wall(6, -14.15, WALL_T, 4.3);
  wall(6, -19.85, WALL_T, 4.3);
  door(6, -17, -Math.PI / 2, { id: 'apt_ne' });
  pickupBox( 9, -19, 'tape', RU.tape_F);                    // FINAL tape
  pickupBox( 9, -15, 'recorder_battery', RU.item_rec_battery);
  bench(10, -15);
  locker(11.6, -20);

  // Hub courtyard lamps
  lamp( 0, -4,  { intensity: 0.9 });
  lamp(-3, -7,  { intensity: 0.7 });
  lamp( 3, -7,  { intensity: 0.7 });
  lamp( 0, -12, { red: true, intensity: 1.5, distance: 9 });
  lamp(-3, -17, { intensity: 0.7 });
  lamp( 3, -17, { intensity: 0.7 });
  lamp( 0, -20, { red: true, intensity: 1.5, distance: 8 });

  // Apartment lamps
  lamp(-9, -6,  { intensity: 0.8 });
  lamp(-9, -10, { broken: true, intensity: 0.6 });
  lamp( 9, -6,  { intensity: 0.8 });
  lamp( 9, -10, { intensity: 0.8 });
  lamp(-9, -16, { intensity: 0.7 });
  lamp(-9, -20, { broken: true, intensity: 0.6 });
  lamp( 9, -16, { intensity: 0.8 });
  lamp( 9, -20, { intensity: 0.7 });

  // (No center-of-hub bench — it blocked AI pathing through the central hallway)

  // Nav points throughout the hub + apartments
  nav(0, -4);  nav(0, -8);  nav(0, -12); nav(0, -16); nav(0, -20);
  nav(-3, -7); nav( 3, -7); nav(-3, -17); nav( 3, -17);
  nav(-9, -7); nav( 9, -7); nav(-9, -17); nav( 9, -17);
  nav(-6, -7); nav( 6, -7); nav(-6, -17); nav( 6, -17); // door waypoints
  nav(0, -2);  // corridor-hub junction

  // ===================================================================
  //  ZONE 4 — ALTAR ROOM (z=-22..-28, x=-3..3)
  // ===================================================================
  wall(-3, -25, WALL_T, 6);
  wall( 3, -25, WALL_T, 6);
  wall(0, -28, 6, WALL_T);

  // Altar plinth — added to ROOT for collision
  const altar = new THREE.Mesh(
    new THREE.BoxGeometry(1.4, 0.5, 0.8),
    new THREE.MeshLambertMaterial({ color: 0x554a3a, emissive: 0x250000, emissiveIntensity: 0.6 })
  );
  altar.position.set(0, 0.25, -27);
  root.add(altar);

  // Candles on top of the altar (sit on its surface, height 0.5m)
  for (const dx of [-0.5, 0.5]) {
    for (const dz of [-0.3, 0.3]) {
      const candle = new THREE.Mesh(
        new THREE.CylinderGeometry(0.03, 0.03, 0.18, 6),
        new THREE.MeshLambertMaterial({ color: 0xddc88a, emissive: 0xff8000, emissiveIntensity: 1.0 })
      );
      candle.position.set(dx, 0.59, -27 + dz);
      doorsRoot.add(candle);
    }
  }
  lamp(0, -27, { red: true, intensity: 1.3, distance: 5 });
  lamp(0, -24, { intensity: 0.7 });

  trigger(0, -27, 3, 2, { type: 'final_choice' });
  nav(0, -25); nav(0, -27);

  // ===================================================================
  //  Spawn / AI anchors
  // ===================================================================
  const spawn = new THREE.Vector3(0, 0, 18);
  // Weepers removed — only the Horcror entity remains.
  const weeperSpawns = [];
  const horcrorSpawn = new THREE.Vector3(0, 0, -16);  // hub center

  return {
    root, doorsRoot, spawn, lampPositions, doors, pickups,
    triggers, surfaces, notes, navPoints, weeperSpawns, horcrorSpawn,
  };
}

/** Animate a door's rotation. Returns false — door collision is handled
 *  separately via doors[].blockerBox / doors[].open, so the level octree
 *  never needs rebuilding on door state changes. (Kept the return signature
 *  so existing callers don't break — they will simply never trigger the
 *  expensive rebuild path anymore.)
 */
export function toggleDoor(door, dt /* unused: levelRoot, doorsRoot */) {
  const target = door.open ? Math.PI / 1.3 : 0;
  const k = Math.min(1, dt * 6);
  door.hinge.rotation.y += (target - door.hinge.rotation.y) * k;
  return false;
}

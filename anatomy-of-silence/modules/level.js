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
  woodTexture, doorTexture, metalTexture, ceilingTexture, noteTexture,
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
  // Door slab uses its own texture (textures/door.png) so a custom door
  // image shows up ONLY on doors, not on benches or anywhere else.
  // ClampToEdgeWrapping + repeat=(1,1) GUARANTEES the image is shown
  // exactly once across the slab face — no tiling at top/bottom even if
  // the user's PNG has odd pixel dimensions or the texture transform
  // gets rounded by the GPU.
  const _doorTex = doorTexture();
  _doorTex.wrapS = THREE.ClampToEdgeWrapping;
  _doorTex.wrapT = THREE.ClampToEdgeWrapping;
  _doorTex.repeat.set(1, 1);
  _doorTex.offset.set(0, 0);
  _doorTex.needsUpdate = true;
  const mDoor     = mat(0xffffff, _doorTex);
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
  function wall(x, z, w, d, m = mPlaster, h = WALL_H, y) {
    // y defaults to h / 2 (wall sits on the floor). Pass an explicit y to
    // place a wall slab at a custom vertical position — used for the
    // lintel above doorways (see wallWithDoor).
    if (y === undefined) y = h / 2;
    let useMat = m;
    if (m === mPlaster) {
      const longest = Math.max(w, d);
      if (longest > 1.5) {
        // Tile density: roughly 1 tile per 2.5m on both axes. No min Y
        // clamp (only a tiny safety floor of 0.25) so that a short upper
        // wall slab (0.7m above a doorway) shows the same physical tile
        // size as the full-height walls below it. With the old min=1
        // clamp the lintel showed one whole tile crammed into 0.7m,
        // which made it visually "zoomed in" relative to its neighbors.
        useMat = tiledMat(
          TX_PLASTER,
          Math.max(1,    longest / 2.5),
          Math.max(0.25, h       / 2.5)
        );
      }
    }
    const wmesh = box(w, h, d, useMat);
    wmesh.position.set(x, y, z);
    root.add(wmesh);
    return wmesh;
  }

  /**
   * Build a wall that contains a door without leaving a visible "patch"
   * above the doorway.
   *
   * Instead of placing a small standalone transom box just over the door
   * (which reads as a clearly different mesh — different tile alignment,
   * different thickness, etc.) we split the wall horizontally:
   *
   *   - Lower portion (y = 0 .. TOP_BREAK):  two segments left and right
   *     of the door, with a gap of DOOR_W in the middle for the door slab.
   *   - Upper portion (y = TOP_BREAK .. WALL_H):  a SINGLE continuous slab
   *     spanning the whole wall, with no gap.
   *
   * The two pieces share the same plaster material with the same tile
   * density, so visually the wall just continues unbroken over the top
   * of the door — exactly the "продлить стену сверху" the user asked for.
   *
   * Bonus: passing an explicit [start, end] span eliminates the off-by-one
   * arithmetic mistakes that previously left two visible holes flanking
   * the altar door (the wall segments were sized for the narrower KPP
   * span instead of the wider hub span).
   *
   * @param {[number, number]} span     [start, end] coords along the wall's axis.
   * @param {number}           perp     The perpendicular coord (z if axis='x', x if axis='z').
   * @param {'x' | 'z'}        axis     Direction the wall runs.
   * @param {number}           doorAt   Position along axis where door center sits.
   * @param {number}           doorRot  Rotation passed to door().
   * @param {object}           doorOpts Options forwarded to door().
   */
  function wallWithDoor(span, perp, axis, doorAt, doorRot, doorOpts = {}) {
    // The door's wooden frame top sits at y = DOOR_H + 0.10..0.28
    // (height 0.18). TOP_BREAK is set comfortably above that so the
    // upper wall slab never z-fights with the frame.
    const FRAME_CLEAR = 0.20;
    const TOP_BREAK   = DOOR_H + FRAME_CLEAR;     // 2.30m
    const lowerH      = TOP_BREAK;
    const upperH      = WALL_H - TOP_BREAK;       // 0.70m
    const upperY      = TOP_BREAK + upperH / 2;

    const leftEnd    = doorAt - DOOR_W / 2;
    const rightStart = doorAt + DOOR_W / 2;

    // ---- lower segments ----
    if (leftEnd > span[0] + 0.001) {
      const segW = leftEnd - span[0];
      const segC = (span[0] + leftEnd) / 2;
      if (axis === 'x') wall(segC, perp, segW,   WALL_T, mPlaster, lowerH);
      else              wall(perp, segC, WALL_T, segW,   mPlaster, lowerH);
    }
    if (span[1] > rightStart + 0.001) {
      const segW = span[1] - rightStart;
      const segC = (rightStart + span[1]) / 2;
      if (axis === 'x') wall(segC, perp, segW,   WALL_T, mPlaster, lowerH);
      else              wall(perp, segC, WALL_T, segW,   mPlaster, lowerH);
    }

    // ---- upper continuous lintel slab (full wall span, no gap) ----
    const fullW = span[1] - span[0];
    const fullC = (span[0] + span[1]) / 2;
    if (axis === 'x') wall(fullC, perp, fullW,  WALL_T, mPlaster, upperH, upperY);
    else              wall(perp, fullC, WALL_T, fullW,  mPlaster, upperH, upperY);

    // ---- door (NB: door() no longer draws a transom of its own) ----
    if (axis === 'x') return door(doorAt, perp, doorRot, doorOpts);
    else              return door(perp, doorAt, doorRot, doorOpts);
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

    // Slab: full doorway width, pivots at left edge.
    //
    // The slab is a box 1.4m × 2.1m × 0.06m. Three.js's BoxGeometry maps
    // the texture to ALL SIX faces with [0..1] UVs, which means the
    // four narrow side strips (top/bottom/left edge/right edge — each
    // only 6cm thick) also try to show the full door image squashed
    // into a thin sliver. From an angle that reads as smeared garbage
    // bleeding off the door.
    //
    // Fix: hand the box a per-face material array. Front and back show
    // mDoor (textures/door.png, fully stretched). The four narrow side
    // faces use a plain dark wood-tone material so the player sees
    // 'door slab with painted faces and dark edges' instead of
    // 'distorted door wrapped around a box'.
    //
    // BoxGeometry material slot order is [+X, -X, +Y, -Y, +Z, -Z].
    // Width is X, Height is Y, Depth is Z, so the door's faces are +Z
    // and -Z (the 1.4×2.1 ones). Everything else is a thin edge.
    const mSlabEdge = new THREE.MeshLambertMaterial({ color: 0x2a1a10 });
    const slabMats = [
      mSlabEdge, // +X (right edge of slab)
      mSlabEdge, // -X (hinge edge)
      mSlabEdge, // +Y (top edge)
      mSlabEdge, // -Y (bottom edge)
      mDoor,     // +Z (front)
      mDoor,     // -Z (back)
    ];
    const slabGeo = new THREE.BoxGeometry(DOOR_W, DOOR_H, 0.06);
    slabGeo.translate(DOOR_W / 2, DOOR_H / 2, 0);
    const slab = new THREE.Mesh(slabGeo, slabMats);
    hinge.add(slab);

    // (Physical handle removed — the door texture itself includes a
    //  painted handle on the user's PNG, and stacking a 3D box-handle
    //  on top of it just looked like two handles.)

    // Door frame (top lintel + side jambs) intentionally REMOVED.
    // wallWithDoor() already paints:
    //   - two plaster wall segments LEFT and RIGHT of the doorway,
    //     spanning floor → 2.30m (the lower portion of the wall).
    //   - one continuous plaster lintel above the door spanning the
    //     full wall length (the upper portion).
    // So the wall geometry alone already closes the opening cleanly
    // around the door slab. Adding wooden trim on top of that gave us
    // the black-frame bug the user kept seeing on the jambs/lintel,
    // and the trim never quite read as "door wood" without a dedicated
    // frame texture. Easier to just drop it. If we ever want a real
    // wooden frame again, re-add three boxes of mWood (or a future
    // mFrame material) here — there is no other state to restore.

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

    // ----- Lintel above the door is now drawn by wallWithDoor() as a
    // single continuous wall slab spanning the full wall length, so that
    // the wall visually "continues over" the doorway with no patch seam.
    // door() itself no longer adds a transom of its own — adding one
    // would z-fight with the lintel slab from wallWithDoor().

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

  // South outer wall (z=22) with the locked front door at x=0.
  // Span x=[-8..8], so the door's flanking wall pieces are sized
  // automatically. The wall continues unbroken above the doorway.
  wallWithDoor([-8, 8], 22, 'x', 0, 0, { id: 'front_door', locked: true });

  // North wall (z=12) with the exit-to-corridor door at x=0.
  wallWithDoor([-8, 8], 12, 'x', 0, 0, { id: 'kpp_exit' });

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

  // Hub north wall (z=-22) with a 1.4m gap at x=0 for the altar door.
  // Span is the full hub width x=[-12..12] — wallWithDoor() sizes the
  // flanking segments correctly, no manual arithmetic. (Previous fix
  // used the narrower KPP span [-8..8] by mistake, leaving 3m holes
  // at each end of the hub's north wall.)
  wallWithDoor([-12, 12], -22, 'x', 0, 0, { id: 'altar_door' });

  // ----- SW Apartment (x=-12..-6, z=-2..-12) -----
  // Inner east wall (x=-6) runs along z=[-2..-12] with door at z=-7.
  wallWithDoor([-12, -2], -6, 'z', -7, Math.PI / 2, { id: 'apt_sw' });
  // North wall separating SW from NW (z=-12, x=-12..-6) — full wall (apts isolated)
  wall(-9, -12, 6, WALL_T);
  // SW interior: pickup (TAPE 2), bench, lockers
  pickupBox(-9, -8, 'tape', RU.tape_2);
  bench(-10, -5);
  locker(-11.6, -10);
  noteOnWall(-11.85, -8, Math.PI / 2, 'note_apt');

  // ----- SE Apartment (x=6..12, z=-2..-12) -----
  wallWithDoor([-12, -2], 6, 'z', -7, -Math.PI / 2, { id: 'apt_se' });
  wall(9, -12, 6, WALL_T);
  pickupBox( 9, -8, 'flashlight_battery', RU.item_flash_battery);
  bench(10, -5);
  locker(11.6, -10);

  // ----- NW Apartment (x=-12..-6, z=-12..-22) -----
  wallWithDoor([-22, -12], -6, 'z', -17, Math.PI / 2, { id: 'apt_nw' });
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
  wallWithDoor([-22, -12], 6, 'z', -17, -Math.PI / 2, { id: 'apt_ne' });
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

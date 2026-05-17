/* =========================================================
 * level.js
 *
 * Soviet-decay level. Single source of truth for the world
 * geometry — every doorway is built through wallWithDoor()
 * so wall segments are sized automatically and never
 * misalign with the door slab.
 *
 * Surface (y=0):
 *   ZONE 1: КПП                       (x∈[-8..8],   z∈[12..22])
 *   ZONE 2: corridor                  (x∈[-3..3],   z∈[-2..12])
 *   ZONE 3: residential hub + 4 apts  (x∈[-12..12], z∈[-22..-2])
 *   ZONE 4: altar room                (x∈[-3..3],   z∈[-28..-22])
 *   ZONE 5: West wing — диспетчерская (x∈[-22..-12], z∈[-18..-8])
 *   ZONE 6: East wing — морг          (x∈[12..22],   z∈[-18..-8])
 *
 * Basement (y=BASEMENT_Y .. BASEMENT_CEIL_Y):
 *   ZONE 7: затопленный подвал        (x∈[-18..-2], z∈[-22..-10])
 *
 * Keys:
 *   key_basement → opens hatch in NW apartment (descend to basement)
 *   key_storage  → opens east wing door (морг)
 * ========================================================= */

import * as THREE from 'three';
import {
  concreteTexture, plasterTexture, tileTexture,
  woodTexture, doorTexture, metalTexture, ceilingTexture, noteTexture,
} from './textures.js';
import { RU } from './i18n.js';

const WALL_H          = 3.0;
const WALL_T          = 0.2;
const DOOR_W          = 1.4;        // standard door width — used for both slab and gap
const DOOR_H          = 2.1;
const BASEMENT_Y      = -3.5;       // basement floor
const BASEMENT_CEIL_Y = -0.6;       // basement ceiling
const WATER_Y         = -3.35;      // water surface plane Y
const BASEMENT_DOOR_H = 1.9;        // shorter door for basement (lower ceiling)

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

  const mConcrete     = mat(0xffffff, concreteTexture());
  const mPlaster      = mat(0xffffff, plasterTexture());
  const mTile         = mat(0xffffff, tileTexture());
  const mWood         = mat(0xffffff, woodTexture());

  // Door slab uses its own texture (textures/door.png).
  // ClampToEdgeWrapping + repeat=(1,1) shows the image once across the slab.
  const _doorTex = doorTexture();
  _doorTex.wrapS = THREE.ClampToEdgeWrapping;
  _doorTex.wrapT = THREE.ClampToEdgeWrapping;
  _doorTex.repeat.set(1, 1);
  _doorTex.offset.set(0, 0);
  _doorTex.needsUpdate = true;
  const mDoor         = mat(0xffffff, _doorTex);

  const mMetal        = mat(0xffffff, metalTexture());
  const mCeil         = mat(0xffffff, ceilingTexture());
  const mNote         = mat(0xffffff, noteTexture());

  // Darker concrete for the basement floor + ceiling
  const mDarkConcrete = new THREE.MeshLambertMaterial({ color: 0x4a4640, map: concreteTexture() });
  // Rusted metal for the hatch
  const mRust         = new THREE.MeshLambertMaterial({ color: 0x6a4a30 });

  const TX_PLASTER    = plasterTexture();

  const lampPositions  = [];
  const doors          = [];
  const hatches        = [];
  const pickups        = [];
  const triggers       = [];
  const surfaces       = [];
  const surfaceRegions = []; // {min:Vec2, max:Vec2, type, yMin, yMax}
  const notes          = [];
  const navPoints      = [];

  // ===================================================================
  // FLOOR + CEILING (surface — area roughly doubled)
  // ===================================================================
  const FLOOR_SIZE = 110;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE), mConcrete);
  floor.rotation.x = -Math.PI / 2;
  root.add(floor);
  surfaces.push({ mesh: floor, type: 'concrete' });

  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE), mCeil);
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = WALL_H;
  root.add(ceil);

  // ===================================================================
  // BUILDERS
  // ===================================================================

  /** Wall slab.
   *  @param x,z       wall center on the floor
   *  @param w,d       footprint (one of them is WALL_T)
   *  @param m         material (default plaster, auto-tiled if longest side > 1.5m)
   *  @param h         wall height
   *  @param y         explicit center Y (overrides yBase + h/2). Use this for lintels.
   *  @param yBase     floor Y for this wall (0 surface, BASEMENT_Y in basement)
   */
  function wall(x, z, w, d, m = mPlaster, h = WALL_H, y, yBase = 0) {
    if (y === undefined) y = yBase + h / 2;
    let useMat = m;
    if (m === mPlaster) {
      const longest = Math.max(w, d);
      if (longest > 1.5) {
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
   * Build a wall span that contains a single door, with a continuous
   * lintel above the doorway so the wall reads as unbroken.
   *
   * Works on both surface (yBase=0) and basement (yBase=BASEMENT_Y).
   * The door's height adapts to the local ceiling.
   *
   * Layout (axis='x'):
   *
   *      perp ─►
   *       ┌──────────────────────────────────────────┐  ← lintel slab (one piece)
   *       │   wall    │  door  │       wall          │  ← lower segments + door gap
   *       └────────────────────┘──────────────────────┘
   *      span[0]      doorAt              span[1]
   *
   * @param {[number, number]} span     [start, end] coords along wall axis.
   * @param {number}           perp     Perpendicular coord (z if axis='x', x if axis='z').
   * @param {'x' | 'z'}        axis     Wall axis.
   * @param {number}           doorAt   Position along axis where door center sits.
   * @param {number}           doorRot  Rotation passed to door().
   * @param {object}           doorOpts Options forwarded to door().
   *                                    Pass { yBase: BASEMENT_Y } for basement walls.
   */
  function wallWithDoor(span, perp, axis, doorAt, doorRot, doorOpts = {}) {
    const yBase      = doorOpts.yBase || 0;
    const inBasement = yBase < 0;
    const wallH      = inBasement ? (BASEMENT_CEIL_Y - BASEMENT_Y) : WALL_H;
    const dH         = inBasement ? BASEMENT_DOOR_H : DOOR_H;

    const FRAME_CLEAR = 0.20;
    const TOP_BREAK   = dH + FRAME_CLEAR;          // lower height
    const lowerH      = TOP_BREAK;
    const upperH      = wallH - TOP_BREAK;
    const upperY      = yBase + TOP_BREAK + upperH / 2;

    const leftEnd    = doorAt - DOOR_W / 2;
    const rightStart = doorAt + DOOR_W / 2;

    // Sanity check: door must fit inside the span. If it doesn't, log a
    // warning so misaligned levels are caught early instead of producing
    // doors clipping into walls.
    if (leftEnd < span[0] - 0.001 || rightStart > span[1] + 0.001) {
      // eslint-disable-next-line no-console
      console.warn(
        `[level] wallWithDoor: door at ${doorAt} (gap ${leftEnd}..${rightStart}) ` +
        `does not fit in span [${span[0]}..${span[1]}] on axis '${axis}', perp=${perp}`
      );
    }

    // ---- lower segments (left and right of the door gap) ----
    if (leftEnd > span[0] + 0.001) {
      const segW = leftEnd - span[0];
      const segC = (span[0] + leftEnd) / 2;
      if (axis === 'x') wall(segC, perp, segW,   WALL_T, mPlaster, lowerH, undefined, yBase);
      else              wall(perp, segC, WALL_T, segW,   mPlaster, lowerH, undefined, yBase);
    }
    if (span[1] > rightStart + 0.001) {
      const segW = span[1] - rightStart;
      const segC = (rightStart + span[1]) / 2;
      if (axis === 'x') wall(segC, perp, segW,   WALL_T, mPlaster, lowerH, undefined, yBase);
      else              wall(perp, segC, WALL_T, segW,   mPlaster, lowerH, undefined, yBase);
    }

    // ---- upper continuous lintel slab (full wall span, no gap) ----
    if (upperH > 0.05) {
      const fullW = span[1] - span[0];
      const fullC = (span[0] + span[1]) / 2;
      if (axis === 'x') wall(fullC, perp, fullW,  WALL_T, mPlaster, upperH, upperY, yBase);
      else              wall(perp, fullC, WALL_T, fullW,  mPlaster, upperH, upperY, yBase);
    }

    // ---- door (no transom — wallWithDoor draws the lintel) ----
    if (axis === 'x') return door(doorAt, perp, doorRot, doorOpts);
    else              return door(perp, doorAt, doorRot, doorOpts);
  }

  function lamp(x, z, opts = {}) {
    const y = opts.y ?? (WALL_H - 0.18);
    lampPositions.push({ pos: new THREE.Vector3(x, y, z), opts });
  }

  /**
   * Door slab + frame at (x,z), rotated by rotY around Y.
   *
   *   - The slab is exactly DOOR_W wide so it fills the gap left by
   *     wallWithDoor() with no overlap and no z-fighting.
   *   - The slab uses a per-face material array so the door image only
   *     appears on the +Z and -Z faces; the four narrow side strips get
   *     a plain dark wood-tone material.
   *   - Frame top + side jambs reuse mDoor for visual continuity.
   *   - An invisible AABB blocker provides closed-door collision via
   *     blockerBox; it is NOT added to the scene graph so the octree
   *     never has to be rebuilt when a door swings open.
   *
   * Doors never draw their own transom — wallWithDoor() handles the
   * lintel above the doorway. (Standalone door() callers should not
   * exist; everything in this level routes through wallWithDoor.)
   *
   * @param opts.id            string id for save state
   * @param opts.locked        bool — refuses to open without a key
   * @param opts.requiredKey   key id needed to unlock
   * @param opts.yBase         floor Y for the door (0 surface, BASEMENT_Y basement)
   */
  function door(x, z, rotY = 0, opts = {}) {
    const yBase      = opts.yBase || 0;
    const inBasement = yBase < 0;
    const dH         = inBasement ? BASEMENT_DOOR_H : DOOR_H;

    const dgrp  = new THREE.Group();
    const hinge = new THREE.Group();

    // Slab (per-face materials so the door image only paints the wide faces)
    const mSlabEdge = new THREE.MeshLambertMaterial({ color: 0x2a1a10 });
    const slabMats = [
      mSlabEdge, // +X (right edge)
      mSlabEdge, // -X (hinge edge)
      mSlabEdge, // +Y (top edge)
      mSlabEdge, // -Y (bottom edge)
      mDoor,     // +Z (front)
      mDoor,     // -Z (back)
    ];
    const slabGeo = new THREE.BoxGeometry(DOOR_W, dH, 0.06);
    slabGeo.translate(DOOR_W / 2, dH / 2, 0);
    const slab = new THREE.Mesh(slabGeo, slabMats);
    hinge.add(slab);

    // Frame (top lintel + side jambs) — wood-textured trim that matches
    // the painted door slab so the trim doesn't look like a separate part.
    const frameTop = box(DOOR_W, 0.18, 0.14, mDoor);
    frameTop.position.set(DOOR_W / 2, dH + 0.10, 0);
    hinge.add(frameTop);
    const JAMB_W = 0.10;
    const jambL = box(JAMB_W, dH + 0.18, 0.14, mDoor);
    jambL.position.set(JAMB_W / 2, (dH + 0.18) / 2, 0);
    hinge.add(jambL);
    const jambR = box(JAMB_W, dH + 0.18, 0.14, mDoor);
    jambR.position.set(DOOR_W - JAMB_W / 2, (dH + 0.18) / 2, 0);
    hinge.add(jambR);

    // Hinge pivot at left edge of doorway
    hinge.position.set(-DOOR_W / 2, 0, 0);
    dgrp.add(hinge);
    dgrp.position.set(x, yBase, z);
    dgrp.rotation.y = rotY;

    // Invisible collision blocker — same XY footprint as the slab, slightly
    // taller. NOT added to any parent (so the octree never picks it up);
    // we use only its world-space AABB for closed-door collision tests.
    const blockerH = dH + 0.3;
    const blockerGeo = new THREE.BoxGeometry(DOOR_W, blockerH, 0.22);
    const blockerMat = new THREE.MeshBasicMaterial({ visible: false });
    const blocker = new THREE.Mesh(blockerGeo, blockerMat);
    blocker.position.set(x, yBase + blockerH / 2, z);
    blocker.rotation.y = rotY;
    blocker.updateMatrixWorld(true);
    const blockerBox = new THREE.Box3().setFromObject(blocker);

    doorsRoot.add(dgrp);

    const doorObj = {
      group: dgrp, hinge, slab, blocker, blockerBox, open: false,
      worldPos: new THREE.Vector3(x, yBase + 1, z),
      yBase,
      ...opts,
    };
    doors.push(doorObj);
    return doorObj;
  }

  /** Hatch: horizontal trap-door in the floor that teleports the player. */
  function hatch(x, z, opts = {}) {
    const grp = new THREE.Group();
    const panel = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.08, 1.2), mRust);
    panel.position.y = 0.04;
    grp.add(panel);

    // Decorative bolts
    for (const dx of [-0.5, 0.5]) {
      for (const dz of [-0.5, 0.5]) {
        const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.03, 6), mMetal);
        bolt.position.set(dx, 0.085, dz);
        grp.add(bolt);
      }
    }
    // Recessed handle ring
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.02, 6, 16), mMetal);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.085;
    grp.add(ring);

    const yBase = opts.yBase || 0;
    grp.position.set(x, yBase, z);
    doorsRoot.add(grp);

    const obj = {
      kind: 'hatch',
      group: grp,
      panel,
      worldPos: new THREE.Vector3(x, yBase + 0.5, z),
      open: false,
      target: opts.target,
      direction: opts.direction,   // 'down' or 'up'
      requiredKey: opts.requiredKey || null,
      label: opts.label || 'ОТКРЫТЬ ЛЮК',
      id: opts.id,
    };
    hatches.push(obj);
    return obj;
  }

  function pickupBox(x, z, type, label, opts = {}) {
    const colors = {
      flashlight_battery: 0xc8b04a,
      recorder_battery:   0x88aa44,
      tape:               0x6e6e6e,
      flashlight:         0x886633,
      recorder:           0x444444,
      key:                0xb8a060,
    };
    const yBase = opts.yBase || 0;
    const g = new THREE.BoxGeometry(0.20, 0.10, 0.12);
    const m = new THREE.MeshLambertMaterial({
      color: colors[type] || 0xffffff,
      emissive: type === 'key' ? 0x332200 : 0x000000,
      emissiveIntensity: type === 'key' ? 0.5 : 0,
    });
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(x, yBase + 0.95, z);
    doorsRoot.add(mesh);
    const obj = {
      mesh, type, label: label || type, taken: false, pos: mesh.position,
      keyId: opts.keyId || null,
    };

    // pedestal (rusty crate) — provides collision and a visual base
    const ped = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.85, 0.5), mMetal);
    ped.position.set(x, yBase + 0.42, z);
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

  function noteOnWall(x, z, rotY, textKey, wallOffset = 0.06, opts = {}) {
    const g = new THREE.PlaneGeometry(0.55, 0.38);
    const mesh = new THREE.Mesh(g, mNote);
    const offsetX = Math.sin(rotY) * wallOffset;
    const offsetZ = Math.cos(rotY) * wallOffset;
    const yBase = opts.yBase || 0;
    mesh.position.set(x + offsetX, yBase + 1.6, z + offsetZ);
    mesh.rotation.y = rotY;
    doorsRoot.add(mesh);
    notes.push({
      mesh,
      worldPos: new THREE.Vector3(x + offsetX, yBase + 1.6, z + offsetZ),
      text: RU[textKey],
      title: opts.title || textKey,
      id: opts.id || textKey,
    });
  }

  function bench(x, z, rotY = 0, yBase = 0) {
    const g = new THREE.BoxGeometry(1.4, 0.4, 0.4);
    const m = new THREE.Mesh(g, mWood);
    m.position.set(x, yBase + 0.2, z);
    m.rotation.y = rotY;
    root.add(m);
  }

  function locker(x, z, rotY = 0, yBase = 0) {
    const lk = box(0.7, 1.9, 0.4, mMetal);
    lk.position.set(x, yBase + 0.95, z);
    lk.rotation.y = rotY;
    root.add(lk);
  }

  function pipe(x, z, h = 2.8, yBase = 0) {
    const g = new THREE.CylinderGeometry(0.06, 0.06, h, 8);
    const m = new THREE.Mesh(g, mMetal);
    m.position.set(x, yBase + h / 2 + 0.05, z);
    root.add(m);
  }

  function nav(x, z, y = 0) {
    const p = new THREE.Vector3(x, y, z);
    navPoints.push(p);
    return p;
  }

  /** Floor patch with a different surface type. Registers a region for
   *  surfaceLookup() (drives footstep noise + water stress). */
  function surfacePatch(cx, cz, w, d, type, material, yBase = 0) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d), material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(cx, yBase + 0.005, cz);
    root.add(mesh);
    surfaces.push({ mesh, type });
    surfaceRegions.push({
      min: new THREE.Vector2(cx - w / 2, cz - d / 2),
      max: new THREE.Vector2(cx + w / 2, cz + d / 2),
      type,
      yMin: yBase - 0.5,
      yMax: yBase + 0.5,
    });
  }

  // ===================================================================
  //  ZONE 1 — КПП (x∈[-8..8], z∈[12..22])
  //  Spawn at (0, 0, 18) facing north.
  // ===================================================================
  wallWithDoor([-8, 8], 22, 'x', 0, 0, { id: 'front_door', locked: true });
  wallWithDoor([-8, 8], 12, 'x', 0, 0, { id: 'kpp_exit' });
  wall( 8, 17, WALL_T, 10);
  wall(-8, 17, WALL_T, 10);

  pickupBox(-5, 19, 'flashlight', RU.item_flashlight);
  pickupBox( 5, 19, 'recorder',   RU.item_recorder);
  pickupBox(-3, 14, 'tape',       RU.tape_1);

  noteOnWall(-7.9, 18,  Math.PI / 2,  'note_kpp_1', 0.06, { id: 'note_kpp_1', title: 'Служебная записка' });
  noteOnWall( 7.9, 14, -Math.PI / 2,  'note_kpp_2', 0.06, { id: 'note_kpp_2', title: 'Записка дежурного' });

  bench(-5, 18.2);
  bench( 5, 18.2);
  locker(-7.4, 13.5);
  locker(-7.4, 14.5);
  locker( 7.4, 13.5);
  locker( 7.4, 14.5);

  lamp(-4, 19, { intensity: 1.2 });
  lamp( 4, 19, { intensity: 1.2 });
  lamp( 0, 18, { intensity: 1.0 });
  lamp( 0, 14, { broken: true, intensity: 0.7 });

  nav(0, 18); nav(0, 14); nav(-5, 18); nav(5, 18);

  // ===================================================================
  //  ZONE 2 — CORRIDOR (x∈[-3..3], z∈[-2..12])
  // ===================================================================
  wall(-3, 5, WALL_T, 14);
  wall( 3, 5, WALL_T, 14);

  for (let z = 11; z >= -1; z -= 2) pipe(-2.7, z, 0.4);
  for (let z = 11; z >= -1; z -= 2) pipe( 2.7, z, 0.4);

  lamp(0, 10, { intensity: 1.0 });
  lamp(0, 6,  { broken: true, intensity: 0.6 });
  lamp(0, 2,  { red: true, intensity: 1.4, distance: 8 });
  lamp(0, -1, { intensity: 0.8 });

  pickupBox(-2, 8, 'flashlight_battery', RU.item_flash_battery);
  pickupBox( 2, 4, 'recorder_battery',   RU.item_rec_battery);

  trigger(0,  4, 4, 2, { type: 'subtitle', text: RU.trig_breath, once: true });
  trigger(0, 11, 4, 2, { type: 'subtitle', text: RU.trig_first_red, once: true });
  noteOnWall(-2.85, 7, Math.PI / 2, 'note_corridor', 0.06, { id: 'note_corridor', title: 'На стене' });

  nav(0, 10); nav(0, 6); nav(0, 2); nav(0, -1);

  // ===================================================================
  //  ZONE 3 — RESIDENTIAL HUB (x∈[-12..12], z∈[-22..-2])
  //  Connected to: corridor (south, x∈[-3..3] gap),
  //                west wing (door at x=-12, z=-13),
  //                east wing (door at x=12,  z=-13, locked),
  //                altar    (door at x=0,   z=-22),
  //                NW apt   (hatch in floor at -9,-16 → basement)
  // ===================================================================

  // Hub south wall (z=-2). Corridor (x∈[-3..3]) is the natural opening.
  wall(-7.5, -2, 9, WALL_T);   // x=-12..-3
  wall( 7.5, -2, 9, WALL_T);   // x= 3..12

  // Hub west outer wall (x=-12, z∈[-22..-2]) — single door to West wing.
  // Door at z=-10 (NOT z=-13!): the internal wing partition lives at
  // z=-13, so a doorway at -13 would open straight into a wall. Putting
  // the door at -10 places it inside the northern sub-room (диспетчерская)
  // with a clean line-of-sight into the room.
  wallWithDoor([-22, -2], -12, 'z', -10, Math.PI / 2,  { id: 'west_wing_door' });

  // Hub east outer wall (x=12, z∈[-22..-2]) — single door to East wing at z=-10 (locked).
  wallWithDoor([-22, -2], 12, 'z', -10, -Math.PI / 2,
    { id: 'east_wing_door', locked: true, requiredKey: 'key_storage' });

  // Hub north wall (z=-22) — single altar door at x=0.
  wallWithDoor([-12, 12], -22, 'x', 0, 0, { id: 'altar_door' });

  // ----- SW Apartment (x∈[-12..-6], z∈[-2..-12]) -----
  wallWithDoor([-12, -2], -6, 'z', -7, Math.PI / 2, { id: 'apt_sw' });
  wall(-9, -12, 6, WALL_T);
  pickupBox(-9, -8, 'tape', RU.tape_2);
  bench(-10, -5);
  locker(-11.6, -10);
  noteOnWall(-11.85, -8, Math.PI / 2, 'note_apt', 0.06, { id: 'note_apt', title: 'Записка в квартире' });

  // ----- SE Apartment (x∈[6..12], z∈[-2..-12]) -----
  wallWithDoor([-12, -2], 6, 'z', -7, -Math.PI / 2, { id: 'apt_se' });
  wall(9, -12, 6, WALL_T);
  pickupBox( 9, -8, 'flashlight_battery', RU.item_flash_battery);
  bench(10, -5);
  locker(11.6, -10);

  // ----- NW Apartment (x∈[-12..-6], z∈[-12..-22]) — содержит ЛЮК В ПОДВАЛ -----
  wallWithDoor([-22, -12], -6, 'z', -17, Math.PI / 2, { id: 'apt_nw' });
  pickupBox(-9, -18, 'tape', RU.tape_3);
  bench(-11, -14);                 // moved away from hatch (was at -10,-15)
  locker(-11.6, -20);
  noteOnWall(-11.85, -18, Math.PI / 2, 'note_basement', 0.06, { id: 'note_basement', title: 'Записка о подвале' });

  // Bathroom tile patch (NW apt, well clear of the hatch)
  surfacePatch(-10, -20.5, 3, 2.5, 'tile', mTile);

  // ЛЮК В ПОДВАЛ — посередине пола NW квартиры. Открывается key_basement.
  hatch(-9, -16, {
    id: 'hatch_basement',
    direction: 'down',
    target: new THREE.Vector3(-9, BASEMENT_Y, -16),
    requiredKey: 'key_basement',
    label: 'СПУСТИТЬСЯ',
  });

  // ----- NE Apartment (x∈[6..12], z∈[-12..-22]) -----
  wallWithDoor([-22, -12], 6, 'z', -17, -Math.PI / 2, { id: 'apt_ne' });
  pickupBox( 9, -19, 'tape', RU.tape_F);
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

  // Nav points (hub + apartments + door waypoints)
  nav(0, -4);  nav(0, -8);  nav(0, -12); nav(0, -16); nav(0, -20);
  nav(-3, -7); nav( 3, -7); nav(-3, -17); nav( 3, -17);
  nav(-9, -7); nav( 9, -7); nav(-9, -17); nav( 9, -17);
  nav(-6, -7); nav( 6, -7); nav(-6, -17); nav( 6, -17);
  nav(0, -2);
  // wing approach (door at z=-10 — both sides of the threshold)
  nav(-12, -10); nav(-13, -10);
  nav( 12, -10); nav( 13, -10);

  // ===================================================================
  //  ZONE 4 — ALTAR ROOM (x∈[-3..3], z∈[-28..-22])
  // ===================================================================
  wall(-3, -25, WALL_T, 6);
  wall( 3, -25, WALL_T, 6);
  wall( 0, -28, 6, WALL_T);

  const altar = new THREE.Mesh(
    new THREE.BoxGeometry(1.4, 0.5, 0.8),
    new THREE.MeshLambertMaterial({ color: 0x554a3a, emissive: 0x250000, emissiveIntensity: 0.6 })
  );
  altar.position.set(0, 0.25, -27);
  root.add(altar);

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
  //  ZONE 5 — WEST WING (диспетчерская + склад, x∈[-22..-12], z∈[-18..-8])
  //  Entered from hub via west_wing_door at (-12, -13).
  //  Внутренняя перегородка z=-13 разделяет диспетчерскую (север) и склад (юг).
  //  В диспетчерской лежит DISPATCHER KEY (для люка в подвал).
  // ===================================================================
  wall(-22, -13,  WALL_T, 10);             // запад периметр
  wall(-17, -8,   10, WALL_T);             // север периметр
  wall(-17, -18,  10, WALL_T);             // юг   периметр

  // Внутренняя перегородка диспетчерская/склад, дверь по центру.
  wallWithDoor([-22, -12], -13, 'x', -17, 0, { id: 'disp_inner' });

  // Диспетчерская (север) — стол, шкаф, ключ диспетчера на столе
  bench(-19, -10);
  bench(-19, -10.5);
  locker(-21.4, -9);
  locker(-21.4, -10);
  pickupBox(-19, -11, 'key', RU.item_dispatcher_key, { keyId: 'key_basement' });
  noteOnWall(-21.85, -10, Math.PI / 2, 'note_disp', 0.06, { id: 'note_disp', title: 'Журнал диспетчера' });

  // Склад (юг) — батареи, плёнка, шкафы
  pickupBox(-19, -16, 'flashlight_battery', RU.item_flash_battery);
  pickupBox(-15, -16, 'recorder_battery',   RU.item_rec_battery);
  bench(-19, -15.5, Math.PI / 2);
  locker(-21.4, -16);
  locker(-21.4, -17);

  lamp(-19, -10, { intensity: 0.8 });
  lamp(-15, -10, { intensity: 0.7 });
  lamp(-19, -16, { broken: true, intensity: 0.6 });
  lamp(-15, -16, { intensity: 0.7 });

  nav(-19, -10); nav(-15, -10); nav(-19, -16); nav(-15, -16);
  nav(-17, -13); nav(-13, -10); nav(-13, -16);

  // ===================================================================
  //  ZONE 6 — EAST WING (морг + хранилище, x∈[12..22], z∈[-18..-8])
  //  Entered from hub via east_wing_door at (12, -13). LOCKED until
  //  player picks up key_storage (which is in the basement).
  // ===================================================================
  wall( 22, -13,  WALL_T, 10);             // восток периметр
  wall( 17, -8,   10, WALL_T);             // север периметр
  wall( 17, -18,  10, WALL_T);             // юг   периметр

  // Внутренняя перегородка морг/хранилище, дверь по центру.
  wallWithDoor([12, 22], -13, 'x', 17, 0, { id: 'morgue_inner' });

  // Морг (север) — кафель, каталки (раздвинуты, не плотно)
  surfacePatch(19, -10, 6, 4, 'tile', mTile);
  for (const cz of [-9, -10.8, -12.0]) {
    const cart = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.8, 0.7), mMetal);
    cart.position.set(19, 0.4, cz);
    root.add(cart);
  }
  noteOnWall(21.85, -10, -Math.PI / 2, 'note_morgue', 0.06, { id: 'note_morgue', title: 'Журнал прозектора' });

  // Хранилище (юг) — стеллажи в два ряда вдоль стен (не блокируют центр).
  for (const sx of [13.5, 20.5]) {
    locker(sx, -15.2);
    locker(sx, -16.8);
  }
  pickupBox(17, -17, 'recorder_battery', RU.item_rec_battery);
  noteOnWall(21.85, -16, -Math.PI / 2, 'note_storage', 0.06, { id: 'note_storage', title: 'Опись хранения' });

  lamp(19, -10,  { color: 0xa0bcd0, intensity: 0.9 });
  lamp(15, -10,  { color: 0xa0bcd0, intensity: 0.7 });
  lamp(19, -16,  { red: true, intensity: 1.3, distance: 7 });
  lamp(15, -16,  { broken: true, intensity: 0.6 });

  nav(19, -10); nav(15, -10); nav(19, -16); nav(15, -16);
  nav(17, -13); nav(13, -10); nav(13, -16);

  // ===================================================================
  //  ZONE 7 — BASEMENT (y∈[BASEMENT_Y..BASEMENT_CEIL_Y])
  //  Footprint: x∈[-18..-2], z∈[-22..-10]
  //  - Hatch landing at (-9, -16) (south half)
  //  - One internal door at (-10, -15) splits basement into:
  //        north half (corridor + ascend hatch)  z∈[-15..-10]
  //        south half (flooded, key_storage)     z∈[-22..-15]
  //  - Walls follow wallWithDoor pattern (uniform with surface).
  // ===================================================================

  // Floor (тёмный бетон)
  const bFloor = new THREE.Mesh(new THREE.PlaneGeometry(20, 16), mDarkConcrete);
  bFloor.rotation.x = -Math.PI / 2;
  bFloor.position.set(-10, BASEMENT_Y + 0.005, -16);
  root.add(bFloor);
  surfaces.push({ mesh: bFloor, type: 'concrete' });

  // Ceiling
  const bCeil = new THREE.Mesh(new THREE.PlaneGeometry(20, 16), mCeil);
  bCeil.rotation.x = Math.PI / 2;
  bCeil.position.set(-10, BASEMENT_CEIL_Y, -16);
  root.add(bCeil);

  const bH = BASEMENT_CEIL_Y - BASEMENT_Y;  // ~2.9m

  // External walls — perimeter
  wall(-18, -16, WALL_T, 12, mPlaster, bH, undefined, BASEMENT_Y); // запад
  wall( -2, -16, WALL_T, 12, mPlaster, bH, undefined, BASEMENT_Y); // восток
  wall(-10, -22, 16, WALL_T, mPlaster, bH, undefined, BASEMENT_Y); // юг
  wall(-10, -10, 16, WALL_T, mPlaster, bH, undefined, BASEMENT_Y); // север

  // Internal partition z=-15: door at x=-10 (matches hatch x).
  // Splits basement into a dry north corridor and a flooded south room.
  wallWithDoor([-18, -2], -15, 'x', -10, 0,
    { id: 'basement_inner_door', yBase: BASEMENT_Y });

  // Water surfaces (south half is fully flooded; north has a small puddle)
  const mWater = new THREE.MeshLambertMaterial({
    color: 0x1c2a32,
    emissive: 0x081218,
    emissiveIntensity: 0.4,
    transparent: true,
    opacity: 0.85,
  });
  // South half flooded
  surfacePatch(-10, -18.5, 15.6, 6.8, 'water', mWater, BASEMENT_Y);
  // Small puddle near landing
  surfacePatch(-9, -13, 4, 3, 'water', mWater, BASEMENT_Y);

  // Аварийные лампы
  lamp(-9,  -12, { red: true, intensity: 0.9, distance: 5, y: BASEMENT_CEIL_Y - 0.2 });
  lamp(-9,  -16, { broken: true, intensity: 0.5, distance: 3.5, y: BASEMENT_CEIL_Y - 0.2 });
  lamp(-15, -19, { red: true, intensity: 0.7, distance: 4, y: BASEMENT_CEIL_Y - 0.2 });
  lamp(-5,  -19, { broken: true, intensity: 0.5, distance: 4, y: BASEMENT_CEIL_Y - 0.2 });

  // Pipes along the corridor (do NOT place them in the doorway gap)
  for (const px of [-16, -13, -7, -4]) {
    pipe(px, -12, bH * 0.95, BASEMENT_Y);
  }

  // Шкафчики в углах (не в проходах)
  locker(-17.0, -20.5, 0, BASEMENT_Y);
  locker(-17.0, -19.5, 0, BASEMENT_Y);
  locker(-3.0,  -20.5, 0, BASEMENT_Y);

  // KEY_STORAGE — в южной (затопленной) части
  pickupBox(-5, -19, 'key', RU.item_storage_key, { keyId: 'key_storage', yBase: BASEMENT_Y });
  // Бонусная плёнка — в северной части (доступна сразу при спуске)
  pickupBox(-13, -12, 'tape', RU.tape_basement, { yBase: BASEMENT_Y });

  // Заметки
  noteOnWall(-17.85, -13, Math.PI / 2,  'note_drowned', 0.06,
    { id: 'note_drowned', title: 'Размытая записка', yBase: BASEMENT_Y });
  noteOnWall( -2.15, -19, -Math.PI / 2, 'note_pipes', 0.06,
    { id: 'note_pipes',   title: 'У трубы',          yBase: BASEMENT_Y });

  // Триггеры
  trigger(-9,  -16, 3, 3,   { type: 'subtitle', text: RU.trig_basement_landing, once: true });
  trigger(-9,  -15, 4, 1.5, { type: 'subtitle', text: RU.trig_water_noise,      once: true });

  // Hatch ascend — в той же позиции что и спуск, но направление 'up'.
  hatch(-9, -16, {
    id: 'hatch_to_surface',
    direction: 'up',
    target: new THREE.Vector3(-9, 0, -16),
    label: 'ПОДНЯТЬСЯ',
    yBase: BASEMENT_Y,
  });

  // Nav points в подвале
  nav(-15, -12, BASEMENT_Y); nav(-12, -12, BASEMENT_Y);
  nav( -9, -12, BASEMENT_Y); nav( -6, -12, BASEMENT_Y);
  nav( -9, -14, BASEMENT_Y); nav( -9, -16, BASEMENT_Y);
  nav(-10, -15, BASEMENT_Y); // door waypoint
  nav( -5, -18, BASEMENT_Y); nav( -5, -20, BASEMENT_Y);
  nav(-15, -19, BASEMENT_Y); nav(-15, -20, BASEMENT_Y);

  // ===================================================================
  //  Spawn / AI anchors
  // ===================================================================
  const spawn = new THREE.Vector3(0, 0, 18);
  const weeperSpawns = [];
  const horcrorSpawn = new THREE.Vector3(0, 0, -16);  // hub center

  return {
    root, doorsRoot, spawn, lampPositions, doors, hatches, pickups,
    triggers, surfaces, surfaceRegions, notes, navPoints,
    weeperSpawns, horcrorSpawn,
    basementY: BASEMENT_Y,
    basementCeilY: BASEMENT_CEIL_Y,
    waterY: WATER_Y,
  };
}

/** Animate a door's rotation. */
export function toggleDoor(door, dt) {
  const target = door.open ? Math.PI / 1.3 : 0;
  const k = Math.min(1, dt * 6);
  door.hinge.rotation.y += (target - door.hinge.rotation.y) * k;
  return false;
}

/** Animate a hatch panel: lift + rotate when open, lay flat when closed. */
export function toggleHatch(hatch, dt) {
  const target  = hatch.open ? Math.PI / 2.4 : 0;
  const targetY = hatch.open ? 0.08 : 0.04;
  const k = Math.min(1, dt * 4);
  hatch.panel.rotation.x += (target  - hatch.panel.rotation.x) * k;
  hatch.panel.position.y += (targetY - hatch.panel.position.y) * k;
}

/** Surface lookup using surfaceRegions. xz = THREE.Vector2 (x,z),
 *  y = player Y (used to disambiguate surface vs basement). */
export function lookupSurface(surfaceRegions, xz, y = 0) {
  for (let i = surfaceRegions.length - 1; i >= 0; i--) {
    const r = surfaceRegions[i];
    if (y < r.yMin || y > r.yMax) continue;
    if (xz.x >= r.min.x && xz.x <= r.max.x && xz.y >= r.min.y && xz.y <= r.max.y) {
      return r.type;
    }
  }
  return 'concrete';
}

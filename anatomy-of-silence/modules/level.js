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
  lockerTexture, rustyMetalTexture, stainlessTexture, pipeTexture,
  darkPaintTexture, stoneTexture,
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

// ---------------------------------------------------------------
//  Door-sign texture: small dark metal plate with light Cyrillic
//  text. Used to label every doorway with the room it leads to,
//  matching the muted Soviet-decay register of the rest of the
//  world. Cached by label string so identical labels share a tex.
// ---------------------------------------------------------------
const _signTexCache = new Map();

function signTexture(label) {
  if (_signTexCache.has(label)) return _signTexCache.get(label);

  const W = 512, H = 128;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');

  // Dark metallic vertical gradient base
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0,    '#221d18');
  grad.addColorStop(0.5,  '#2c2620');
  grad.addColorStop(1,    '#181410');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Inset border (outer dark groove + inner highlight)
  ctx.strokeStyle = '#0a0806';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, W - 4, H - 4);
  ctx.strokeStyle = '#3a322a';
  ctx.lineWidth = 1;
  ctx.strokeRect(6, 6, W - 12, H - 12);

  // Grime: dark blotches + faint rust streaks
  for (let i = 0; i < 80; i++) {
    const x = Math.random() * W;
    const y = Math.random() * H;
    const r = 1 + Math.random() * 3;
    ctx.fillStyle = `rgba(0,0,0,${0.04 + Math.random() * 0.10})`;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  for (let i = 0; i < 12; i++) {
    ctx.fillStyle = `rgba(120,90,50,${0.03 + Math.random() * 0.06})`;
    ctx.fillRect(Math.random() * W, Math.random() * H, 1 + Math.random() * 80, 1);
  }

  // Auto-fit font size so long labels still fit on the plate
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let fontSize = 64;
  const maxWidth = W - 40;
  ctx.font = `bold ${fontSize}px sans-serif`;
  while (ctx.measureText(label).width > maxWidth && fontSize > 18) {
    fontSize -= 2;
    ctx.font = `bold ${fontSize}px sans-serif`;
  }

  // Soft shadow then light grey text
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillText(label, W / 2 + 2, H / 2 + 3);
  ctx.fillStyle = '#cfc6ad';
  ctx.fillText(label, W / 2, H / 2);

  // Light scratches over the whole plate
  for (let i = 0; i < 30; i++) {
    ctx.fillStyle = `rgba(0,0,0,${0.05 + Math.random() * 0.15})`;
    ctx.fillRect(Math.random() * W, Math.random() * H, Math.random() * 4, 1);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  // Keep label crisp at oblique viewing angles (Three.js silently
  // clamps to the GPU's max anisotropy).
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;

  _signTexCache.set(label, tex);
  return tex;
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

  // ----- Prop-specific textured materials -----
  const mLocker      = mat(0xffffff, lockerTexture());
  const mRusty       = mat(0xffffff, rustyMetalTexture());
  const mStainless   = mat(0xffffff, stainlessTexture());
  const mPipe        = mat(0xffffff, pipeTexture());
  const mStone       = new THREE.MeshLambertMaterial({ color: 0x9a8a72, map: stoneTexture() });

  // Darker concrete for the basement floor + ceiling
  const mDarkConcrete = new THREE.MeshLambertMaterial({ color: 0x4a4640, map: concreteTexture() });
  // Rusted metal for the hatch
  const mRust         = mat(0xffffff, rustyMetalTexture());

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
    const baseColor = colors[type] || 0xffffff;
    const mItem = new THREE.MeshLambertMaterial({
      color: baseColor,
      emissive: type === 'key' ? 0x332200 : 0x000000,
      emissiveIntensity: type === 'key' ? 0.5 : 0,
    });

    let mesh;
    if (type === 'flashlight_battery' || type === 'recorder_battery') {
      // AA-cell shape: small cylinder with a slightly raised positive terminal
      const grp = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(0.025, 0.025, 0.10, 12),
        mItem,
      );
      body.rotation.z = Math.PI / 2;
      grp.add(body);
      const tipMat = new THREE.MeshLambertMaterial({ color: 0x9c8c5a });
      const tip = new THREE.Mesh(
        new THREE.CylinderGeometry(0.012, 0.012, 0.014, 8),
        tipMat,
      );
      tip.rotation.z = Math.PI / 2;
      tip.position.x = 0.057;
      grp.add(tip);
      mesh = grp;
    } else if (type === 'flashlight') {
      // Tube-shaped flashlight body with bezel
      const grp = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(0.030, 0.028, 0.16, 12),
        mItem,
      );
      body.rotation.z = Math.PI / 2;
      grp.add(body);
      const bezel = new THREE.Mesh(
        new THREE.CylinderGeometry(0.042, 0.034, 0.04, 12),
        new THREE.MeshLambertMaterial({ color: 0x453a2c }),
      );
      bezel.rotation.z = Math.PI / 2;
      bezel.position.x = 0.10;
      grp.add(bezel);
      // Tiny emissive lens
      const lens = new THREE.Mesh(
        new THREE.CircleGeometry(0.030, 12),
        new THREE.MeshBasicMaterial({ color: 0x6a5a3a }),
      );
      lens.position.set(0.121, 0, 0);
      lens.rotation.y = Math.PI / 2;
      grp.add(lens);
      mesh = grp;
    } else if (type === 'recorder') {
      // Compact recorder: small box with two tape-reel circles on top
      const grp = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.06, 0.09), mItem);
      grp.add(body);
      const reelMat = new THREE.MeshLambertMaterial({ color: 0x1a1a1a });
      for (const dx of [-0.035, 0.035]) {
        const reel = new THREE.Mesh(
          new THREE.CylinderGeometry(0.018, 0.018, 0.008, 10),
          reelMat,
        );
        reel.position.set(dx, 0.034, 0);
        grp.add(reel);
      }
      mesh = grp;
    } else if (type === 'tape') {
      // Compact cassette tape (flat box with two reels visible)
      const grp = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.018, 0.07), mItem);
      grp.add(body);
      const reelMat = new THREE.MeshLambertMaterial({ color: 0x222 });
      for (const dx of [-0.024, 0.024]) {
        const reel = new THREE.Mesh(
          new THREE.CylinderGeometry(0.012, 0.012, 0.022, 10),
          reelMat,
        );
        reel.position.set(dx, 0, 0);
        grp.add(reel);
      }
      mesh = grp;
    } else if (type === 'key') {
      // Old-school key: round bow + shaft + tiny teeth
      const grp = new THREE.Group();
      const bow = new THREE.Mesh(
        new THREE.TorusGeometry(0.025, 0.006, 6, 14),
        mItem,
      );
      bow.position.x = -0.05;
      bow.rotation.y = Math.PI / 2;
      grp.add(bow);
      const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(0.005, 0.005, 0.08, 6),
        mItem,
      );
      shaft.rotation.z = Math.PI / 2;
      grp.add(shaft);
      const teeth = new THREE.Mesh(new THREE.BoxGeometry(0.020, 0.014, 0.006), mItem);
      teeth.position.set(0.038, -0.008, 0);
      grp.add(teeth);
      mesh = grp;
    } else {
      // Fallback (unknown type) — the original box
      mesh = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.10, 0.12), mItem);
    }
    mesh.position.set(x, yBase + 0.95, z);
    // Items still need pos accessor for AI/triggers; if it's a group, mesh.position
    // is the Group's position so .pos = mesh.position is correct.
    doorsRoot.add(mesh);
    const obj = {
      mesh, type, label: label || type, taken: false, pos: mesh.position,
      keyId: opts.keyId || null,
    };

    // pedestal (rusty crate) — provides collision and a visual base
    const ped = new THREE.Group();
    ped.position.set(x, yBase + 0.42, z);
    const pedBody = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.85, 0.5), mRusty);
    ped.add(pedBody);
    const pedTop = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.05, 0.54), mDarkMetal);
    pedTop.position.y = 0.42;
    ped.add(pedTop);
    const pedBot = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.05, 0.54), mDarkMetal);
    pedBot.position.y = -0.42;
    ped.add(pedBot);
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

  /**
   * Mount a small text plate above a door, on BOTH sides of the wall,
   * showing where that door leads. The plate sits above the lintel
   * (between the door frame top and the ceiling) so it never blocks
   * the doorway. doorsRoot is not part of the player octree, so the
   * sign has no collision footprint.
   *
   * Works for any wall orientation: rotY=0 for x-axis walls, +/-pi/2
   * for z-axis walls. sin/cos of the door rotation pick the wall-
   * perpendicular offset direction.
   */
  function doorSign(doorObj, label) {
    if (!doorObj || !label) return;
    const yBase = doorObj.yBase || 0;
    const inBasement = yBase < 0;
    const dH = inBasement ? BASEMENT_DOOR_H : DOOR_H;

    // Sign center Y: comfortably above the door frame top
    // (yBase + dH + 0.18) and well below the ceiling.
    const signY = yBase + dH + 0.40;

    const PLATE_W = 0.9;
    const PLATE_H = 0.22;
    const PLATE_D = 0.02;
    // Wall front face sits at perpendicular distance WALL_T/2 = 0.10
    // from the wall centre. WALL_OFF must put the plate's BACK face
    // (= WALL_OFF - PLATE_D/2) clearly in front of that to avoid the
    // z-fighting flicker that made signs look glitchy. 0.16 leaves a
    // comfortable 0.05 gap and also lifts the plate clear of the
    // door-lintel slab which shares the same wall plane.
    const WALL_OFF = 0.16;

    const tex = signTexture(label);
    const plateMat = new THREE.MeshLambertMaterial({
      map: tex,
      emissive: 0x222018,
      emissiveMap: tex,
      emissiveIntensity: 0.4,
    });
    const edgeMat = new THREE.MeshLambertMaterial({ color: 0x141210 });
    // BoxGeometry face order: +X, -X, +Y, -Y, +Z, -Z. The label paints
    // the +Z face only; the rest of the box gets the dark edge material
    // so we don't see mirrored text on the wall side.
    const faceMats = [edgeMat, edgeMat, edgeMat, edgeMat, plateMat, edgeMat];

    const { x, z } = doorObj.worldPos;
    const rotY = doorObj.group.rotation.y;
    // Wall-perpendicular unit vector. rotY=0 wall runs along x, normal
    // is z (cos=1, sin=0); rotY=+/-pi/2 wall runs along z, normal is x.
    const nx = Math.sin(rotY);
    const nz = Math.cos(rotY);

    // Front side (label faces +normal direction)
    const front = box(PLATE_W, PLATE_H, PLATE_D, faceMats);
    front.position.set(x + nx * WALL_OFF, signY, z + nz * WALL_OFF);
    front.rotation.y = rotY;
    doorsRoot.add(front);

    // Back side (label faces -normal direction)
    const back = box(PLATE_W, PLATE_H, PLATE_D, faceMats);
    back.position.set(x - nx * WALL_OFF, signY, z - nz * WALL_OFF);
    back.rotation.y = rotY + Math.PI;
    doorsRoot.add(back);
  }

  // Shared hardware materials used by props (lockers, benches, gurneys).
  // Kept here so we don't keep allocating Lambert materials per prop.
  const mDarkMetal = mat(0xffffff, darkPaintTexture());
  const mRubber    = new THREE.MeshLambertMaterial({ color: 0x070605 });

  function bench(x, z, rotY = 0, yBase = 0) {
    const grp = new THREE.Group();
    grp.position.set(x, yBase, z);
    grp.rotation.y = rotY;

    // Three wooden slats forming the seat
    for (let i = -1; i <= 1; i++) {
      const plank = box(1.4, 0.05, 0.11, mWood);
      plank.position.set(0, 0.40, i * 0.13);
      grp.add(plank);
    }
    // Cross brace under the slats
    const brace = box(1.20, 0.04, 0.04, mDarkMetal);
    brace.position.set(0, 0.34, 0);
    grp.add(brace);
    // Four metal legs
    for (const sx of [-0.6, 0.6]) {
      for (const sz of [-0.15, 0.15]) {
        const leg = box(0.04, 0.40, 0.04, mDarkMetal);
        leg.position.set(sx, 0.20, sz);
        grp.add(leg);
      }
    }
    root.add(grp);
  }

  function locker(x, z, rotY = 0, yBase = 0) {
    const grp = new THREE.Group();
    grp.position.set(x, yBase + 0.95, z);
    grp.rotation.y = rotY;

    // Main body
    const body = box(0.7, 1.9, 0.4, mLocker);
    grp.add(body);
    // Top ventilation strip (thin dark slot, slightly proud of front face)
    const vent = box(0.55, 0.06, 0.005, mDarkMetal);
    vent.position.set(0, 0.82, 0.205);
    grp.add(vent);
    // Vertical door seam (recessed dark line down the middle of front face)
    const seam = box(0.006, 1.60, 0.004, mDarkMetal);
    seam.position.set(0, -0.05, 0.205);
    grp.add(seam);
    // Two horizontal handles, one per door
    for (const dx of [-0.14, 0.14]) {
      const handle = new THREE.Mesh(
        new THREE.CylinderGeometry(0.012, 0.012, 0.10, 6),
        mDarkMetal,
      );
      handle.position.set(dx, -0.05, 0.215);
      handle.rotation.z = Math.PI / 2;
      grp.add(handle);
    }
    // Small ID plate above the handles
    const plate = box(0.10, 0.05, 0.003, mDarkMetal);
    plate.position.set(0, 0.20, 0.207);
    grp.add(plate);

    root.add(grp);
  }

  function pipe(x, z, h = 2.8, yBase = 0) {
    const grp = new THREE.Group();
    grp.position.set(x, yBase, z);
    // Main pipe
    const main = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.06, h, 10),
      mPipe,
    );
    main.position.y = h / 2 + 0.05;
    grp.add(main);
    // Top flange
    const flangeT = new THREE.Mesh(
      new THREE.CylinderGeometry(0.085, 0.085, 0.05, 12),
      mDarkMetal,
    );
    flangeT.position.y = h + 0.02;
    grp.add(flangeT);
    // Bottom flange
    const flangeB = new THREE.Mesh(
      new THREE.CylinderGeometry(0.085, 0.085, 0.05, 12),
      mDarkMetal,
    );
    flangeB.position.y = 0.08;
    grp.add(flangeB);
    root.add(grp);
  }

  /** Morgue gurney: flat steel top on tubular chrome frame with 4 wheels. */
  function gurney(x, z, rotY = 0, yBase = 0) {
    const grp = new THREE.Group();
    grp.position.set(x, yBase, z);
    grp.rotation.y = rotY;

    // Flat top tray
    const top = box(1.8, 0.06, 0.7, mStainless);
    top.position.y = 0.78;
    grp.add(top);
    // Side rails (slim)
    for (const sz of [-0.32, 0.32]) {
      const rail = box(1.8, 0.025, 0.025, mDarkMetal);
      rail.position.set(0, 0.81, sz);
      grp.add(rail);
    }
    // Four tubular legs (chrome-ish, using mDarkMetal so they read against the floor)
    for (const sx of [-0.78, 0.78]) {
      for (const sz of [-0.28, 0.28]) {
        const leg = new THREE.Mesh(
          new THREE.CylinderGeometry(0.022, 0.022, 0.72, 6),
          mDarkMetal,
        );
        leg.position.set(sx, 0.40, sz);
        grp.add(leg);
        // Wheel at bottom (rubber, dark)
        const wheel = new THREE.Mesh(
          new THREE.CylinderGeometry(0.045, 0.045, 0.04, 10),
          mRubber,
        );
        wheel.position.set(sx, 0.045, sz);
        wheel.rotation.z = Math.PI / 2;
        grp.add(wheel);
      }
    }
    // Cross brace between legs (low, runs lengthwise)
    for (const sz of [-0.28, 0.28]) {
      const brace = new THREE.Mesh(
        new THREE.CylinderGeometry(0.018, 0.018, 1.50, 6),
        mDarkMetal,
      );
      brace.position.set(0, 0.18, sz);
      brace.rotation.z = Math.PI / 2;
      grp.add(brace);
    }
    root.add(grp);
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
  doorSign(
    wallWithDoor([-8, 8], 22, 'x', 0, 0, { id: 'front_door', locked: true }),
    'НА УЛИЦУ'
  );
  doorSign(
    wallWithDoor([-8, 8], 12, 'x', 0, 0, { id: 'kpp_exit' }),
    'КОРИДОР'
  );
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
  doorSign(
    wallWithDoor([-22, -2], -12, 'z', -10, Math.PI / 2,  { id: 'west_wing_door' }),
    'ДИСПЕТЧЕРСКАЯ'
  );

  // Hub east outer wall (x=12, z∈[-22..-2]) — single door to East wing at z=-10 (locked).
  doorSign(
    wallWithDoor([-22, -2], 12, 'z', -10, -Math.PI / 2,
      { id: 'east_wing_door', locked: true, requiredKey: 'key_storage' }),
    'МОРГ'
  );

  // Hub north wall (z=-22) — single altar door at x=0.
  doorSign(
    wallWithDoor([-12, 12], -22, 'x', 0, 0, { id: 'altar_door' }),
    'АЛТАРНАЯ'
  );

  // ----- SW Apartment (x∈[-12..-6], z∈[-2..-12]) -----
  doorSign(
    wallWithDoor([-12, -2], -6, 'z', -7, Math.PI / 2, { id: 'apt_sw' }),
    'КВАРТИРА 1'
  );
  wall(-9, -12, 6, WALL_T);
  pickupBox(-9, -8, 'tape', RU.tape_2);
  bench(-10, -5);
  // Locker pulled away from the wing door at z=-10 (was blocking the
  // doorway to ДИСПЕТЧЕРСКАЯ). Now flush against the same west wall
  // at the north end of the SW apartment, well clear of z=-10±0.7.
  locker(-11.6, -4);
  noteOnWall(-11.85, -8, Math.PI / 2, 'note_apt', 0.06, { id: 'note_apt', title: 'Записка в квартире' });

  // ----- SE Apartment (x∈[6..12], z∈[-2..-12]) -----
  doorSign(
    wallWithDoor([-12, -2], 6, 'z', -7, -Math.PI / 2, { id: 'apt_se' }),
    'КВАРТИРА 2'
  );
  wall(9, -12, 6, WALL_T);
  pickupBox( 9, -8, 'flashlight_battery', RU.item_flash_battery);
  bench(10, -5);
  // Mirror of the SW apartment fix: locker pulled north so it doesn't
  // block the МОРГ wing door at z=-10.
  locker(11.6, -4);

  // ----- NW Apartment (x∈[-12..-6], z∈[-12..-22]) — содержит ЛЮК В ПОДВАЛ -----
  doorSign(
    wallWithDoor([-22, -12], -6, 'z', -17, Math.PI / 2, { id: 'apt_nw' }),
    'КВАРТИРА 3'
  );
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
  doorSign(
    wallWithDoor([-22, -12], 6, 'z', -17, -Math.PI / 2, { id: 'apt_ne' }),
    'КВАРТИРА 4'
  );
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

  const altarMat = mStone.clone();
  altarMat.emissive = new THREE.Color(0x250000);
  altarMat.emissiveIntensity = 0.6;
  const altar = new THREE.Mesh(
    new THREE.BoxGeometry(1.4, 0.5, 0.8),
    altarMat
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
  doorSign(
    wallWithDoor([-22, -12], -13, 'x', -17, 0, { id: 'disp_inner' }),
    'СКЛАД'
  );

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
  doorSign(
    wallWithDoor([12, 22], -13, 'x', 17, 0, { id: 'morgue_inner' }),
    'ХРАНИЛИЩЕ'
  );

  // Морг (север) — кафель, каталки (раздвинуты, не плотно)
  surfacePatch(19, -10, 6, 4, 'tile', mTile);
  for (const cz of [-9, -10.8, -12.0]) {
    gurney(19, cz);
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
  doorSign(
    wallWithDoor([-18, -2], -15, 'x', -10, 0,
      { id: 'basement_inner_door', yBase: BASEMENT_Y }),
    'ЗАТОПЛЕННАЯ ЧАСТЬ'
  );

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

  // ---- Shadow flags ----------------------------------------------------
  // Walls, doors, props cast and receive; large floor/ceiling planes only
  // receive (casting from a huge plane would just create artifacts).
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    const isPlane = obj.geometry?.type === 'PlaneGeometry';
    obj.castShadow = !isPlane;
    obj.receiveShadow = true;
  });
  // Doors live in a separate root and also need shadows
  doorsRoot.traverse((obj) => {
    if (obj.isMesh) { obj.castShadow = true; obj.receiveShadow = true; }
  });

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

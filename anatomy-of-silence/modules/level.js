/* =========================================================
 * level.js
 * Soviet-decay level with:
 *   - Surface (КПП, коридор, жилой хаб, западное и восточное крыло, алтарь)
 *   - Basement (подвал) — separate Y plane, accessible via hatch.
 *     Затопленные коридоры (water surface = louder steps + stress).
 *     Кромешная тьма (нет ламп, только аварийные).
 *   - Keys: dispatcher_key (открывает люк в подвал),
 *           storage_key (в подвале → открывает дверь хранилища).
 *
 * Returns:
 *   { root, doorsRoot, spawn, lampPositions, doors, hatches, pickups,
 *     surfaces, surfaceRegions, triggers, notes, weeperSpawns,
 *     horcrorSpawn, navPoints, basementY, basementCeilY }
 * ========================================================= */

import * as THREE from 'three';
import {
  concreteTexture, plasterTexture, tileTexture,
  woodTexture, metalTexture, ceilingTexture, noteTexture,
} from './textures.js';
import { RU } from './i18n.js';

const WALL_H   = 3.0;
const WALL_T   = 0.2;
const DOOR_W   = 1.4;
const DOOR_H   = 2.1;
const BASEMENT_Y       = -3.5;   // floor level of basement
const BASEMENT_CEIL_Y  = -0.6;   // ceiling level of basement
const WATER_Y          = -3.35;  // water surface plane Y

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

  // Darker concrete for the basement floor + ceiling
  const mDarkConcrete = new THREE.MeshLambertMaterial({ color: 0x4a4640, map: concreteTexture() });
  const mWetConcrete  = new THREE.MeshLambertMaterial({ color: 0x6b6660, map: concreteTexture() });
  // Rusted metal for the hatch
  const mRust = new THREE.MeshLambertMaterial({ color: 0x6a4a30 });

  const TX_PLASTER = plasterTexture();

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
  //  HELPERS
  // ===================================================================

  function wall(x, z, w, d, m = mPlaster, h = WALL_H, yBase = 0) {
    let useMat = m;
    if (m === mPlaster) {
      const longest = Math.max(w, d);
      if (longest > 1.5) {
        useMat = tiledMat(TX_PLASTER, Math.max(1, longest / 2.5), Math.max(1, h / 2.5));
      }
    }
    const wmesh = box(w, h, d, useMat);
    wmesh.position.set(x, yBase + h / 2, z);
    root.add(wmesh);
    return wmesh;
  }

  function lamp(x, z, opts = {}) {
    const y = opts.y ?? (WALL_H - 0.18);
    lampPositions.push({ pos: new THREE.Vector3(x, y, z), opts });
  }

  /** Door that fills a passage gap of DOOR_W width.
   *  opts.yBase = floor Y level (0 for surface, BASEMENT_Y for basement).
   *  In basement we also use the lower DOOR_H so it fits under the lower ceiling. */
  function door(x, z, rotY = 0, opts = {}) {
    const yBase = opts.yBase || 0;
    const inBasement = yBase < 0;
    // Basement ceiling is at y=-0.6; floor at -3.5; total height ~2.9m.
    // Use a shorter door (1.9m) and matching transom in basement.
    const dH = inBasement ? 1.9 : DOOR_H;
    const wallH = inBasement ? (BASEMENT_CEIL_Y - BASEMENT_Y) : WALL_H;

    const dgrp = new THREE.Group();
    const hinge = new THREE.Group();

    const slabGeo = new THREE.BoxGeometry(DOOR_W, dH, 0.06);
    slabGeo.translate(DOOR_W / 2, dH / 2, 0);
    const slab = new THREE.Mesh(slabGeo, mWood);
    hinge.add(slab);

    const handle = box(0.06, 0.06, 0.18, mMetal);
    handle.position.set(DOOR_W - 0.15, Math.min(1.0, dH * 0.55), 0.06);
    hinge.add(handle);

    const frameTop = box(DOOR_W, 0.18, 0.14, mWood);
    frameTop.position.set(DOOR_W / 2, dH + 0.10, 0);
    hinge.add(frameTop);
    const JAMB_W = 0.10;
    const jambL = box(JAMB_W, dH + 0.18, 0.14, mWood);
    jambL.position.set(JAMB_W / 2, (dH + 0.18) / 2, 0);
    hinge.add(jambL);
    const jambR = box(JAMB_W, dH + 0.18, 0.14, mWood);
    jambR.position.set(DOOR_W - JAMB_W / 2, (dH + 0.18) / 2, 0);
    hinge.add(jambR);

    hinge.position.set(-DOOR_W / 2, 0, 0);
    dgrp.add(hinge);
    dgrp.position.set(x, yBase, z);
    dgrp.rotation.y = rotY;

    const blockerH = dH + 0.3;
    const blockerGeo = new THREE.BoxGeometry(DOOR_W, blockerH, 0.22);
    const blockerMat = new THREE.MeshBasicMaterial({ visible: false });
    const blocker = new THREE.Mesh(blockerGeo, blockerMat);
    blocker.position.set(x, yBase + blockerH / 2, z);
    blocker.rotation.y = rotY;
    blocker.updateMatrixWorld(true);
    const blockerBox = new THREE.Box3().setFromObject(blocker);

    const transomH  = wallH - (dH + 0.18);
    if (transomH > 0.05) {
      const transomY  = yBase + (dH + 0.18) + transomH / 2;
      const transomMat = tiledMat(TX_PLASTER, Math.max(1, DOOR_W / 2.5), Math.max(1, transomH / 2.5));
      const TRANSOM_T = WALL_T - 0.02;
      const transom = new THREE.Mesh(
        new THREE.BoxGeometry(DOOR_W, transomH, TRANSOM_T),
        transomMat
      );
      transom.position.set(x, transomY, z);
      transom.rotation.y = rotY;
      root.add(transom);
    }

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

  /** Hatch: horizontal trap-door in the floor that teleports the player.
   *  Opens with [E] (and consumes/checks a key if `requiredKey` set).
   *  When activated, the player is teleported to `target` (Vec3, basement). */
  function hatch(x, z, opts = {}) {
    const grp = new THREE.Group();
    // Square panel sitting flush on the floor
    const panel = new THREE.Mesh(
      new THREE.BoxGeometry(1.2, 0.08, 1.2),
      mRust,
    );
    panel.position.y = 0.04;
    grp.add(panel);

    // Decorative bolts
    for (const dx of [-0.5, 0.5]) {
      for (const dz of [-0.5, 0.5]) {
        const bolt = new THREE.Mesh(
          new THREE.CylinderGeometry(0.045, 0.045, 0.03, 6),
          mMetal
        );
        bolt.position.set(dx, 0.085, dz);
        grp.add(bolt);
      }
    }
    // Recessed handle ring
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.14, 0.02, 6, 16),
      mMetal,
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.085;
    grp.add(ring);

    grp.position.set(x, opts.yBase || 0, z);
    doorsRoot.add(grp);

    const obj = {
      kind: 'hatch',
      group: grp,
      panel,
      worldPos: new THREE.Vector3(x, 0.5, z),
      open: false,
      target: opts.target,         // THREE.Vector3 — where to teleport player
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
    const g = new THREE.BoxGeometry(0.20, 0.10, 0.12);
    const m = new THREE.MeshLambertMaterial({ color: colors[type] || 0xffffff, emissive: type === 'key' ? 0x332200 : 0x000000, emissiveIntensity: type === 'key' ? 0.5 : 0 });
    const mesh = new THREE.Mesh(g, m);
    const yBase = opts.yBase || 0;
    mesh.position.set(x, yBase + 0.95, z);
    doorsRoot.add(mesh);
    const obj = { mesh, type, label: label || type, taken: false, pos: mesh.position, keyId: opts.keyId || null };

    // pedestal (rusty crate)
    const ped = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.85, 0.5),
      mMetal
    );
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

  /** Add a floor patch with a different surface type — also registers a region
   *  for surfaceLookup() in the noise system. yBase = floor Y (0 surface, BASEMENT_Y basement). */
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
  // FLOOR + CEILING (surface — area roughly doubled)
  // ===================================================================
  // Footprint: x ∈ [-22..22], z ∈ [-26..26]  → ~44×52 (was 80×80 plane but the
  // playable area was ~24×50 ≈ 1200m². New ~44×52 ≈ 2288m² ≈ x1.9.)
  const FLOOR_SIZE = 110;
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
  //  ZONE 1 — КПП  (z ∈ [12..22], x ∈ [-8..8])
  // ===================================================================
  wall(-4.35, 22, 7.3, WALL_T);
  wall( 4.35, 22, 7.3, WALL_T);
  door(0, 22, 0, { id: 'front_door', locked: true });

  wall(-4.35, 12, 7.3, WALL_T);
  wall( 4.35, 12, 7.3, WALL_T);
  door(0, 12, 0, { id: 'kpp_exit' });

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
  //  ZONE 2 — CORRIDOR (z ∈ [-2..12], x ∈ [-3..3])
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

  trigger(0, 4, 4, 2, { type: 'subtitle', text: RU.trig_breath, once: true });
  trigger(0, 11, 4, 2, { type: 'subtitle', text: RU.trig_first_red, once: true });
  noteOnWall(-2.85, 7, Math.PI / 2, 'note_corridor', 0.06, { id: 'note_corridor', title: 'На стене' });

  nav(0, 10); nav(0, 6); nav(0, 2); nav(0, -1);

  // ===================================================================
  //  ZONE 3 — RESIDENTIAL HUB (z ∈ [-22..-2], x ∈ [-12..12])
  // ===================================================================
  // Hub south wall
  wall(-7.5, -2, 9, WALL_T);
  wall( 7.5, -2, 9, WALL_T);

  // Hub west outer wall (x=-12, z=-2..-22) — но теперь с проёмом в западное крыло на z=-12
  wall(-12, -7.15, WALL_T, 10.3);   // z=-2 .. -12.3
  wall(-12, -17.85, WALL_T, 8.7);   // z=-13.5 .. -22 (включая узкий simple коридор-перешеек)
  // Дверь в западное крыло
  door(-12, -13, Math.PI / 2, { id: 'west_wing_door' });

  // Hub east outer wall — проём в восточное крыло (МОРГ)
  wall( 12, -7.15, WALL_T, 10.3);
  wall( 12, -17.85, WALL_T, 8.7);
  door( 12, -13, -Math.PI / 2, { id: 'east_wing_door', locked: true, requiredKey: 'key_storage' });

  // Hub north wall with altar door
  wall(-5.35, -22, 7.3, WALL_T);
  wall( 5.35, -22, 7.3, WALL_T);
  door(0, -22, 0, { id: 'altar_door' });

  // ----- SW Apartment -----
  wall(-6, -4.15, WALL_T, 4.3);
  wall(-6, -9.85, WALL_T, 4.3);
  door(-6, -7, Math.PI / 2, { id: 'apt_sw' });
  wall(-9, -12, 6, WALL_T);
  pickupBox(-9, -8, 'tape', RU.tape_2);
  bench(-10, -5);
  locker(-11.6, -10);
  noteOnWall(-11.85, -8, Math.PI / 2, 'note_apt', 0.06, { id: 'note_apt', title: 'Записка в квартире' });

  // ----- SE Apartment -----
  wall(6, -4.15, WALL_T, 4.3);
  wall(6, -9.85, WALL_T, 4.3);
  door(6, -7, -Math.PI / 2, { id: 'apt_se' });
  wall(9, -12, 6, WALL_T);
  pickupBox( 9, -8, 'flashlight_battery', RU.item_flash_battery);
  bench(10, -5);
  locker(11.6, -10);

  // ----- NW Apartment (теперь содержит ЛЮК В ПОДВАЛ) -----
  wall(-6, -14.15, WALL_T, 4.3);
  wall(-6, -19.85, WALL_T, 4.3);
  door(-6, -17, Math.PI / 2, { id: 'apt_nw' });
  pickupBox(-9, -18, 'tape', RU.tape_3);
  bench(-10, -15);
  locker(-11.6, -20);
  noteOnWall(-11.85, -18, Math.PI / 2, 'note_basement', 0.06, { id: 'note_basement', title: 'Записка о подвале' });

  // Bathroom tile patch
  surfacePatch(-10, -20, 3, 3, 'tile', mTile);

  // >>>>>> ЛЮК В ПОДВАЛ — посередине пола NW квартиры <<<<<<<
  // Доступ — открывается ключом dispatcher_key (диспетчерский ключ).
  hatch(-9, -16, {
    id: 'hatch_basement',
    direction: 'down',
    target: new THREE.Vector3(-9, BASEMENT_Y, -16),  // приземление в подвал
    requiredKey: 'key_basement',
    label: 'СПУСТИТЬСЯ',
  });

  // ----- NE Apartment -----
  wall(6, -14.15, WALL_T, 4.3);
  wall(6, -19.85, WALL_T, 4.3);
  door(6, -17, -Math.PI / 2, { id: 'apt_ne' });
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

  // Nav points throughout the hub + apartments
  nav(0, -4);  nav(0, -8);  nav(0, -12); nav(0, -16); nav(0, -20);
  nav(-3, -7); nav( 3, -7); nav(-3, -17); nav( 3, -17);
  nav(-9, -7); nav( 9, -7); nav(-9, -17); nav( 9, -17);
  nav(-6, -7); nav( 6, -7); nav(-6, -17); nav( 6, -17);
  nav(0, -2);

  // ===================================================================
  //  ZONE 4 — ALTAR ROOM (z=-22..-28, x=-3..3)
  // ===================================================================
  wall(-3, -25, WALL_T, 6);
  wall( 3, -25, WALL_T, 6);
  wall(0, -28, 6, WALL_T);

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
  //  ZONE 5 — ЗАПАДНОЕ КРЫЛО (диспетчерская, x ∈ [-22..-12], z ∈ [-18..-8])
  //  Доступ — через дверь (-12, -13). Здесь лежит DISPATCHER KEY (для люка).
  //  Внутри — диспетчерская (север) и склад (юг), разделённые внутренней дверью.
  // ===================================================================
  // Внешние стены крыла
  wall(-22, -13, WALL_T, 10);              // запад (x=-22, z=-8..-18)
  wall(-17, -8,  10, WALL_T);              // север (z=-8)
  wall(-17, -18, 10, WALL_T);              // юг   (z=-18)

  // Внутренняя перегородка z=-13, проём DOOR_W в центре (x=-17±0.7)
  wall(-19.85, -13, 4.3, WALL_T);          // x=-22..-17.7
  wall(-14.15, -13, 4.3, WALL_T);          // x=-16.3..-12
  door(-17, -13, 0, { id: 'disp_inner' });

  // Диспетчерская — стол, шкаф, ключ-диспетчера на столе
  bench(-19, -10, 0);
  bench(-19, -10.5, 0);
  locker(-21.4, -9);
  locker(-21.4, -10);
  pickupBox(-19, -11, 'key', RU.item_dispatcher_key, { keyId: 'key_basement' });
  noteOnWall(-21.85, -10, Math.PI / 2, 'note_disp', 0.06, { id: 'note_disp', title: 'Журнал диспетчера' });

  // Склад — припасы, батареи и плёнка
  pickupBox(-19, -16, 'flashlight_battery', RU.item_flash_battery);
  pickupBox(-15, -16, 'recorder_battery',   RU.item_rec_battery);
  bench(-19, -15.5, Math.PI / 2);
  locker(-21.4, -16);
  locker(-21.4, -17);

  // Лампы
  lamp(-19, -10, { intensity: 0.8 });
  lamp(-15, -10, { intensity: 0.7 });
  lamp(-19, -16, { broken: true, intensity: 0.6 });
  lamp(-15, -16, { intensity: 0.7 });

  // Nav
  nav(-19, -10); nav(-15, -10); nav(-19, -16); nav(-15, -16);
  nav(-17, -13); nav(-13, -13); // door waypoints

  // ===================================================================
  //  ZONE 6 — ВОСТОЧНОЕ КРЫЛО (морг + хранилище, x ∈ [12..22], z ∈ [-18..-8])
  //  Доступ — через дверь (12, -13), ЗАПЕРТА. Открывается key_storage,
  //  который лежит в подвале. Здесь финальная атмосфера + материал для лора.
  // ===================================================================
  wall( 22, -13, WALL_T, 10);
  wall( 17, -8,  10, WALL_T);
  wall( 17, -18, 10, WALL_T);

  // Внутренняя перегородка: коридор морга (север) + камера хранения (юг)
  wall( 19.85, -13, 4.3, WALL_T);
  wall( 14.15, -13, 4.3, WALL_T);
  door( 17, -13, 0, { id: 'morgue_inner' });

  // Морг (север) — каталки, кафель
  surfacePatch(19, -10, 6, 4, 'tile', mTile);
  // Каталки (низкие столы)
  for (const cz of [-9, -10.5, -12]) {
    const cart = new THREE.Mesh(
      new THREE.BoxGeometry(1.8, 0.8, 0.7),
      mMetal
    );
    cart.position.set(19, 0.4, cz);
    root.add(cart);
  }
  noteOnWall(21.85, -10, -Math.PI / 2, 'note_morgue', 0.06, { id: 'note_morgue', title: 'Журнал прозектора' });

  // Хранилище (юг) — стеллажи, ФИНАЛЬНАЯ плёнка-альтернатива и ещё одна записка
  for (const sx of [14.5, 17, 19.5]) {
    locker(sx, -15.2);
    locker(sx, -16.8);
  }
  pickupBox(19, -17, 'recorder_battery', RU.item_rec_battery);
  noteOnWall(21.85, -16, -Math.PI / 2, 'note_storage', 0.06, { id: 'note_storage', title: 'Опись хранения' });

  // Лампы (морг — холодные синеватые, хранилище — авария)
  lamp(19, -10,  { color: 0xa0bcd0, intensity: 0.9 });
  lamp(15, -10,  { color: 0xa0bcd0, intensity: 0.7 });
  lamp(19, -16,  { red: true, intensity: 1.3, distance: 7 });
  lamp(15, -16,  { broken: true, intensity: 0.6 });

  nav(19, -10); nav(15, -10); nav(19, -16); nav(15, -16);
  nav(17, -13); nav(13, -13);



  // ===================================================================
  //  ZONE 7 — ПОДВАЛ (basement, y = BASEMENT_Y .. BASEMENT_CEIL_Y)
  //
  //  Footprint (xz): x ∈ [-18..-2], z ∈ [-22..-10]
  //  - Точка приземления люка: (-9, -16)  (под NW квартирой)
  //  - Длинный затопленный коридор west-east, развилка на юг (хранилище)
  //  - Кромешная тьма: всего 2 аварийные тусклые лампы
  //  - Вода (surface='water') заливает почти весь пол
  //  - В дальней комнате — ключ от хранилища морга (key_storage)
  //  - Люк наверх в той же точке (под NW)
  // ===================================================================

  // ---- Floor (тёмный бетон) ----
  const bFloor = new THREE.Mesh(
    new THREE.PlaneGeometry(20, 16),
    mDarkConcrete
  );
  bFloor.rotation.x = -Math.PI / 2;
  bFloor.position.set(-10, BASEMENT_Y + 0.005, -16);
  root.add(bFloor);
  surfaces.push({ mesh: bFloor, type: 'concrete' });

  // ---- Ceiling ----
  const bCeil = new THREE.Mesh(
    new THREE.PlaneGeometry(20, 16),
    mCeil
  );
  bCeil.rotation.x = Math.PI / 2;
  bCeil.position.set(-10, BASEMENT_CEIL_Y, -16);
  root.add(bCeil);

  // ---- Walls (footprint x=-18..-2, z=-22..-10) ----
  const bH = BASEMENT_CEIL_Y - BASEMENT_Y;  // ~2.9m
  // Внешние стены (полностью замкнутый периметр — выход только через люк)
  wall(-18, -16, WALL_T, 12, mPlaster, bH, BASEMENT_Y); // запад
  wall( -2, -16, WALL_T, 12, mPlaster, bH, BASEMENT_Y); // восток
  wall(-10, -22, 16, WALL_T, mPlaster, bH, BASEMENT_Y); // юг
  wall(-10, -10, 16, WALL_T, mPlaster, bH, BASEMENT_Y); // север

  // ---- Внутренние перегородки: коридор + 2 комнаты ----
  // Главный затопленный коридор тянется по x от -16 до -4, z=-15..-13.
  // Перегородка z=-13 (потолок коридора): x=-16..-12 + x=-9..-4 (зазор для входа в северную комнату)
  wall(-14, -13, 4, WALL_T, mPlaster, bH, BASEMENT_Y);   // x=-16..-12
  wall( -6.5, -13, 5, WALL_T, mPlaster, bH, BASEMENT_Y); // x=-9..-4
  // door через перегородку в северную камеру (где ключ)
  door(-10.5, -13, 0, { id: 'basement_north_door', yBase: BASEMENT_Y });

  // Перегородка z=-15 (нижняя стенка коридора): x=-16..-7 (зазор для развилки в южную камеру)
  wall(-11.5, -15, 9, WALL_T, mPlaster, bH, BASEMENT_Y);
  // Дверь в южное хранилище
  door(-5, -15, 0, { id: 'basement_south_door', yBase: BASEMENT_Y });
  wall(-3.5, -15, 3, WALL_T, mPlaster, bH, BASEMENT_Y); // x=-5..-2

  // Стенка подвала z=-12 (для северной камеры — оставляем открытой к проходу)
  // (комнаты обозначены этими стенами; оставшееся пространство = камеры с северной стороны)

  // ---- Лужи / затопленные коридоры (water surfaces) ----
  // Главный коридор полностью затоплен
  const mWater = new THREE.MeshLambertMaterial({
    color: 0x1c2a32,
    emissive: 0x081218,
    emissiveIntensity: 0.4,
    transparent: true,
    opacity: 0.85,
  });
  surfacePatch(-10, -14, 12, 1.8, 'water', mWater, BASEMENT_Y);
  // Лужа в южном хранилище
  surfacePatch(-5, -18, 5, 5, 'water', mWater, BASEMENT_Y);
  // Лужа возле люка (под местом приземления)
  surfacePatch(-9, -16, 4, 4, 'water', mWater, BASEMENT_Y);

  // ---- Аварийные лампы (только 2, очень тусклые) ----
  lamp(-10, -14, { red: true, intensity: 0.9, distance: 5, y: BASEMENT_CEIL_Y - 0.2 });
  lamp(-5,  -18, { red: true, intensity: 0.7, distance: 4, y: BASEMENT_CEIL_Y - 0.2 });
  // Лампа возле люка (мигающая)
  lamp(-9, -16, { broken: true, intensity: 0.5, distance: 3.5, y: BASEMENT_CEIL_Y - 0.2 });

  // ---- Трубы (декор + lore) ----
  for (const px of [-15, -13, -7, -4]) {
    pipe(px, -14, bH * 0.95, BASEMENT_Y);
  }

  // ---- Шкафчики/ящики ----
  locker(-17.5, -20, 0, BASEMENT_Y);
  locker(-17.5, -19, 0, BASEMENT_Y);
  locker(-3.5,  -11, 0, BASEMENT_Y);

  // ---- Ключ от хранилища морга — в южной комнате ----
  pickupBox(-5, -19, 'key', RU.item_storage_key, { keyId: 'key_storage', yBase: BASEMENT_Y });

  // Бонус: ещё одна аудиокассета (расшифровка) — в северной камере
  pickupBox(-13, -11, 'tape', RU.tape_basement, { yBase: BASEMENT_Y });

  // Заметки
  noteOnWall(-17.85, -14, Math.PI / 2,  'note_drowned', 0.06, { id: 'note_drowned', title: 'Размытая записка', yBase: BASEMENT_Y });
  noteOnWall(-2.15, -18, -Math.PI / 2, 'note_pipes',   0.06, { id: 'note_pipes', title: 'У трубы', yBase: BASEMENT_Y });

  // Триггер: атмосферный subtitle при приземлении
  trigger(-9, -16, 3, 3, { type: 'subtitle', text: RU.trig_basement_landing, once: true });
  // Триггер: предупреждение про шум воды
  trigger(-10, -14, 6, 1.5, { type: 'subtitle', text: RU.trig_water_noise, once: true });

  // ---- Люк "наверх" в той же точке ----
  // Когда игрок уже спустился, при взаимодействии с этой панелью —
  // телепортация обратно в NW квартиру.
  hatch(-9, -16, {
    id: 'hatch_to_surface',
    direction: 'up',
    target: new THREE.Vector3(-9, 0, -16),
    label: 'ПОДНЯТЬСЯ',
    yBase: BASEMENT_Y,
  });

  // ---- Nav points в подвале (Y = BASEMENT_Y) ----
  nav(-15, -14, BASEMENT_Y); nav(-12, -14, BASEMENT_Y);
  nav( -9, -14, BASEMENT_Y); nav( -6, -14, BASEMENT_Y);
  nav( -9, -16, BASEMENT_Y); nav( -9, -12, BASEMENT_Y);
  nav( -5, -18, BASEMENT_Y); nav( -5, -20, BASEMENT_Y);
  nav(-15, -19, BASEMENT_Y); nav(-15, -11, BASEMENT_Y);


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

/** Animate a hatch panel: when open, lift+rotate; when closed, lay flat. */
export function toggleHatch(hatch, dt) {
  const target = hatch.open ? Math.PI / 2.4 : 0;
  const targetY = hatch.open ? 0.08 : 0.04;
  const k = Math.min(1, dt * 4);
  hatch.panel.rotation.x += (target - hatch.panel.rotation.x) * k;
  hatch.panel.position.y += (targetY - hatch.panel.position.y) * k;
}

/** Surface lookup helper using surfaceRegions. xz is THREE.Vector2 (x,z),
 *  y is the player Y (used to disambiguate surface vs basement). */
export function lookupSurface(surfaceRegions, xz, y = 0) {
  // Iterate in reverse so later (more specific) patches win
  for (let i = surfaceRegions.length - 1; i >= 0; i--) {
    const r = surfaceRegions[i];
    if (y < r.yMin || y > r.yMax) continue;
    if (xz.x >= r.min.x && xz.x <= r.max.x && xz.y >= r.min.y && xz.y <= r.max.y) {
      return r.type;
    }
  }
  return 'concrete';
}

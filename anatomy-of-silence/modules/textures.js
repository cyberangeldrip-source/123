/* =========================================================
 * textures.js
 * Procedural textures (canvas → THREE.CanvasTexture).
 * Grungier, higher-contrast pass: cracks, water stains, rust
 * streaks, mossy grout, dirt edges. Still PS1-friendly.
 *
 * If matching PNG/JPG files exist under /textures/ they override
 * the procedural ones (e.g. textures/brickwalls.png replaces the
 * plaster wall, concretefloor.png replaces the floor, etc.).
 * The async swap happens in-place: we hand back a placeholder
 * CanvasTexture immediately and replace its image once the file
 * is decoded, so existing materials don't need rewiring.
 * ========================================================= */

import * as THREE from 'three';

const CACHE = new Map();
const _loader = new THREE.TextureLoader();

/**
 * Try to load an external image into the existing CanvasTexture.
 * If the file is missing the request silently fails and we keep
 * the procedural fallback. Returns the texture (mutated in place).
 *
 * Texture.clone() copies properties but the new texture holds its
 * own reference to .image. Materials in the level are built from
 * cloned textures, so just swapping the original's .image isn't
 * enough — we have to track every clone and update it too. The
 * clone-tracking is wired up by patching .clone() the first time
 * we touch the texture here.
 */
/**
 * Resize an image to the nearest power-of-two square via canvas.
 * WebGL1 silently disables mipmaps and RepeatWrapping for NPOT textures,
 * which makes a 1254x1254 PNG render as a single stretched copy across
 * the whole surface instead of tiling. Drawing the image into a 1024 or
 * 2048 canvas restores normal tiling/mipmap behavior.
 */
function _toPowerOfTwo(img) {
  // Pick the nearest power of two that's >= the image's longest side,
  // capped at 2048 so we don't blow up GPU memory on huge uploads.
  const longest = Math.max(img.width || 0, img.height || 0);
  let pot = 1;
  while (pot < longest) pot <<= 1;
  pot = Math.min(pot, 2048);
  if (pot === img.width && pot === img.height) return img;

  const c = document.createElement('canvas');
  c.width = c.height = pot;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, pot, pot);
  return c;
}

function _tryLoadOverride(tex, urls /* string | string[] */, repeat) {
  // ---- one-time clone tracking ----
  if (!tex._aosClones) {
    tex._aosClones = [];
    const origClone = tex.clone.bind(tex);
    tex.clone = function patchedClone(...args) {
      const c = origClone(...args);
      tex._aosClones.push(c);
      // If the override has already loaded by the time someone clones, propagate.
      if (tex._aosLoadedImage) {
        c.image = tex._aosLoadedImage;
        c.magFilter = THREE.LinearFilter;
        c.minFilter = THREE.LinearMipmapLinearFilter;
        c.generateMipmaps = true;
        c.anisotropy = 4;
        c.needsUpdate = true;
      }
      return c;
    };
  }

  const list = Array.isArray(urls) ? urls : [urls];
  let i = 0;
  const tryNext = () => {
    if (i >= list.length) return;
    const url = list[i++];
    _loader.load(
      url,
      (loaded) => {
        // The user's PNG may not be a power of two. WebGL1 will then
        // disable RepeatWrapping/mipmaps, which makes the texture stretch
        // across the whole surface instead of tiling. Resize to POT so
        // tiling works again.
        const potImage = _toPowerOfTwo(loaded.image);

        // Apply the new image to the original texture and to every clone
        // that's already been created.
        const applyTo = (t) => {
          t.image = potImage;
          // Only normalise wrap mode for textures that don't already have
          // an explicit setting. If the caller has switched the texture
          // (or a clone) to ClampToEdgeWrapping — typically because the
          // surface needs ONE copy of the image, not a tiled pattern,
          // e.g. a single door slab — we must NOT silently flip it back
          // to RepeatWrapping here. Doing so makes the image tile and
          // appear cropped on the surface.
          if (t.wrapS !== THREE.ClampToEdgeWrapping) t.wrapS = THREE.RepeatWrapping;
          if (t.wrapT !== THREE.ClampToEdgeWrapping) t.wrapT = THREE.RepeatWrapping;
          // We do NOT overwrite t.repeat here — clones in level.js set
          // per-surface repeat values that we want to preserve. The
          // `repeat` parameter only seeds the original (procedural)
          // texture's tiling.
          t.magFilter = THREE.LinearFilter;
          t.minFilter = THREE.LinearMipmapLinearFilter;
          t.generateMipmaps = true;
          t.anisotropy = 4;
          t.needsUpdate = true;
        };
        applyTo(tex);
        if (repeat) tex.repeat.set(repeat[0], repeat[1]);
        tex._aosLoadedImage = potImage;
        for (const clone of tex._aosClones) applyTo(clone);
      },
      undefined,
      () => tryNext()   // 404 / decode error → fall through to next candidate
    );
  };
  tryNext();
  return tex;
}

function makeCanvas(size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function noise(ctx, w, h, density, alphaRange) {
  const img = ctx.getImageData(0, 0, w, h);
  for (let i = 0; i < img.data.length; i += 4) {
    if (Math.random() < density) {
      const v = Math.floor(Math.random() * 255);
      const a = (alphaRange[0] + Math.random() * (alphaRange[1] - alphaRange[0])) * 255;
      img.data[i]     = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function streaks(ctx, w, h, color, count = 14, fromTop = true) {
  ctx.save();
  ctx.strokeStyle = color;
  for (let i = 0; i < count; i++) {
    const x = Math.random() * w;
    const len = 30 + Math.random() * (h * 0.7);
    const wd = 0.5 + Math.random() * 1.6;
    ctx.lineWidth = wd;
    ctx.globalAlpha = 0.15 + Math.random() * 0.35;
    ctx.beginPath();
    ctx.moveTo(x, fromTop ? 0 : h);
    // wavy fall
    let cx = x;
    for (let y = 0; y < len; y += 6) {
      cx += (Math.random() - 0.5) * 1.4;
      const yy = fromTop ? y : h - y;
      ctx.lineTo(cx, yy);
    }
    ctx.stroke();
  }
  ctx.restore();
}

function blotch(ctx, x, y, r, color) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, color);
  g.addColorStop(1, color.replace(/[\d\.]+\)$/, '0)'));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function finalize(canvas, repeat = [1, 1]) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestMipmapNearestFilter;
  tex.generateMipmaps = true;
  tex.repeat.set(repeat[0], repeat[1]);
  tex.anisotropy = 1;
  return tex;
}

function cacheGet(key, build) {
  if (CACHE.has(key)) return CACHE.get(key);
  const t = build();
  CACHE.set(key, t);
  return t;
}

// ----- CONCRETE FLOOR — wet, cracked, dark -----
export function concreteTexture() {
  return cacheGet('concrete', () => {
    const c = makeCanvas(256);
    const ctx = c.getContext('2d');

    // base gradient (slightly darker on edges)
    const g = ctx.createRadialGradient(128, 128, 60, 128, 128, 200);
    g.addColorStop(0, '#2e2e2a');
    g.addColorStop(1, '#1f201d');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);

    // mottle
    for (let i = 0; i < 1500; i++) {
      const x = Math.random() * 256, y = Math.random() * 256;
      const v = 18 + Math.random() * 50;
      ctx.fillStyle = `rgba(${v},${v - 4},${v - 8},${0.18 + Math.random() * 0.5})`;
      ctx.fillRect(x, y, 1 + Math.random() * 2, 1 + Math.random() * 2);
    }

    // tile-like joints (concrete slabs)
    ctx.strokeStyle = 'rgba(8,8,8,0.65)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, 128); ctx.lineTo(256, 128);
    ctx.moveTo(128, 0); ctx.lineTo(128, 256);
    ctx.stroke();

    // cracks
    ctx.strokeStyle = 'rgba(8,6,4,0.85)';
    for (let i = 0; i < 9; i++) {
      ctx.lineWidth = 0.5 + Math.random() * 1.2;
      ctx.beginPath();
      let x = Math.random() * 256, y = Math.random() * 256;
      ctx.moveTo(x, y);
      for (let j = 0; j < 14; j++) {
        x += (Math.random() - 0.5) * 28;
        y += (Math.random() - 0.5) * 28;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // wet patches (slight blue-green sheen)
    for (let i = 0; i < 6; i++) {
      blotch(ctx,
        Math.random() * 256, Math.random() * 256,
        20 + Math.random() * 60,
        `rgba(40,55,55,${0.18 + Math.random() * 0.18})`);
    }

    // dark stains
    for (let i = 0; i < 14; i++) {
      blotch(ctx,
        Math.random() * 256, Math.random() * 256,
        8 + Math.random() * 22,
        `rgba(0,0,0,${0.20 + Math.random() * 0.30})`);
    }

    noise(ctx, 256, 256, 0.55, [0.04, 0.16]);
    const t = finalize(c, [3, 3]);
    // External override: textures/concretefloor.png|jpg if uploaded by user.
    // The floor plane is 80x80m. With repeat [16,16] each tile is ~5m.
    // The procedural fallback keeps repeat [3,3] for backwards compat.
    _tryLoadOverride(t, [
      'textures/concretefloor.png',
      'textures/concretefloor.jpg',
      'textures/concrete.png',
      'textures/concrete.jpg',
    ], [16, 16]);
    return t;
  });
}

// ----- PLASTER WALL — peeling, water-streaked, soviet yellow -----
export function plasterTexture() {
  return cacheGet('plaster', () => {
    const c = makeCanvas(256);
    const ctx = c.getContext('2d');

    // base wash (dirty cream, varied)
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, '#7c6d52');
    g.addColorStop(0.5, '#6f6048');
    g.addColorStop(1, '#544734');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);

    // big organic stains
    for (let i = 0; i < 26; i++) {
      const x = Math.random() * 256, y = Math.random() * 256;
      const r = 8 + Math.random() * 36;
      blotch(ctx, x, y, r, `rgba(30,22,12,${0.20 + Math.random() * 0.45})`);
    }

    // water streaks running down
    streaks(ctx, 256, 256, 'rgba(35,28,18,1)', 18, true);
    streaks(ctx, 256, 256, 'rgba(8,8,8,1)', 6, true);

    // peel patches (lighter raw wall under plaster)
    for (let i = 0; i < 12; i++) {
      const x = Math.random() * 256, y = Math.random() * 256;
      const w = 8 + Math.random() * 28;
      const h = 6 + Math.random() * 20;
      ctx.fillStyle = `rgba(180,160,120,${0.10 + Math.random() * 0.18})`;
      ctx.fillRect(x, y, w, h);
      // sharp edges of the peel
      ctx.strokeStyle = `rgba(40,30,18,0.4)`;
      ctx.lineWidth = 0.6;
      ctx.strokeRect(x, y, w, h);
    }

    // hairline cracks
    ctx.strokeStyle = 'rgba(20,14,8,0.55)';
    for (let i = 0; i < 6; i++) {
      ctx.lineWidth = 0.4 + Math.random() * 0.8;
      ctx.beginPath();
      let x = Math.random() * 256, y = Math.random() * 256;
      ctx.moveTo(x, y);
      for (let j = 0; j < 9; j++) {
        x += (Math.random() - 0.5) * 22;
        y += (Math.random() - 0.5) * 22;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // moldy bottom edge
    const mold = ctx.createLinearGradient(0, 200, 0, 256);
    mold.addColorStop(0, 'rgba(20,30,18,0)');
    mold.addColorStop(1, 'rgba(20,30,18,0.6)');
    ctx.fillStyle = mold;
    ctx.fillRect(0, 200, 256, 56);

    noise(ctx, 256, 256, 0.45, [0.03, 0.13]);
    const t = finalize(c, [1.5, 1]);
    // External override: textures/brickwalls.png|jpg if uploaded by user.
    _tryLoadOverride(t, [
      'textures/brickwalls.png',
      'textures/brickwalls.jpg',
      'textures/wall.png',
      'textures/wall.jpg',
      'textures/plaster.png',
      'textures/plaster.jpg',
    ], [1.5, 1]);
    return t;
  });
}

// ----- BATHROOM TILE — chipped, dirty grout -----
export function tileTexture() {
  return cacheGet('tile', () => {
    const c = makeCanvas(256);
    const ctx = c.getContext('2d');

    // dirty grout base
    ctx.fillStyle = '#1a1814';
    ctx.fillRect(0, 0, 256, 256);

    // tiles with variance
    const TILE = 32;
    for (let yy = 0; yy < 256; yy += TILE) {
      for (let xx = 0; xx < 256; xx += TILE) {
        const v = 90 + Math.random() * 50;
        const tg = ctx.createLinearGradient(xx, yy, xx, yy + TILE);
        tg.addColorStop(0, `rgb(${v},${v - 4},${v - 12})`);
        tg.addColorStop(1, `rgb(${v - 30},${v - 30},${v - 38})`);
        ctx.fillStyle = tg;
        ctx.fillRect(xx + 2, yy + 2, TILE - 3, TILE - 3);

        // grunge inside tile
        ctx.fillStyle = `rgba(0,0,0,${0.05 + Math.random() * 0.18})`;
        for (let k = 0; k < 4; k++) {
          ctx.fillRect(xx + 3 + Math.random() * 26,
                       yy + 3 + Math.random() * 26, 2, 2);
        }

        // chip on tile corner sometimes
        if (Math.random() < 0.10) {
          ctx.fillStyle = '#1a1814';
          const cx = xx + (Math.random() < 0.5 ? 2 : TILE - 6);
          const cy = yy + (Math.random() < 0.5 ? 2 : TILE - 6);
          ctx.fillRect(cx, cy, 4, 4);
        }
      }
    }

    // dark stains creeping down
    streaks(ctx, 256, 256, 'rgba(20,15,10,1)', 8, true);
    noise(ctx, 256, 256, 0.4, [0.03, 0.12]);
    return finalize(c, [3, 3]);
  });
}

// ----- WOOD DOOR -----
export function woodTexture() {
  return cacheGet('wood', () => {
    const c = makeCanvas(128);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#2e1d12';
    ctx.fillRect(0, 0, 128, 128);
    // grain
    for (let y = 0; y < 128; y++) {
      const v = 28 + Math.sin(y * 0.35) * 8 + Math.random() * 16;
      ctx.fillStyle = `rgba(${v},${v - 8},${v - 14},0.45)`;
      ctx.fillRect(0, y, 128, 1);
    }
    // dark knots
    for (let i = 0; i < 4; i++) {
      blotch(ctx, Math.random() * 128, Math.random() * 128,
        4 + Math.random() * 8,
        'rgba(8,4,2,0.85)');
    }
    // scratches
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 0.5;
    for (let i = 0; i < 6; i++) {
      ctx.beginPath();
      const y = Math.random() * 128;
      ctx.moveTo(0, y); ctx.lineTo(128, y + (Math.random() - 0.5) * 10);
      ctx.stroke();
    }
    noise(ctx, 128, 128, 0.5, [0.04, 0.12]);
    const t = finalize(c, [1, 2]);
    // External override: textures/wood.png|jpg if uploaded by user.
    // Used for door frame/jambs and benches (the "wooden plank" look).
    _tryLoadOverride(t, [
      'textures/wood.png',
      'textures/wood.jpg',
    ], [1, 2]);
    return t;
  });
}

// ----- DOOR SLAB — single full-door image (overridable) -----
// This is a SEPARATE texture from woodTexture() so the user can drop a
// proper "door image" into textures/door.png without that image also
// showing up on benches and door frames. The procedural fallback paints
// vertical-plank wood with iron banding to look like a door.
//
// Texture mapping: repeat = [1, 1], so one full image = one full door
// face (1.4m × 2.1m on each slab). Design uploaded files for that
// 1.4:2.1 (≈ 2:3, taller than wide) aspect ratio.
export function doorTexture() {
  return cacheGet('door', () => {
    const c = makeCanvas(256);
    const ctx = c.getContext('2d');

    // base dark wood
    ctx.fillStyle = '#3a2516';
    ctx.fillRect(0, 0, 256, 256);

    // vertical plank seams (3 planks)
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = 1.5;
    for (const x of [85, 170]) {
      ctx.beginPath();
      ctx.moveTo(x, 0); ctx.lineTo(x, 256);
      ctx.stroke();
    }

    // grain across whole door
    for (let y = 0; y < 256; y++) {
      const v = 32 + Math.sin(y * 0.18) * 10 + Math.random() * 14;
      ctx.fillStyle = `rgba(${v},${v - 8},${v - 14},0.55)`;
      ctx.fillRect(0, y, 256, 1);
    }

    // iron banding (top + bottom)
    ctx.fillStyle = '#1a1410';
    ctx.fillRect(0,  18, 256, 14);
    ctx.fillRect(0, 224, 256, 14);
    // rivets
    ctx.fillStyle = '#0a0806';
    for (const y of [25, 231]) {
      for (let x = 16; x < 256; x += 32) {
        ctx.beginPath();
        ctx.arc(x, y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // dark knots
    for (let i = 0; i < 5; i++) {
      blotch(ctx, Math.random() * 256, Math.random() * 256,
        5 + Math.random() * 10,
        'rgba(8,4,2,0.9)');
    }

    // weathering streaks
    streaks(ctx, 256, 256, 'rgba(15,8,4,1)', 6, true);

    noise(ctx, 256, 256, 0.5, [0.04, 0.12]);
    const t = finalize(c, [1, 1]);
    // External override: textures/door.png|jpg if uploaded by user.
    // Drop a 1024x1024 (or 2048x2048) PNG at this path. The door slab
    // is mapped at repeat=[1,1], so one image = one full door face.
    _tryLoadOverride(t, [
      'textures/door.png',
      'textures/door.jpg',
    ], [1, 1]);
    return t;
  });
}

// ----- METAL — heavily rusted -----
export function metalTexture() {
  return cacheGet('metal', () => {
    const c = makeCanvas(256);
    const ctx = c.getContext('2d');
    // base steel
    const g = ctx.createLinearGradient(0, 0, 256, 256);
    g.addColorStop(0, '#3c372e');
    g.addColorStop(1, '#272320');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);

    // rust patches
    for (let i = 0; i < 28; i++) {
      const x = Math.random() * 256, y = Math.random() * 256;
      const r = 8 + Math.random() * 28;
      blotch(ctx, x, y, r,
        `rgba(${110 + Math.random() * 40},${50 + Math.random() * 25},${20 + Math.random() * 15},${0.5 + Math.random() * 0.35})`);
    }
    // rust streaks downward
    streaks(ctx, 256, 256, 'rgba(120,55,25,1)', 14, true);

    // bolt heads (small dark circles in a grid)
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    for (let i = 32; i < 256; i += 64) {
      for (let j = 32; j < 256; j += 64) {
        ctx.beginPath();
        ctx.arc(i, j, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    noise(ctx, 256, 256, 0.55, [0.04, 0.14]);
    return finalize(c, [1, 1]);
  });
}

// ----- CEILING — water-stained plaster -----
export function ceilingTexture() {
  return cacheGet('ceiling', () => {
    const c = makeCanvas(256);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#3c3328';
    ctx.fillRect(0, 0, 256, 256);
    // big water blooms
    for (let i = 0; i < 14; i++) {
      blotch(ctx,
        Math.random() * 256, Math.random() * 256,
        24 + Math.random() * 50,
        `rgba(20,14,8,${0.30 + Math.random() * 0.4})`);
    }
    // cracks
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    for (let i = 0; i < 4; i++) {
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      let x = Math.random() * 256, y = Math.random() * 256;
      ctx.moveTo(x, y);
      for (let j = 0; j < 12; j++) {
        x += (Math.random() - 0.5) * 24;
        y += (Math.random() - 0.5) * 24;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    noise(ctx, 256, 256, 0.4, [0.03, 0.12]);
    const t = finalize(c, [2, 2]);
    // External override: textures/concreteceiling.png|jpg if uploaded by user.
    // Ceiling plane is 80x80m. With repeat [12,12] each panel is ~6.7m.
    _tryLoadOverride(t, [
      'textures/concreteceiling.png',
      'textures/concreteceiling.jpg',
      'textures/ceiling.png',
      'textures/ceiling.jpg',
    ], [12, 12]);
    return t;
  });
}
export function asphaltTexture() {
  return cacheGet('asphalt', () => {
    const c = makeCanvas(128);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#1f1f1f';
    ctx.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 1500; i++) {
      const v = 25 + Math.random() * 40;
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.fillRect(Math.random() * 128, Math.random() * 128, 1, 1);
    }
    noise(ctx, 128, 128, 0.5, [0.05, 0.18]);
    return finalize(c, [3, 3]);
  });
}

// ----- POSTER / NOTE — paper sign for signage hints -----
export function noteTexture() {
  return cacheGet('note', () => {
    const c = makeCanvas(128);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#c8b88a';
    ctx.fillRect(0, 0, 128, 128);
    // age stains
    for (let i = 0; i < 12; i++) {
      blotch(ctx, Math.random()*128, Math.random()*128,
        6 + Math.random() * 16,
        `rgba(80,55,25,${0.15 + Math.random() * 0.3})`);
    }
    // torn edge bottom
    ctx.fillStyle = '#3c3328';
    for (let x = 0; x < 128; x += 4) {
      ctx.fillRect(x, 120 + Math.random() * 6, 4, 8);
    }
    noise(ctx, 128, 128, 0.4, [0.04, 0.14]);
    return finalize(c, [1, 1]);
  });
}

// ----- LOCKER STEEL — pale institutional cabinet metal -----
// Used by lockers and other freestanding storage. Cool muted teal with
// faint vertical brush stripes and paint-chip blotches showing dark rust
// underneath. Heavy dust at the bottom 20%.
export function lockerTexture() {
  return cacheGet('locker', () => {
    const c = makeCanvas(256);
    const ctx = c.getContext('2d');

    // base gradient (pale muted teal/sage)
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, '#3c4a48');
    g.addColorStop(1, '#4f5b58');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);

    // faint vertical brush stripes (lighter)
    for (let i = 0; i < 12; i++) {
      const x = Math.random() * 256;
      const h = 20 + Math.random() * 100;
      ctx.fillStyle = `rgba(200,210,200,${0.05 + Math.random() * 0.1})`;
      ctx.fillRect(x, 0, 2, h);
    }

    // paint-chip blotches showing dark rust underneath (~6 chips)
    for (let i = 0; i < 6; i++) {
      blotch(ctx,
        Math.random() * 256, Math.random() * 256,
        8 + Math.random() * 16,
        'rgba(80,40,20,0.85)');
    }

    // heavy dust at the bottom 20% (lighter)
    const dust = ctx.createLinearGradient(0, 200, 0, 256);
    dust.addColorStop(0, 'rgba(200,200,200,0)');
    dust.addColorStop(1, 'rgba(200,200,200,0.3)');
    ctx.fillStyle = dust;
    ctx.fillRect(0, 200, 256, 56);

    noise(ctx, 256, 256, 0.4, [0.03, 0.12]);
    const t = finalize(c, [1, 1]);
    return t;
  });
}

// ----- RUSTY METAL — heavy-patina pedestals, crates -----
// Heavier and warmer than metalTexture(): dominated by orange-brown rust
// with islands of bare steel showing through. Used for pickup pedestals
// and any prop that wants to read as "long-abandoned industrial".
export function rustyMetalTexture() {
  return cacheGet('rusty_metal', () => {
    const c = makeCanvas(256);
    const ctx = c.getContext('2d');
    // base: dirty rust orange
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, '#5a3418');
    g.addColorStop(1, '#3a2410');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 256, 256);
    // big rust blotches
    for (let i = 0; i < 20; i++) {
      blotch(ctx, Math.random()*256, Math.random()*256,
        18 + Math.random()*40,
        `rgba(${110 + Math.random()*60},${50 + Math.random()*30},${20 + Math.random()*20},${0.4 + Math.random()*0.35})`);
    }
    // islands of darker base steel poking through
    for (let i = 0; i < 8; i++) {
      blotch(ctx, Math.random()*256, Math.random()*256,
        8 + Math.random()*18,
        `rgba(40,32,26,${0.55 + Math.random()*0.3})`);
    }
    // pitting (small dark dots)
    ctx.fillStyle = 'rgba(20,12,8,0.6)';
    for (let i = 0; i < 280; i++) {
      ctx.fillRect(Math.random()*256, Math.random()*256, 1 + Math.random()*1.5, 1 + Math.random()*1.5);
    }
    // vertical rust streaks
    streaks(ctx, 256, 256, 'rgba(95,45,20,1)', 18, true);
    noise(ctx, 256, 256, 0.55, [0.05, 0.18]);
    return finalize(c, [1, 1]);
  });
}

// ----- STAINLESS / CHROME — clean medical surfaces -----
// Cooler, brighter, less weathered than metalTexture. Faint scratches +
// a couple of dark stain hints. For gurney tops, sink fixtures, anything
// that wants to read as "wiped down, but used".
export function stainlessTexture() {
  return cacheGet('stainless', () => {
    const c = makeCanvas(256);
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, '#8e928f');
    g.addColorStop(0.5, '#a0a4a1');
    g.addColorStop(1, '#7d817e');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 256, 256);
    // long horizontal brushed scratches
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    for (let i = 0; i < 70; i++) {
      const y = Math.random()*256;
      ctx.lineWidth = 0.6 + Math.random()*0.7;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(256, y + (Math.random()-0.5)*2);
      ctx.stroke();
    }
    // a few darker scuffs
    ctx.strokeStyle = 'rgba(20,20,25,0.25)';
    for (let i = 0; i < 20; i++) {
      const y = Math.random()*256;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(Math.random()*256, y);
      ctx.lineTo(Math.random()*256, y + (Math.random()-0.5)*4);
      ctx.stroke();
    }
    // a darkened smear (organic stain)
    blotch(ctx, 90, 180, 30, 'rgba(40,18,18,0.35)');
    blotch(ctx, 180, 80, 22, 'rgba(50,40,30,0.25)');
    noise(ctx, 256, 256, 0.35, [0.02, 0.08]);
    return finalize(c, [1, 1]);
  });
}

// ----- PIPE PAINT — old painted industrial pipe -----
// Cream/grey base paint with rust rings (where the paint has lifted at joints)
// and runs/drips. Repeated along the pipe (vertically), so it tiles 2x in U.
export function pipeTexture() {
  return cacheGet('pipe', () => {
    const c = makeCanvas(256);
    const ctx = c.getContext('2d');
    // base: weathered cream
    ctx.fillStyle = '#b8a685';
    ctx.fillRect(0, 0, 256, 256);
    // big paint discoloration patches
    for (let i = 0; i < 8; i++) {
      blotch(ctx, Math.random()*256, Math.random()*256,
        20 + Math.random()*40,
        `rgba(${85 + Math.random()*30},${70 + Math.random()*20},${50 + Math.random()*15},${0.25 + Math.random()*0.3})`);
    }
    // rust rings (horizontal bands where joints would be)
    for (const ringY of [30, 130, 220]) {
      const grd = ctx.createLinearGradient(0, ringY - 12, 0, ringY + 12);
      grd.addColorStop(0,   'rgba(70,32,15,0)');
      grd.addColorStop(0.5, 'rgba(110,50,22,0.7)');
      grd.addColorStop(1,   'rgba(70,32,15,0)');
      ctx.fillStyle = grd;
      ctx.fillRect(0, ringY - 12, 256, 24);
    }
    // paint chips (small darker spots)
    ctx.fillStyle = 'rgba(60,32,18,0.7)';
    for (let i = 0; i < 60; i++) {
      ctx.fillRect(Math.random()*256, Math.random()*256, 1 + Math.random()*3, 1 + Math.random()*3);
    }
    // vertical rust streaks
    streaks(ctx, 256, 256, 'rgba(85,38,18,1)', 10, true);
    noise(ctx, 256, 256, 0.4, [0.03, 0.1]);
    return finalize(c, [1, 2]);
  });
}

// ----- DARK PAINTED HARDWARE — legs, frames, brackets -----
// Satin black with subtle micro-noise + a few scuffs. Used as a replacement
// for the solid 0x12100e mDarkMetal color so legs/frames/handles don't read
// as flat plastic. Tileable.
export function darkPaintTexture() {
  return cacheGet('dark_paint', () => {
    const c = makeCanvas(128);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#16140f';
    ctx.fillRect(0, 0, 128, 128);
    // micro-pitting (slightly lighter dots)
    for (let i = 0; i < 200; i++) {
      const v = 25 + Math.random()*15;
      ctx.fillStyle = `rgba(${v},${v},${v},${0.3 + Math.random()*0.3})`;
      ctx.fillRect(Math.random()*128, Math.random()*128, 1, 1);
    }
    // a few scuffs revealing lighter metal
    ctx.strokeStyle = 'rgba(90,82,70,0.35)';
    for (let i = 0; i < 12; i++) {
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(Math.random()*128, Math.random()*128);
      ctx.lineTo(Math.random()*128, Math.random()*128);
      ctx.stroke();
    }
    noise(ctx, 128, 128, 0.35, [0.05, 0.12]);
    return finalize(c, [1, 1]);
  });
}

// ----- ENAMEL LAMP SHADE — chipped industrial pendant -----
// Green enamel with soot at the bottom edge (heat) and a few paint chips.
export function lampShadeTexture() {
  return cacheGet('lamp_shade', () => {
    const c = makeCanvas(128);
    const ctx = c.getContext('2d');
    // base green enamel
    const g = ctx.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0, '#2c3a30');
    g.addColorStop(1, '#1a221c');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    // a few highlight gleams (subtle enamel glossiness)
    for (let i = 0; i < 4; i++) {
      blotch(ctx, Math.random()*128, Math.random()*40,
        16 + Math.random()*20, 'rgba(120,150,130,0.18)');
    }
    // chip blotches (dark gunmetal underneath)
    for (let i = 0; i < 5; i++) {
      blotch(ctx, Math.random()*128, Math.random()*128,
        3 + Math.random()*5, 'rgba(20,18,16,0.85)');
    }
    // soot at bottom edge
    const soot = ctx.createLinearGradient(0, 90, 0, 128);
    soot.addColorStop(0, 'rgba(0,0,0,0)');
    soot.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = soot;
    ctx.fillRect(0, 90, 128, 38);
    noise(ctx, 128, 128, 0.4, [0.04, 0.1]);
    return finalize(c, [2, 1]);
  });
}

// ----- STONE / ALTAR — weathered dark stone with stains -----
// Used for the altar slab. Dark slate with old blood/oil stains.
export function stoneTexture() {
  return cacheGet('stone', () => {
    const c = makeCanvas(256);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#2b2620';
    ctx.fillRect(0, 0, 256, 256);
    // larger stone patches
    for (let i = 0; i < 20; i++) {
      blotch(ctx, Math.random()*256, Math.random()*256,
        16 + Math.random()*30,
        `rgba(${50 + Math.random()*30},${40 + Math.random()*25},${30 + Math.random()*15},${0.4 + Math.random()*0.3})`);
    }
    // small lighter speckles (mineral grains)
    for (let i = 0; i < 250; i++) {
      const v = 60 + Math.random()*30;
      ctx.fillStyle = `rgba(${v},${v - 8},${v - 16},${0.4 + Math.random()*0.3})`;
      ctx.fillRect(Math.random()*256, Math.random()*256, 1 + Math.random()*1.5, 1 + Math.random()*1.5);
    }
    // dark old-blood stains
    for (let i = 0; i < 3; i++) {
      blotch(ctx, Math.random()*256, Math.random()*256,
        18 + Math.random()*25, 'rgba(45,12,8,0.6)');
    }
    noise(ctx, 256, 256, 0.45, [0.05, 0.13]);
    return finalize(c, [1, 1]);
  });
}

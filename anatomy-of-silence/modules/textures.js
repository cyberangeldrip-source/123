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
          t.wrapS = t.wrapT = THREE.RepeatWrapping;
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
    return finalize(c, [1, 2]);
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

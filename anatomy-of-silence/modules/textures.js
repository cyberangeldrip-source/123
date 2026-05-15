/* =========================================================
 * textures.js
 * Procedural textures (canvas → THREE.CanvasTexture).
 * Cheap, low-res, pixel-art friendly. No external files.
 * ========================================================= */

import * as THREE from 'three';

const CACHE = new Map();

function makeCanvas(size = 128) {
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

function finalize(canvas, repeat = [1, 1]) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter; // PS1 look
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

// ----- Concrete (walls / floor) -----
export function concreteTexture() {
  return cacheGet('concrete', () => {
    const c = makeCanvas(128);
    const ctx = c.getContext('2d');
    // base
    ctx.fillStyle = '#3a3a36';
    ctx.fillRect(0, 0, 128, 128);
    // mottle
    for (let i = 0; i < 800; i++) {
      const x = Math.random() * 128, y = Math.random() * 128;
      const v = 30 + Math.random() * 50;
      ctx.fillStyle = `rgba(${v},${v - 4},${v - 8},${0.18 + Math.random() * 0.4})`;
      ctx.fillRect(x, y, 1 + Math.random() * 2, 1 + Math.random() * 2);
    }
    // cracks
    ctx.strokeStyle = 'rgba(15,15,15,0.7)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 6; i++) {
      ctx.beginPath();
      let x = Math.random() * 128, y = Math.random() * 128;
      ctx.moveTo(x, y);
      for (let j = 0; j < 8; j++) {
        x += (Math.random() - 0.5) * 18;
        y += (Math.random() - 0.5) * 18;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // grain
    noise(ctx, 128, 128, 0.6, [0.04, 0.16]);
    return finalize(c, [2, 2]);
  });
}

// ----- Wall plaster (dirty pale yellow Soviet wall) -----
export function plasterTexture() {
  return cacheGet('plaster', () => {
    const c = makeCanvas(128);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#7a6e52';
    ctx.fillRect(0, 0, 128, 128);
    // stains
    for (let i = 0; i < 30; i++) {
      const x = Math.random() * 128, y = Math.random() * 128;
      const r = 4 + Math.random() * 18;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(40,30,20,${0.3 + Math.random() * 0.4})`);
      g.addColorStop(1, 'rgba(40,30,20,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    // peel patches (lighter)
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = 'rgba(150,140,110,0.18)';
      ctx.fillRect(Math.random() * 128, Math.random() * 128, 6 + Math.random() * 12, 4 + Math.random() * 8);
    }
    noise(ctx, 128, 128, 0.5, [0.03, 0.12]);
    return finalize(c, [2, 1]);
  });
}

// ----- Tile (bathroom/lab) -----
export function tileTexture() {
  return cacheGet('tile', () => {
    const c = makeCanvas(128);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#8a8780';
    ctx.fillRect(0, 0, 128, 128);
    ctx.strokeStyle = '#1a1816';
    ctx.lineWidth = 2;
    for (let i = 0; i <= 128; i += 32) {
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 128); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(128, i); ctx.stroke();
    }
    // tile-to-tile color variance
    for (let yy = 0; yy < 128; yy += 32) {
      for (let xx = 0; xx < 128; xx += 32) {
        ctx.fillStyle = `rgba(${30 + Math.random() * 40},${30 + Math.random() * 40},${30 + Math.random() * 40},0.3)`;
        ctx.fillRect(xx + 1, yy + 1, 30, 30);
      }
    }
    noise(ctx, 128, 128, 0.4, [0.02, 0.1]);
    return finalize(c, [4, 4]);
  });
}

// ----- Wood (door) -----
export function woodTexture() {
  return cacheGet('wood', () => {
    const c = makeCanvas(64);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#3a261a';
    ctx.fillRect(0, 0, 64, 64);
    // grain lines
    for (let y = 0; y < 64; y++) {
      const v = 30 + Math.sin(y * 0.4) * 6 + Math.random() * 14;
      ctx.fillStyle = `rgba(${v},${v - 8},${v - 16},0.35)`;
      ctx.fillRect(0, y, 64, 1);
    }
    noise(ctx, 64, 64, 0.5, [0.04, 0.12]);
    return finalize(c, [1, 2]);
  });
}

// ----- Rust / metal (lockers, pipes) -----
export function metalTexture() {
  return cacheGet('metal', () => {
    const c = makeCanvas(128);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#454239';
    ctx.fillRect(0, 0, 128, 128);
    // rust patches
    for (let i = 0; i < 18; i++) {
      const x = Math.random() * 128, y = Math.random() * 128;
      const r = 6 + Math.random() * 16;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(110,55,25,${0.5 + Math.random() * 0.3})`);
      g.addColorStop(1, 'rgba(110,55,25,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    noise(ctx, 128, 128, 0.6, [0.04, 0.14]);
    return finalize(c, [1, 1]);
  });
}

// ----- Asphalt / outdoor floor -----
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

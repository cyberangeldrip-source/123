/* =========================================================
 * props.js
 * Loads external GLB props and characters and places them
 * in the world or attaches them to existing actors.
 * ========================================================= */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const loader = new GLTFLoader();

// Cache for templates that get cloned many times (e.g. one Weeper model
// for several spawned Weepers).
const _templateCache = new Map();

/**
 * Load a GLB and place it in the scene at the given position.
 * Auto-scales the model to a target height in world units.
 *
 * @param {string} url            Path to the .glb file
 * @param {object} opts
 *   - position {x,y,z}           World position of the model's base
 *   - rotationY {number}         Rotation around Y in radians
 *   - targetHeight {number}      Desired world-space height of the model (auto-scale)
 *   - parent {THREE.Object3D}    Where to attach the visual mesh (visual layer)
 *   - collisionParent {THREE.Object3D}  Where to attach the invisible AABB blocker (collision layer)
 *   - onReady {(group, blocker)=>void}  Optional callback once loaded; useful for octree rebuild
 */
export function loadGLBProp(url, opts = {}) {
  const {
    position = { x: 0, y: 0, z: 0 },
    rotationY = 0,
    targetHeight = 1.7,
    parent,
    collisionParent,
    onReady,
  } = opts;

  loader.load(
    url,
    (gltf) => {
      const model = gltf.scene;

      // Compute current bounding box BEFORE scaling/translating
      const bbox = new THREE.Box3().setFromObject(model);
      const size = new THREE.Vector3();
      bbox.getSize(size);

      // Auto-scale so model height matches targetHeight
      let scale = 1;
      if (size.y > 0) {
        scale = targetHeight / size.y;
        model.scale.setScalar(scale);
      }

      // Re-measure after scaling
      bbox.setFromObject(model);
      bbox.getSize(size);

      // Recenter so the model's bottom sits at y=0 and it is centered on x/z
      const center = new THREE.Vector3();
      bbox.getCenter(center);
      model.position.x -= center.x;
      model.position.z -= center.z;
      model.position.y -= bbox.min.y;

      // Wrap so we can rotate/place as a group
      const wrapper = new THREE.Group();
      wrapper.add(model);
      wrapper.position.set(position.x, position.y, position.z);
      wrapper.rotation.y = rotationY;

      // The game uses MeshLambertMaterial elsewhere, so PBR materials still
      // render fine but tone them down a bit so they don't pop out of the
      // dark VHS atmosphere.
      model.traverse((node) => {
        if (node.isMesh && node.material) {
          const mats = Array.isArray(node.material) ? node.material : [node.material];
          for (const m of mats) {
            if ('envMapIntensity' in m) m.envMapIntensity = 0.4;
            if ('roughness' in m) m.roughness = Math.min(1, (m.roughness ?? 0.8) * 1.1 + 0.1);
            // Avoid double-bright emissive on a dark stress-VHS scene
            if (m.emissive && m.emissiveIntensity > 0) m.emissiveIntensity *= 0.5;
            m.needsUpdate = true;
          }
        }
      });

      if (parent) parent.add(wrapper);

      // Build invisible AABB collider sized to the model's footprint, slightly
      // padded on x/z so the player can't clip into corners. Added to the
      // *collisionParent* (the static level root) so it gets baked into the
      // octree on rebuild.
      const padXZ = 0.06;
      const colliderGeo = new THREE.BoxGeometry(size.x + padXZ * 2, size.y, size.z + padXZ * 2);
      const colliderMat = new THREE.MeshBasicMaterial({ visible: false });
      const blocker = new THREE.Mesh(colliderGeo, colliderMat);
      blocker.position.set(position.x, position.y + size.y / 2, position.z);
      blocker.rotation.y = rotationY;
      if (collisionParent) collisionParent.add(blocker);

      if (typeof onReady === 'function') onReady(wrapper, blocker);
    },
    undefined,
    (err) => {
      // eslint-disable-next-line no-console
      console.error(`[props] failed to load ${url}:`, err);
    }
  );
}

/**
 * Loads a GLB once, normalizes it (auto-scaled to targetHeight, recentered so
 * its base is at y=0) and caches it. Subsequent calls for the same url return
 * the cached promise. Use the returned template via cloneGLBTemplate() to spawn
 * many instances of the same model (e.g. one model, many Weepers).
 *
 * @param {string} url
 * @param {object} opts
 *   - targetHeight {number}      Desired world-space height (default 2.0m)
 *   - tintForVHS {boolean}       Tone down emissive/envmap for the dark atmosphere
 * @returns {Promise<{root: THREE.Object3D, size: THREE.Vector3}>}
 */
export function loadGLBTemplate(url, opts = {}) {
  if (_templateCache.has(url)) return _templateCache.get(url);

  const { targetHeight = 2.0, tintForVHS = true } = opts;

  const p = new Promise((resolve, reject) => {
    loader.load(
      url,
      (gltf) => {
        const root = gltf.scene;

        // Auto-scale to targetHeight using initial bbox
        const bbox = new THREE.Box3().setFromObject(root);
        const size = new THREE.Vector3();
        bbox.getSize(size);
        if (size.y > 0) root.scale.setScalar(targetHeight / size.y);

        // Re-measure and recenter so its base is at y=0 and centered on x/z
        bbox.setFromObject(root);
        bbox.getSize(size);
        const center = new THREE.Vector3();
        bbox.getCenter(center);
        root.position.x -= center.x;
        root.position.z -= center.z;
        root.position.y -= bbox.min.y;

        if (tintForVHS) {
          root.traverse((node) => {
            if (node.isMesh && node.material) {
              const mats = Array.isArray(node.material) ? node.material : [node.material];
              for (const m of mats) {
                if ('envMapIntensity' in m) m.envMapIntensity = 0.4;
                if ('roughness' in m) m.roughness = Math.min(1, (m.roughness ?? 0.8) * 1.1 + 0.1);
                if (m.emissive && m.emissiveIntensity > 0) m.emissiveIntensity *= 0.5;
                m.needsUpdate = true;
              }
            }
          });
        }

        resolve({ root, size: size.clone() });
      },
      undefined,
      (err) => reject(err)
    );
  });

  _templateCache.set(url, p);
  return p;
}

/**
 * Clones a previously loaded template. The returned object is a fresh
 * THREE.Object3D rooted at y=0 that you can add anywhere in the scene graph.
 */
export function cloneGLBTemplate(template) {
  const clone = template.root.clone(true);
  // Materials are shared by reference — that's fine for performance; if a
  // caller wants per-instance material tweaks they can clone the material
  // themselves.
  return clone;
}

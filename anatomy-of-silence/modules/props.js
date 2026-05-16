/* =========================================================
 * props.js
 * Loads external GLB props (e.g. the wooden cabinet) and
 * places them in the world. Adds an invisible AABB blocker
 * to the level root so the player cannot walk through them.
 * ========================================================= */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const loader = new GLTFLoader();

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

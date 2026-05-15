/* =========================================================
 * recorder.js
 * Tape recorder with:
 *   - Q : cycle through known tapes; play (puzzle/lure)
 *   - R : record nearby world sound for 5 seconds
 *   - Throw recorder as physical lure (drops a "playing" object
 *     that emits noise events; AI walks toward it)
 *   - Battery, status messages
 *
 *   Tapes (story): pre-authored events arrays, plus any tape
 *   the player records themselves are appended to inventory.
 * ========================================================= */

import * as THREE from 'three';
import { RU } from './i18n.js';

// Pre-baked story tapes — each is an events list compatible
// with audio.playTape(). Whispers / footsteps / breaths form
// little soundscapes.
function tape(events) { return { kind: 'story', events }; }

export const STORY_TAPES = {
  [RU.tape_1]: tape([
    { t: 0.2, kind: 'breath', intensity: 0.6 },
    { t: 1.4, kind: 'footstep', surface: 'concrete', intensity: 0.7 },
    { t: 2.1, kind: 'footstep', surface: 'concrete', intensity: 0.7 },
    { t: 3.0, kind: 'drop', intensity: 0.5 },
    { t: 4.5, kind: 'breath', intensity: 0.9 },
  ]),
  [RU.tape_2]: tape([
    { t: 0.0, kind: 'breath', intensity: 0.4 },
    { t: 1.0, kind: 'breath', intensity: 0.5 },
    { t: 2.4, kind: 'footstep', surface: 'tile', intensity: 0.8 },
    { t: 3.0, kind: 'footstep', surface: 'tile', intensity: 0.8 },
    { t: 4.0, kind: 'drop', intensity: 0.7 },
    { t: 5.5, kind: 'breath', intensity: 0.95 },
  ]),
  [RU.tape_3]: tape([
    { t: 0.5, kind: 'breath', intensity: 0.85 },
    { t: 2.0, kind: 'drop', intensity: 0.9 },
    { t: 2.4, kind: 'footstep', surface: 'concrete', intensity: 0.9 },
    { t: 2.9, kind: 'footstep', surface: 'concrete', intensity: 0.9 },
    { t: 3.4, kind: 'footstep', surface: 'concrete', intensity: 0.9 },
    { t: 4.5, kind: 'drop', intensity: 0.4 },
  ]),
  [RU.tape_F]: tape([
    { t: 0.0, kind: 'breath', intensity: 1.0 },
    { t: 1.0, kind: 'breath', intensity: 1.0 },
    { t: 2.0, kind: 'breath', intensity: 1.0 },
    { t: 3.0, kind: 'drop', intensity: 1.0 },
  ]),
};

// Subtitle text shown when listening to each tape (atmospheric).
export const TAPE_SUBTITLES = {
  [RU.tape_1]: RU.tape_text_1,
  [RU.tape_2]: RU.tape_text_2,
  [RU.tape_3]: RU.tape_text_3,
  [RU.tape_F]: RU.tape_text_F,
};

export class Recorder {
  constructor(scene, audio, noise) {
    this.scene = scene;
    this.audio = audio;
    this.noise = noise;

    this.owned = false;
    this.battery = 100;
    this.idle = true;            // not currently playing/recording

    this.tapes = [];             // [{name, events, kind}]
    this._currentIndex = -1;     // selected tape

    this.recordedEvents = null;  // active recording buffer reference
    this._recTimeout = null;

    // physical "lure" props in scene
    this.lures = []; // [{mesh, expiresAt, events, pos}]
  }

  pickUp() { this.owned = true; }
  addBattery(a = 60) { this.battery = Math.min(100, this.battery + a); }

  /** Add a tape to inventory — story or recorded */
  addTape(name, events) {
    if (this.tapes.find(t => t.name === name)) return; // dedupe story tapes
    this.tapes.push({ name, events: events.slice(), kind: STORY_TAPES[name] ? 'story' : 'recorded' });
    if (this._currentIndex < 0) this._currentIndex = 0;
  }

  currentTape() {
    return this._currentIndex >= 0 ? this.tapes[this._currentIndex] : null;
  }

  /** Q: cycle through tapes; long press to play.
   *  We'll keep it simple: tap Q = cycle, hold Q already covered by game logic.
   *  For this implementation: Q = play current tape (if any). Cycle with tap when idle. */
  cycle() {
    if (!this.tapes.length) return null;
    this._currentIndex = (this._currentIndex + 1) % this.tapes.length;
    return this.currentTape();
  }

  /** Play current tape FROM player position (no lure). Returns subtitle text. */
  playCurrent(playerPos) {
    if (!this.owned || this.battery <= 0) return null;
    const t = this.currentTape();
    if (!t) return null;
    if (!this.idle) return null;
    this.idle = false;
    this.battery = Math.max(0, this.battery - 8);
    this.audio?.playTape(t.events, playerPos.clone(), () => { this.idle = true; });
    // emit noise events at player position so AI hears tape
    this.noise?.noiseFromTape(playerPos);
    return TAPE_SUBTITLES[t.name] || `[запись ${Math.round(this._totalDuration(t.events))}с]`;
  }

  /** R: start 5s recording. Call again to stop early. */
  toggleRecord(playerPos) {
    if (!this.owned || this.battery <= 0) return null;
    if (this.recordedEvents) {
      // stop early
      const events = this.audio.stopRecording();
      this.recordedEvents = null;
      const name = `Запись ${this.tapes.filter(t => t.kind === 'recorded').length + 1}`;
      this.addTape(name, events);
      this._currentIndex = this.tapes.length - 1;
      clearTimeout(this._recTimeout);
      this._recTimeout = null;
      return { state: 'stopped', name };
    }
    // start
    this.audio.startRecording();
    this.recordedEvents = []; // sentinel — actual buffer in audio
    this.battery = Math.max(0, this.battery - 4);
    this._recTimeout = setTimeout(() => {
      const events = this.audio.stopRecording();
      this.recordedEvents = null;
      const name = `Запись ${this.tapes.filter(t => t.kind === 'recorded').length + 1}`;
      this.addTape(name, events);
      this._currentIndex = this.tapes.length - 1;
      this._recTimeout = null;
    }, 5000);
    return { state: 'started' };
  }

  /** Throw the current tape as a physical lure that plays where it lands. */
  throwLure(playerPos, forwardDir) {
    if (!this.owned) return null;
    const t = this.currentTape();
    if (!t) return null;
    if (this.battery < 5) return null;
    this.battery = Math.max(0, this.battery - 5);

    const dest = playerPos.clone().addScaledVector(forwardDir, 4);
    dest.y = 0.2;

    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 0.08, 0.12),
      new THREE.MeshLambertMaterial({ color: 0x444444 })
    );
    mesh.position.copy(dest);
    this.scene.add(mesh);

    // Repeated playback: each cycle re-emits noise + audio at dest
    const cycle = () => {
      if (!mesh.parent) return; // removed
      this.audio?.playTape(t.events, dest.clone(), () => {});
      this.noise?.noiseFromTape(dest);
    };
    cycle();
    const interval = setInterval(cycle, 7000);

    const lure = { mesh, interval, expiresAt: performance.now() + 30000, pos: dest, events: t.events };
    this.lures.push(lure);
    return lure;
  }

  update(dt) {
    const now = performance.now();
    for (let i = this.lures.length - 1; i >= 0; i--) {
      const lure = this.lures[i];
      if (now >= lure.expiresAt) {
        clearInterval(lure.interval);
        this.scene.remove(lure.mesh);
        lure.mesh.geometry.dispose();
        lure.mesh.material.dispose();
        this.lures.splice(i, 1);
      }
    }
  }

  _totalDuration(events) {
    if (!events.length) return 0;
    return events[events.length - 1].t || 0;
  }
}

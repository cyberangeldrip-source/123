/* =========================================================
 *  ANATOMY OF SILENCE
 *  Main entry — wires modules into a working game loop.
 *
 *  Boot sequence:
 *    1. Build engine, scene, lighting, level
 *    2. Create player + Octree from level geometry
 *    3. Create audio (deferred until user gesture)
 *    4. Spawn AI
 *    5. Hook UI menu callbacks → start / pause / quit / settings
 *    6. Run RAF loop
 * ========================================================= */

import * as THREE from 'three';

import { Engine }          from './modules/engine.js';
import { LightingSystem }  from './modules/lighting.js';
import { Player }          from './modules/player.js';
import { InputManager }    from './modules/input.js';
import { buildLevel, toggleDoor } from './modules/level.js';
import { AudioSystem }     from './modules/audio.js';
import { NoiseSystem,
         StressSystem,
         CalmingSystem }   from './modules/noiseStress.js';
import { Flashlight }      from './modules/flashlight.js';
import { Recorder, STORY_TAPES } from './modules/recorder.js';
import { AIManager }       from './modules/ai.js';
import { UI }              from './modules/ui.js';
import { InteractionSystem } from './modules/interaction.js';
import { Save }            from './modules/save.js';

// ----------------------------------------------------------------
// Game state
// ----------------------------------------------------------------
const STATE = {
  MENU: 'menu',
  PLAYING: 'playing',
  PAUSED: 'paused',
  ENDING: 'ending',
};

class Game {
  constructor() {
    this.canvas = document.getElementById('game-canvas');

    // settings (loaded or defaults)
    const saved = Save.loadSettings();
    this.settings = Object.assign({
      sensitivity: 0.002, master: 0.8, sfx: 0.9, amb: 0.7,
      vhs: true, quality: 'medium',
    }, saved || {});

    // ENGINE
    this.engine = new Engine(this.canvas, { quality: this.settings.quality, vhs: this.settings.vhs });
    this.scene  = this.engine.scene;
    this.camera = this.engine.camera;

    // LIGHTING
    this.lighting = new LightingSystem(this.scene);

    // LEVEL
    this.levelData = buildLevel(this.scene);
    for (const lp of this.levelData.lampPositions) this.lighting.addLamp(lp.pos, lp.opts);

    // PLAYER
    this.input = new InputManager();
    this.player = new Player(this.camera, this.canvas);
    this.player.sensitivity = this.settings.sensitivity;
    // attach yaw object so camera renders from correct world transform
    this.scene.add(this.player.yawObject);
    this.player.setLevelOctree(this.levelData.root);
    this.player.teleport(this.levelData.spawn.x, this.levelData.spawn.y, this.levelData.spawn.z);

    // SOUND / STRESS / CALM
    this.audio    = new AudioSystem();   // started on user gesture
    this.noise    = new NoiseSystem();
    this.stress   = new StressSystem();
    this.calming  = new CalmingSystem();

    // FLASHLIGHT / RECORDER
    this.flashlight = new Flashlight(this.scene, this.camera, this.audio);
    this.recorder   = new Recorder(this.scene, this.audio, this.noise);

    // AI
    this.ai = new AIManager(this.scene, this.audio, this.noise);
    this.ai.setOctree(this.player.octree);
    this.ai.spawnWeepers(this.levelData.weeperSpawns);
    this.ai.spawnHorcror(this.levelData.horcrorSpawn);

    this.ai.callbacks.onWeeperScream = (weeper) => {
      // Acoustic jumpscare effect
      this.engine.pulse(0.8, 0.7);
      this.audio.setTinnitus(0.85);
      setTimeout(() => this.audio.setTinnitus(0), 1800);
      this.stress.applyLoudSound(60);
      // also weeper scream is itself a noise event Horcror may hear
    };
    this.ai.callbacks.onHorcrorAttack = () => {
      this.audio.jumpscare();
      this.engine.pulse(1.0, 1.2);
      this.audio.setTinnitus(0.95);
      setTimeout(() => this.audio.setTinnitus(0), 2500);
      this.stress.applyLoudSound(100);
      this.ui.setStressFlash(true);
      setTimeout(() => this.ui.setStressFlash(false), 700);
    };

    // UI
    this.ui = new UI();
    this.ui.applySettings(this.settings);
    this.ui.setVHSEnabled(this.settings.vhs);
    this.ui.setContinueAvailable(Save.hasRun());

    this.ui.on('onStart', () => this._beginRun(false));
    this.ui.on('onContinue', () => this._beginRun(true));
    this.ui.on('onResume', () => this._resume());
    this.ui.on('onQuit', () => this._quitToMenu());
    this.ui.on('onSettingsChange', (s) => this._applySettings(s));
    this.ui.on('onEndingClose', () => this._quitToMenu());

    // INTERACTION
    this.interaction = new InteractionSystem(this.camera, this.levelData);

    // STATE
    this.state = STATE.MENU;
    this.ui.showMainMenu();
    this.ui.showHUD(false);

    // POINTER LOCK / ESC handling
    document.addEventListener('pointerlockchange', () => {
      if (this.state === STATE.PLAYING && document.pointerLockElement !== this.canvas) {
        // user hit ESC or lost focus — pause
        this._pause();
      }
    });

    // misc state
    this._lastT = performance.now();
    this._fixedTriggers = new Set(); // already-fired one-shot triggers

    // RAF
    requestAnimationFrame(this._tick.bind(this));
  }

  // ----------------------------------------------------------------
  // Lifecycle
  // ----------------------------------------------------------------

  _beginRun(continueRun) {
    // Audio context must be created from a user gesture — this click qualifies
    this.audio.start();
    this.audio.setVolume('master', this.settings.master);
    this.audio.setVolume('sfx',    this.settings.sfx);
    this.audio.setVolume('amb',    this.settings.amb);

    if (continueRun) {
      const data = Save.loadRun();
      if (data) this._applyRunState(data);
    } else {
      Save.clearRun();
      this._fixedTriggers.clear();
      // Fresh spawn
      this.player.teleport(this.levelData.spawn.x, 0, this.levelData.spawn.z);
      this.flashlight.owned = false;
      this.flashlight.battery = 100;
      this.recorder.owned = false;
      this.recorder.battery = 100;
      this.recorder.tapes = [];
      this.recorder._currentIndex = -1;
      for (const p of this.levelData.pickups) {
        if (p.taken) { p.taken = false; this.levelData.doorsRoot ? this.levelData.doorsRoot.add(p.mesh) : this.levelData.root.add(p.mesh); }
      }
      this.stress.value = 0;
    }

    this.ui.hideAllMenus();
    this.ui.showHUD(true);
    this.state = STATE.PLAYING;
    this.player.requestPointerLock();
  }

  _pause() {
    if (this.state !== STATE.PLAYING) return;
    this.state = STATE.PAUSED;
    this.ui.showPauseMenu();
    document.exitPointerLock?.();
    this._persist(); // autosave on pause
  }

  _resume() {
    if (this.state !== STATE.PAUSED) return;
    this.ui.hideAllMenus();
    this.ui.showHUD(true);
    this.state = STATE.PLAYING;
    this.player.requestPointerLock();
  }

  _quitToMenu() {
    this.state = STATE.MENU;
    this.ui.hideAllMenus();
    this.ui.showHUD(false);
    this.ui.showMainMenu();
    this.ui.setContinueAvailable(Save.hasRun());
    document.exitPointerLock?.();
  }

  _applySettings(s) {
    this.settings = { ...this.settings, ...s };
    Save.saveSettings(this.settings);

    this.player.sensitivity = this.settings.sensitivity;
    this.engine.setVHSEnabled(this.settings.vhs);
    this.ui.setVHSEnabled(this.settings.vhs);
    if (this.audio.ctx) {
      this.audio.setVolume('master', this.settings.master);
      this.audio.setVolume('sfx',    this.settings.sfx);
      this.audio.setVolume('amb',    this.settings.amb);
    }
    this.engine.setQuality(this.settings.quality);
  }

  // ----------------------------------------------------------------
  // Save / restore run state
  // ----------------------------------------------------------------

  _persist() {
    if (this.state !== STATE.PLAYING && this.state !== STATE.PAUSED) return;
    const data = {
      pos:    [this.player.collider.start.x, this.player.collider.start.y, this.player.collider.start.z],
      yaw:    this.player.yawObject.rotation.y,
      pitch:  this.player.pitchObject.rotation.x,
      flashlight: { owned: this.flashlight.owned, battery: this.flashlight.battery, on: this.flashlight.on },
      recorder:   { owned: this.recorder.owned,   battery: this.recorder.battery,
                    tapes: this.recorder.tapes.map(t => ({ name: t.name, events: t.events, kind: t.kind })),
                    index: this.recorder._currentIndex },
      stress:     this.stress.value,
      pickupsTaken: this.levelData.pickups.filter(p => p.taken).map(p => p.label),
      triggers:   Array.from(this._fixedTriggers),
    };
    Save.saveRun(data);
  }

  _applyRunState(data) {
    if (!data) return;
    this.player.teleport(data.pos[0], 0, data.pos[2], data.yaw || 0);
    this.player.pitchObject.rotation.x = data.pitch || 0;

    this.flashlight.owned   = !!data.flashlight?.owned;
    this.flashlight.battery = data.flashlight?.battery ?? 100;
    this.flashlight.on      = false;

    this.recorder.owned   = !!data.recorder?.owned;
    this.recorder.battery = data.recorder?.battery ?? 100;
    this.recorder.tapes   = (data.recorder?.tapes || []).map(t => ({ ...t }));
    this.recorder._currentIndex = data.recorder?.index ?? -1;

    this.stress.value = data.stress || 0;

    this._fixedTriggers = new Set(data.triggers || []);

    // Mark already-taken pickups
    const takenSet = new Set(data.pickupsTaken || []);
    for (const p of this.levelData.pickups) {
      if (takenSet.has(p.label)) {
        if (!p.taken) {
          p.taken = true;
          p.mesh.removeFromParent();
        }
      } else {
        if (p.taken) { p.taken = false; (this.levelData.doorsRoot || this.levelData.root).add(p.mesh); }
      }
    }
  }

  // ----------------------------------------------------------------
  // Per-frame
  // ----------------------------------------------------------------

  _tick(now) {
    const dt = Math.min(0.05, (now - this._lastT) / 1000);
    this._lastT = now;

    if (this.state === STATE.PLAYING) this._updatePlaying(dt);
    else this._updateInactive(dt);

    this.engine.update(dt);
    this.engine.render();

    this.ui.update(dt);

    this.input.endFrame();
    requestAnimationFrame(this._tick.bind(this));
  }

  _updateInactive(dt) {
    // Slowly bob camera in menus for vibe
    this.camera.position.x = Math.sin(performance.now() * 0.0003) * 0.2;
  }

  _updatePlaying(dt) {
    // ----- Input -----
    const axes = this.input.getMovementAxes();
    this.player.setInput({
      forward: axes.forward,
      right:   axes.right,
      sprint:  this.input.isSprintHeld(),
      crouch:  axes.crouch,
      jump:    axes.jump,
    });
    this.calming.setHeld(this.input.isCalmHeld());
    this.player.calming = this.calming.active;

    // ----- One-shot keys -----
    if (this.input.consume('Escape')) {
      this._pause();
      return;
    }
    if (this.input.consume('KeyF')) {
      if (this.flashlight.owned) {
        this.flashlight.toggle();
        this.audio.click();
      } else {
        this.ui.showSubtitle('You have nothing to light the dark with.');
      }
    }
    if (this.input.consume('KeyQ')) {
      if (!this.recorder.owned) {
        this.ui.showSubtitle('You need a tape recorder.');
      } else if (this.recorder.tapes.length === 0) {
        this.ui.showSubtitle('No tapes.');
      } else {
        // SHIFT? cycle else play
        const eyePos = this.player.getEyePosition();
        const sub = this.recorder.playCurrent(eyePos);
        if (sub) {
          this.ui.showSubtitle(sub, 6);
          const tName = this.recorder.currentTape().name;
          this.ui.setRecorderStatus(`PLAYING: ${tName.slice(0, 28)}`);
          setTimeout(() => this.ui.setRecorderStatus('TAPE READY'), 6000);
          // Listening to the FINAL tape near the final-trigger zone = "merge" ending
          if (/FINAL/.test(tName) && this._inFinalChoiceZone()) {
            setTimeout(() => this._endGame('MERGE', 'BLIND FREQUENCY ENDING',
              'You listened until you became listening. Now distorted breath travels the empty corridors. ' +
              'Somewhere, someone hears it. They cannot stop.'), 4000);
          }
        }
      }
    }
    if (this.input.consume('KeyR')) {
      if (!this.recorder.owned) this.ui.showSubtitle('You need a tape recorder.');
      else {
        const eyePos = this.player.getEyePosition();
        const r = this.recorder.toggleRecord(eyePos);
        if (r?.state === 'started') this.ui.setRecorderStatus('RECORDING ●');
        else if (r?.state === 'stopped') this.ui.setRecorderStatus(`SAVED: ${r.name}`);
      }
    }
    // T: throw recorder lure (extra utility — brief mentions throw as lure)
    if (this.input.consume('KeyT')) {
      if (this.recorder.owned && this.recorder.tapes.length) {
        const eye = this.player.getEyePosition();
        const fwd = this.player.getForward();
        if (this.recorder.throwLure(eye, fwd)) {
          this.ui.showSubtitle('You drop the recorder. It plays.');
          this.audio.click();
        }
      }
    }
    // Cycle tapes with [
    if (this.input.consume('BracketLeft')) {
      const t = this.recorder.cycle();
      if (t) this.ui.showSubtitle(`> ${t.name}`, 2);
    }

    // ----- Update player physics -----
    this.player.update(dt);

    // ----- Audio listener -----
    const eye = this.player.getEyePosition();
    const fwd = this.player.getForward();
    this.audio.updateListener(eye, fwd);

    // ----- Noise / footsteps emission -----
    this.noise.update(dt, this.player, this.audio,
      (xz) => this._surfaceAt(xz),
      this.stress.norm
    );

    // ----- Light / dark / stress accumulation -----
    const litness = this._estimateLitness(eye);   // 0 dark .. 1 lit
    if (!this.calming.active) {
      this.stress.applyDarkness(1 - litness, dt);
      // proximity to enemies
      const closest = this.ai.closestEnemyDistance(this.player.collider.start);
      if (closest < 12) this.stress.applyEnemyProximity(closest, dt);
      // isolation drip
      this.stress.applyIsolation(dt);
    }
    this.stress.decay(dt, this.calming.stressDecayMultiplier);
    this.stress.update(dt, this.audio);

    // ----- Calming overlay -----
    this.calming.update(dt, this.stress);
    this.ui.setCalmingFactor(this.calming.blindFactor);

    // ----- Engine / VHS reflects stress -----
    this.engine.setStress(this.stress.norm * 0.9 + (this.calming.blindFactor * 0.1));

    // ----- Flashlight + recorder -----
    this.flashlight.update(dt, performance.now() / 1000, this.noise);
    this.recorder.update(dt);

    // ----- Lighting flicker -----
    this.lighting.update(performance.now() / 1000);

    // ----- Doors: animate any in-flight opens -----
    for (const d of this.levelData.doors) {
      if (Math.abs((d.open ? Math.PI / 1.3 : 0) - d.hinge.rotation.y) > 0.005) {
        toggleDoor(d, dt);
      }
    }

    // ----- AI -----
    this.ai.update(dt, this.player, this.stress);

    // Audio ambient updates (panners)
    this.audio.update(dt);

    // ----- Interaction prompt + E -----
    const target = this.interaction.pick();
    if (target) {
      this.ui.showPrompt(`[E] ${target.label}`);
      if (this.input.consume('KeyE')) this._handleInteract(target);
    } else {
      this.ui.hidePrompt();
      this.input.consume('KeyE'); // discard
    }

    // ----- Trigger zones -----
    for (let i = 0; i < this.levelData.triggers.length; i++) {
      const tr = this.levelData.triggers[i];
      const px = this.player.collider.start.x;
      const pz = this.player.collider.start.z;
      const inside = px > tr.min.x && px < tr.max.x && pz > tr.min.y && pz < tr.max.y;
      const id = `${i}`;
      if (inside) {
        if (tr.once && this._fixedTriggers.has(id)) continue;
        if (tr.type === 'subtitle') {
          this.ui.showSubtitle(tr.text, 5);
          if (tr.once) this._fixedTriggers.add(id);
        } else if (tr.type === 'final_choice') {
          // Player must have collected the FINAL tape to choose ending
          const hasFinal = this.recorder.tapes.find(t => /FINAL/.test(t.name));
          if (hasFinal) {
            this.ui.showSubtitle('Listen [Q] to merge with silence — or stand here in calm [SHIFT] to burn the tapes.', 6);
            if (this.calming.active) this._endGame('SILENCE', 'BURNING ENDING',
              'You held the breath. Silence consumed you. The city faded into a blank tape.');
          }
        }
      }
    }

    // Check death (stress 100)
    if (this.stress.value >= 100) {
      this._endGame('LOST', 'CONSUMED',
        'The frequency found the rhythm of your fear. You are heard, then you are not.');
    }

    // Autosave every ~10s
    this._autoSaveTimer = (this._autoSaveTimer || 0) + dt;
    if (this._autoSaveTimer > 10) {
      this._autoSaveTimer = 0;
      this._persist();
      this.ui.setContinueAvailable(true);
    }

    // ----- HUD -----
    this.ui.setBars({
      noise: this.noise.meter,
      stress: this.stress.value,
      flashBattery: this.flashlight.battery,
      recBattery:   this.recorder.battery,
    });
  }

  // ----------------------------------------------------------------
  // Interactions
  // ----------------------------------------------------------------
  _handleInteract(target) {
    if (target.kind === 'pickup') {
      const p = target.ref;
      p.taken = true;
      p.mesh.removeFromParent();
      this.audio.click();
      switch (p.type) {
        case 'flashlight':
          this.flashlight.pickUp();
          this.ui.showSubtitle('Flashlight. Light has weight here.');
          break;
        case 'recorder':
          this.recorder.pickUp();
          this.ui.showSubtitle('Tape recorder. Sound is the only language they understand.');
          break;
        case 'tape':
          this.recorder.addTape(p.label, STORY_TAPES[p.label]?.events || []);
          this.ui.showSubtitle(`Picked up: ${p.label}`);
          break;
        case 'flashlight_battery':
          this.flashlight.addBattery(60);
          this.ui.showSubtitle('Flashlight battery.');
          break;
        case 'recorder_battery':
          this.recorder.addBattery(60);
          this.ui.showSubtitle('Recorder battery.');
          break;
        case 'key':
          // (unused for now)
          this.ui.showSubtitle('A key, cold like a thought.');
          break;
      }
    } else if (target.kind === 'door') {
      const d = target.ref;
      if (d.locked) {
        this.ui.showSubtitle('It will not open.');
        return;
      }
      d.open = !d.open;
      this.audio.click();
      // Door creak (small drop-style sfx)
      this.audio.drop(d.worldPos);
    }
  }

  // ----------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------

  /** Estimate "litness" 0..1 by sampling nearby lamps + flashlight beam */
  _estimateLitness(pos) {
    let best = 0;
    if (this.flashlight.on) best = Math.max(best, 0.6);
    for (const lamp of this.lighting.lamps) {
      if (lamp.dead) continue;
      const d = lamp.bulb.position.distanceTo(pos);
      const lit = Math.max(0, 1 - d / (lamp.light.distance || 8)) * (lamp.light.intensity / 1.4);
      best = Math.max(best, lit);
    }
    return Math.min(1, best);
  }

  /** Lookup surface type at a 2D position (for noise multiplier) */
  _surfaceAt(xz) {
    // tile bathroom in NW apt: x in [-11.5..-8.5], z in [-19.5..-16.5]
    if (xz.x > -11.5 && xz.x < -8.5 && xz.y > -19.5 && xz.y < -16.5) return 'tile';
    return 'concrete';
  }

  /** True when player stands inside the level's `final_choice` trigger zone */
  _inFinalChoiceZone() {
    const px = this.player.collider.start.x;
    const pz = this.player.collider.start.z;
    for (const tr of this.levelData.triggers) {
      if (tr.type !== 'final_choice') continue;
      if (px > tr.min.x && px < tr.max.x && pz > tr.min.y && pz < tr.max.y) return true;
    }
    return false;
  }

  // ----------------------------------------------------------------
  // Endings
  // ----------------------------------------------------------------
  _endGame(kind, title, body) {
    if (this.state !== STATE.PLAYING) return;
    this.state = STATE.ENDING;
    document.exitPointerLock?.();
    Save.clearRun();
    this.ui.showEnding(title, body);
  }
}

// ----------------------------------------------------------------
// Boot
// ----------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
  // First user click anywhere on the menu enables audio (handled in _beginRun)
  new Game();
});

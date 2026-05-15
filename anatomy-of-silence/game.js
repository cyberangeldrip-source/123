/* =========================================================
 *  ANATOMY OF SILENCE
 *  Main entry — wires modules into a working game loop.
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
         CalmingSystem,
         StaminaSystem }   from './modules/noiseStress.js';
import { Flashlight }      from './modules/flashlight.js';
import { Recorder, STORY_TAPES } from './modules/recorder.js';
import { AIManager }       from './modules/ai.js';
import { UI }              from './modules/ui.js';
import { InteractionSystem } from './modules/interaction.js';
import { Save }            from './modules/save.js';
import { RU, t }           from './modules/i18n.js';

const STATE = {
  MENU: 'menu',
  PLAYING: 'playing',
  PAUSED: 'paused',
  ENDING: 'ending',
};

class Game {
  constructor() {
    this.canvas = document.getElementById('game-canvas');

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
    this.scene.add(this.player.yawObject);
    this.player.setLevelOctree(this.levelData.root);
    this.player.teleport(this.levelData.spawn.x, this.levelData.spawn.y, this.levelData.spawn.z);

    // HP system
    this.hp = 100;
    this.maxHp = 100;

    // SOUND / STRESS / CALM / STAMINA
    this.audio    = new AudioSystem();
    this.noise    = new NoiseSystem();
    this.stress   = new StressSystem();
    this.calming  = new CalmingSystem();
    this.stamina  = new StaminaSystem();

    // FLASHLIGHT / RECORDER
    this.flashlight = new Flashlight(this.scene, this.camera, this.audio);
    this.recorder   = new Recorder(this.scene, this.audio, this.noise);

    // AI — set nav points BEFORE spawning
    this.ai = new AIManager(this.scene, this.audio, this.noise);
    this.ai.setOctree(this.player.octree);
    this.ai.setNavPoints(this.levelData.navPoints);
    this.ai.setDoors(this.levelData.doors);
    this.ai.spawnWeepers(this.levelData.weeperSpawns);
    this.ai.spawnHorcror(this.levelData.horcrorSpawn);

    this.ai.callbacks.onWeeperScream = (weeper) => {
      // Distance + LOS gate: a Weeper's scream should only physically harm
      // the player if the player is reasonably close AND can be reached by
      // sound (no thick walls between them). Stress/tinnitus also fall off
      // with distance instead of being applied uniformly across the whole map.
      const playerPos = this.player.collider.start;
      const wpos = weeper.group.position;
      const dx = playerPos.x - wpos.x;
      const dz = playerPos.z - wpos.z;
      const dist = Math.hypot(dx, dz);

      // Hearing falls off past 18m
      const HEAR_MAX = 18;
      if (dist > HEAR_MAX) return;

      // Line-of-sight check via the player's octree
      const from = new THREE.Vector3(wpos.x, 1.6, wpos.z);
      const dir  = new THREE.Vector3(dx, 0, dz);
      const len  = dir.length();
      let los = true;
      if (len > 0.01 && this.player.octree?.rayIntersect) {
        dir.normalize();
        const ray = new THREE.Ray(from, dir);
        const hit = this.player.octree.rayIntersect(ray);
        if (hit && hit.distance < len) los = false;
      }

      // Falloff factor (1.0 at 0m, 0.0 at HEAR_MAX). Walls roughly halve it.
      let falloff = 1 - dist / HEAR_MAX;
      if (!los) falloff *= 0.45;

      // Tinnitus + screen pulse only if heard meaningfully
      if (falloff > 0.05) {
        this.engine.pulse(0.8 * falloff, 0.7 * falloff);
        this.audio.setTinnitus(0.85 * falloff);
        setTimeout(() => this.audio.setTinnitus(0), 1800);
      }

      // Stress scales with proximity
      this.stress.applyLoudSound(60 * falloff);

      // HP damage ONLY at close range with line-of-sight, ramps from 0..15
      // - Beyond 8m: no HP damage
      // - Through walls: no HP damage (only stress)
      // - 0m direct: full 15 HP
      let hpDamage = 0;
      if (los && dist < 8) {
        hpDamage = 15 * Math.max(0, 1 - dist / 8);
      }
      if (hpDamage > 0.5) {
        this.hp = Math.max(0, this.hp - hpDamage);
        this.ui.shakeCamera();
        this.ui.setDangerPulse(true);
        setTimeout(() => this.ui.setDangerPulse(false), 600);
      }
    };
    this.ai.callbacks.onHorcrorAttack = () => {
      this.audio.jumpscare();
      this.engine.pulse(1.0, 1.2);
      this.audio.setTinnitus(0.95);
      setTimeout(() => this.audio.setTinnitus(0), 2500);
      this.stress.applyLoudSound(50);
      this.hp = Math.max(0, this.hp - 20);
      this.ui.setStressFlash(true);
      this.ui.setDangerPulse(true);
      this.ui.shakeCamera();
      setTimeout(() => this.ui.setStressFlash(false), 700);
      setTimeout(() => this.ui.setDangerPulse(false), 1200);
    };
    // When the entity opens or closes a door, replay the door SFX and flag
    // the octree for rebuild on next door-animation tick.
    this.ai.callbacks.onDoorChange = (door, action) => {
      this.audio.drop(door.worldPos);
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

    // POINTER LOCK
    document.addEventListener('pointerlockchange', () => {
      // If a note overlay is visible, don't pause — note explicitly releases pointer lock
      if (this.ui.isNoteVisible()) return;
      if (this.state === STATE.PLAYING && document.pointerLockElement !== this.canvas) {
        this._pause();
      }
    });

    this._lastT = performance.now();
    this._fixedTriggers = new Set();

    // Atmosphere timers
    this._atmoTimers = {
      drip: 1.5 + Math.random() * 2, groan: 8 + Math.random() * 12,
      slam: 20 + Math.random() * 30, radio: 30 + Math.random() * 40,
      behind: 6 + Math.random() * 6, whisper: 5 + Math.random() * 6,
    };

    this._objective = null;
    this._refreshObjective();

    requestAnimationFrame(this._tick.bind(this));
  }

  // ----------------------------------------------------------------
  _beginRun(continueRun) {
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
      this.hp = this.maxHp;
      this.stamina.value = 100;
      // Reset all doors to closed
      for (const d of this.levelData.doors) {
        d.open = false;
        if (d.blocker && d.blocker.parent !== this.levelData.root) {
          d.blocker.parent?.remove(d.blocker);
          this.levelData.root.add(d.blocker);
        }
      }
      // Reset AI to idle/spawn positions
      this.ai.resetAll();
      // Rebuild octree after door state change
      this.player.setLevelOctree(this.levelData.root);
      this.ai.setOctree(this.player.octree);
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
    this._persist();
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
  _persist() {
    if (this.state !== STATE.PLAYING && this.state !== STATE.PAUSED) return;
    const data = {
      pos: [this.player.collider.start.x, this.player.collider.start.y, this.player.collider.start.z],
      yaw: this.player.yawObject.rotation.y,
      pitch: this.player.pitchObject.rotation.x,
      flashlight: { owned: this.flashlight.owned, battery: this.flashlight.battery, on: this.flashlight.on },
      recorder: { owned: this.recorder.owned, battery: this.recorder.battery,
                  tapes: this.recorder.tapes.map(t => ({ name: t.name, events: t.events, kind: t.kind })),
                  index: this.recorder._currentIndex },
      stress: this.stress.value,
      hp: this.hp,
      pickupsTaken: this.levelData.pickups.filter(p => p.taken).map(p => p.label),
      triggers: Array.from(this._fixedTriggers),
    };
    Save.saveRun(data);
  }

  _applyRunState(data) {
    if (!data) return;
    this.player.teleport(data.pos[0], 0, data.pos[2], data.yaw || 0);
    this.player.pitchObject.rotation.x = data.pitch || 0;
    this.flashlight.owned = !!data.flashlight?.owned;
    this.flashlight.battery = data.flashlight?.battery ?? 100;
    this.flashlight.on = false;
    this.recorder.owned = !!data.recorder?.owned;
    this.recorder.battery = data.recorder?.battery ?? 100;
    this.recorder.tapes = (data.recorder?.tapes || []).map(t => ({ ...t }));
    this.recorder._currentIndex = data.recorder?.index ?? -1;
    this.stress.value = data.stress || 0;
    this.hp = data.hp ?? this.maxHp;
    this._fixedTriggers = new Set(data.triggers || []);
    const takenSet = new Set(data.pickupsTaken || []);
    for (const p of this.levelData.pickups) {
      if (takenSet.has(p.label)) {
        if (!p.taken) { p.taken = true; p.mesh.removeFromParent(); }
      } else {
        if (p.taken) { p.taken = false; (this.levelData.doorsRoot || this.levelData.root).add(p.mesh); }
      }
    }
    // Reset AI on continue too
    this.ai.resetAll();
  }

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
    this.camera.position.x = Math.sin(performance.now() * 0.0003) * 0.2;
  }

  _updatePlaying(dt) {
    if (this.ui.isNoteVisible()) {
      if (this.input.consume('KeyE') || this.input.consume('Escape')) {
        this.ui.hideNote();
        this.player.requestPointerLock();
      }
      return;
    }

    // ----- Input -----
    const axes = this.input.getMovementAxes();
    const wantsSprint = this.input.isSprintHeld();

    // Stamina check: only allow sprint if stamina allows
    const canSprint = this.stamina.update(dt, wantsSprint && axes.forward > 0, this.stress.norm);
    const actualSprint = wantsSprint && canSprint;

    this.player.setInput({
      forward: axes.forward,
      right: axes.right,
      sprint: actualSprint,
      crouch: axes.crouch,
      jump: axes.jump,
    });

    // Track jump for noise system
    if (axes.jump && this.player.onGround) {
      this.noise.setJumping(true);
    }

    this.calming.setHeld(this.input.isCalmHeld());
    this.player.calming = this.calming.active;

    // ----- One-shot keys -----
    if (this.input.consume('Escape')) { this._pause(); return; }
    if (this.input.consume('KeyF')) {
      if (this.flashlight.owned) { this.flashlight.toggle(); this.audio.click(); }
      else this.ui.showSubtitle(RU.no_flashlight);
    }
    if (this.input.consume('KeyQ')) {
      if (!this.recorder.owned) { this.ui.showSubtitle(RU.no_recorder); }
      else if (this.recorder.tapes.length === 0) { this.ui.showSubtitle(RU.no_tapes); }
      else {
        const eyePos = this.player.getEyePosition();
        const sub = this.recorder.playCurrent(eyePos);
        if (sub) {
          this.ui.showSubtitle(sub, 6);
          const tName = this.recorder.currentTape().name;
          this.ui.setRecorderStatus(`${RU.playing}: ${tName.slice(0, 28)}`);
          setTimeout(() => this.ui.setRecorderStatus(RU.tape_ready), 6000);
          if (/ПОСЛЕДНЯЯ|FINAL/i.test(tName) && this._inFinalChoiceZone()) {
            setTimeout(() => this._endGame('MERGE', RU.ending_merge_t, RU.ending_merge_b), 4000);
          }
        }
      }
    }
    if (this.input.consume('KeyR')) {
      if (!this.recorder.owned) this.ui.showSubtitle(RU.no_recorder);
      else {
        const eyePos = this.player.getEyePosition();
        const r = this.recorder.toggleRecord(eyePos);
        if (r?.state === 'started') this.ui.setRecorderStatus(RU.recording);
        else if (r?.state === 'stopped') this.ui.setRecorderStatus(`${RU.saved}: ${r.name}`);
      }
    }
    if (this.input.consume('KeyT')) {
      if (this.recorder.owned && this.recorder.tapes.length) {
        const eye = this.player.getEyePosition();
        const fwd = this.player.getForward();
        if (this.recorder.throwLure(eye, fwd)) {
          this.ui.showSubtitle(RU.drop_recorder);
          this.audio.click();
        }
      }
    }
    if (this.input.consume('BracketLeft')) {
      const tp = this.recorder.cycle();
      if (tp) this.ui.showSubtitle(`> ${tp.name}`, 2);
    }

    // V key = final choice at altar (replaces G to avoid conflict with calming)
    if (this.input.consume('KeyV')) {
      if (this._inFinalChoiceZone()) {
        const hasFinal = this.recorder.tapes.find(tp => /ПОСЛЕДНЯЯ|FINAL/i.test(tp.name));
        if (hasFinal) {
          this._endGame('SILENCE', RU.ending_burn_t, RU.ending_burn_b);
        }
      }
    }

    // ----- Update player physics -----
    this.player.update(dt);

    // ----- Audio listener -----
    const eye = this.player.getEyePosition();
    const fwd = this.player.getForward();
    this.audio.updateListener(eye, fwd);

    // ----- Noise / footsteps emission -----
    this.noise.update(dt, this.player, this.audio,
      (xz) => this._surfaceAt(xz), this.stress.norm);

    // ----- Light / dark / stress -----
    const litness = this._estimateLitness(eye);
    if (!this.calming.active) {
      this.stress.applyDarkness(1 - litness, dt);
      const closest = this.ai.closestEnemyDistance(this.player.collider.start);
      if (closest < 12) this.stress.applyEnemyProximity(closest, dt);
      this.stress.applyIsolation(dt);
    }
    this.stress.decay(dt, this.calming.stressDecayMultiplier);
    this.stress.update(dt, this.audio);

    // ----- Calming -----
    this.calming.update(dt, this.stress);
    this.ui.setCalmingFactor(this.calming.blindFactor);

    // ----- Engine VHS -----
    this.engine.setStress(this.stress.norm * 0.9 + (this.calming.blindFactor * 0.1));

    // ----- Flashlight + recorder -----
    this.flashlight.update(dt, performance.now() / 1000, this.noise);
    this.recorder.update(dt);

    // ----- Lighting flicker -----
    this.lighting.update(performance.now() / 1000);

    // ----- Doors: animate + rebuild octree only when blocker actually moves -----
    let topologyChanged = false;
    for (const d of this.levelData.doors) {
      const targetAngle = d.open ? Math.PI / 1.3 : 0;
      if (Math.abs(targetAngle - d.hinge.rotation.y) > 0.005) {
        const changed = toggleDoor(d, dt, this.levelData.root, this.levelData.doorsRoot);
        if (changed) topologyChanged = true;
      }
    }
    if (topologyChanged) {
      // Rebuild octree only when a blocker just moved between groups (1 time per door cycle)
      this.player.setLevelOctree(this.levelData.root);
      this.ai.setOctree(this.player.octree);
    }

    // ----- AI -----
    this.ai.update(dt, this.player, this.stress);
    this.audio.update(dt);

    // ----- Atmosphere -----
    this._updateAtmosphere(dt, eye);

    // ----- Interaction -----
    const target = this.interaction.pick();
    if (target) {
      this.ui.showPrompt(`[E] ${target.label}`);
      if (this.input.consume('KeyE')) this._handleInteract(target);
    } else {
      this.ui.hidePrompt();
      this.input.consume('KeyE');
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
          const hasFinal = this.recorder.tapes.find(tp => /ПОСЛЕДНЯЯ|FINAL/i.test(tp.name));
          if (hasFinal) {
            this.ui.showSubtitle(RU.final_choice + ' [V]', 6);
          }
        }
      }
    }

    // Check death (HP or stress 100)
    if (this.hp <= 0) {
      this._endGame('LOST', RU.ending_lost_t, RU.ending_lost_b);
    }
    if (this.stress.value >= 100) {
      this._endGame('LOST', RU.ending_lost_t, RU.ending_lost_b);
    }

    // Autosave
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
      recBattery: this.recorder.battery,
      hp: this.hp,
      stamina: this.stamina.value,
    });
  }

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
          this.ui.showSubtitle(RU.pick_flashlight);
          break;
        case 'recorder':
          this.recorder.pickUp();
          this.ui.showSubtitle(RU.pick_recorder);
          break;
        case 'tape':
          this.recorder.addTape(p.label, STORY_TAPES[p.label]?.events || []);
          this.ui.showSubtitle(t('pick_tape', p.label));
          break;
        case 'flashlight_battery':
          this.flashlight.addBattery(60);
          this.ui.showSubtitle(RU.pick_flash_bat);
          break;
        case 'recorder_battery':
          this.recorder.addBattery(60);
          this.ui.showSubtitle(RU.pick_rec_bat);
          break;
        case 'key':
          this.ui.showSubtitle(RU.pick_key);
          break;
      }
      this._refreshObjective();
    } else if (target.kind === 'door') {
      const d = target.ref;
      if (d.locked) { this.ui.showSubtitle(RU.door_locked); return; }
      d.open = !d.open;
      this.audio.click();
      this.audio.drop(d.worldPos);
    } else if (target.kind === 'note') {
      this.audio.click();
      this.ui.showNote(target.ref.text);
    }
  }

  // ----------------------------------------------------------------
  _refreshObjective() {
    let obj = '';
    const tapes = this.recorder.tapes.length;
    const hasFinal = this.recorder.tapes.some(tp => /ПОСЛЕДНЯЯ|FINAL/i.test(tp.name));
    const hasFlash = this.flashlight.owned;
    const hasRec = this.recorder.owned;
    if (!hasFlash || !hasRec) obj = RU.obj_grab_gear;
    else if (tapes === 0) obj = RU.obj_first_tape;
    else if (tapes < 3) obj = RU.obj_apt_tapes;
    else if (!hasFinal) obj = RU.obj_final_tape;
    else obj = RU.obj_choose;
    if (obj !== this._objective) { this._objective = obj; this.ui.setObjective(obj); }
  }

  // ----------------------------------------------------------------
  _updateAtmosphere(dt, eye) {
    if (!this.audio.ctx) return;
    const s = this.stress.norm;
    const rndWorldPos = () => {
      const angle = Math.random() * Math.PI * 2;
      const dist = 10 + Math.random() * 15;
      return new THREE.Vector3(eye.x + Math.cos(angle) * dist, eye.y, eye.z + Math.sin(angle) * dist);
    };
    this._atmoTimers.drip -= dt;
    if (this._atmoTimers.drip <= 0) { this._atmoTimers.drip = 1.5 + Math.random() * 3; this.audio.drip(rndWorldPos()); }
    this._atmoTimers.groan -= dt * (1 + s);
    if (this._atmoTimers.groan <= 0) { this._atmoTimers.groan = 8 + Math.random() * 14; this.audio.metalGroan(rndWorldPos()); }
    this._atmoTimers.slam -= dt;
    if (this._atmoTimers.slam <= 0) { this._atmoTimers.slam = 20 + Math.random() * 30; this.audio.distantSlam(rndWorldPos()); this.stress.applyLoudSound(8); }
    this._atmoTimers.radio -= dt;
    if (this._atmoTimers.radio <= 0 && s > 0.3) { this._atmoTimers.radio = 25 + Math.random() * 35; this.audio.radioStatic(rndWorldPos(), 1.0 + Math.random() * 0.8); this.stress.applyLoudSound(5); }
    this._atmoTimers.behind -= dt * (0.5 + s * 2);
    if (this._atmoTimers.behind <= 0 && s > 0.45) {
      this._atmoTimers.behind = 5 + Math.random() * 8;
      this.audio.breathBehind();
      const whispers = RU.whispers;
      this.ui.showSubtitle(whispers[Math.floor(Math.random() * whispers.length)], 2);
    }
  }

  _estimateLitness(pos) {
    let best = 0;
    if (this.flashlight.on) best = Math.max(best, 0.7);
    for (const lamp of this.lighting.lamps) {
      if (lamp.dead) continue;
      const d = lamp.bulb.position.distanceTo(pos);
      const lit = Math.max(0, 1 - d / (lamp.light.distance || 10)) * (lamp.light.intensity / 2.4);
      best = Math.max(best, lit);
    }
    return Math.min(1, best);
  }

  _surfaceAt(xz) {
    if (xz.x > -11.5 && xz.x < -8.5 && xz.y > -19.5 && xz.y < -16.5) return 'tile';
    return 'concrete';
  }

  _inFinalChoiceZone() {
    const px = this.player.collider.start.x;
    const pz = this.player.collider.start.z;
    for (const tr of this.levelData.triggers) {
      if (tr.type !== 'final_choice') continue;
      if (px > tr.min.x && px < tr.max.x && pz > tr.min.y && pz < tr.max.y) return true;
    }
    return false;
  }

  _endGame(kind, title, body) {
    if (this.state !== STATE.PLAYING) return;
    this.state = STATE.ENDING;
    document.exitPointerLock?.();
    Save.clearRun();
    this.ui.showEnding(title, body);
  }
}

window.addEventListener('DOMContentLoaded', () => { new Game(); });

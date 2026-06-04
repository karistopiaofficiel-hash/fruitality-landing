// ORCHARD — an AI-native web 3D game engine.
// Games are defined as DATA (a GameSpec); the engine renders + runs them.
// This is the reliability trick behind prompt-to-game pipelines: the model
// (or a human) writes a compact spec against a known engine API, not raw
// Three.js from scratch each time.
//
// v0.1 capabilities: rigged GLB characters with an animation state machine
// (idle/move/attack/die), wave-based melee combat, juice-particle gore,
// hit-pause + camera shake + finisher slow-mo, HDRI lighting + bloom, HUD.
//
// Engine API:  const game = new Orchard(canvas, spec); game.start();

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);

export class Orchard {
  constructor(canvas, spec) {
    this.canvas = canvas;
    this.spec = spec;
    this.state = {
      running: false, finished: false, won: false, t: 0,
      hitPause: 0, slowmo: 0, flash: 0,
      shake: { mag: 0, t: 0 },
      wave: 0, enemies: [], parts: [], floaters: [], waveActive: false, toSpawn: 0,
      combo: { points: 0, rank: 'None', last: -10 },
      finishers: 0,
    };
    this.keys = new Set();
    this.touch = { x: 0, y: 0 };
    this._cb = {};
  }
  on(ev, fn) { this._cb[ev] = fn; return this; }
  emit(ev, ...a) { if (this._cb[ev]) this._cb[ev](...a); }

  // ---------------------------------------------------------------- boot
  async start() {
    this._initRenderer();
    this._initScene();
    this._initPostFX();
    this._initParticles();
    this._initInput();
    this.audio = new SfxKit();
    await this._loadAssets();
    this._spawnPlayer();
    this._hud = document.getElementById('hud');
    this._lastTs = performance.now();
    requestAnimationFrame((ts) => { this._lastTs = ts; this._loop(ts); });
    this.state.running = true;
    this._nextWave();
    this.emit('ready');
  }

  _initRenderer() {
    const r = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.setSize(innerWidth, innerHeight);
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = this.spec.arena.exposure ?? 1.15;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer = r;
    addEventListener('resize', () => this._resize());
  }

  _initScene() {
    const s = new THREE.Scene();
    const a = this.spec.arena;
    s.background = new THREE.Color(a.skyColor ?? 0x0a0410);
    s.fog = new THREE.FogExp2(a.fogColor ?? 0x180814, a.fogDensity ?? 0.02);
    this.scene = s;
    this.camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.1, 200);
    this.camera.position.set(0, 9, 14);

    // lights
    s.add(new THREE.HemisphereLight(a.hemiSky ?? 0xff97b3, a.hemiGround ?? 0x1a0612, 0.5));
    const key = new THREE.DirectionalLight(a.keyColor ?? 0xffaa77, 1.5);
    key.position.set(12, 18, 8); key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { near: 1, far: 60, left: -22, right: 22, top: 22, bottom: -22 });
    key.shadow.bias = -0.0005; s.add(key);
    const fill = new THREE.DirectionalLight(a.fillColor ?? 0x4eb3d4, 0.6);
    fill.position.set(-10, 8, -6); s.add(fill);
    const rim = new THREE.SpotLight(a.rimColor ?? 0xff5277, 14, 50, Math.PI / 4, 0.7, 1);
    rim.position.set(0, 18, -14); s.add(rim, rim.target);

    // arena
    const R = a.radius ?? 24;
    this.arenaR = R;
    const floorMat = new THREE.MeshStandardMaterial({ color: a.floorColor ?? 0x351322, roughness: 0.85, metalness: 0, emissive: a.floorEmissive ?? 0x140509, emissiveIntensity: 0.3 });
    const nrm = this._noiseTexture();
    floorMat.normalMap = nrm; floorMat.normalScale.set(0.5, 0.5);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(R, 64), floorMat);
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; s.add(floor);
    const ring = new THREE.Mesh(new THREE.RingGeometry(R - 0.4, R, 64), new THREE.MeshBasicMaterial({ color: a.ringColor ?? 0xe13c5a, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.02; s.add(ring);
    // pillars
    const pMat = new THREE.MeshStandardMaterial({ color: 0x180714, roughness: 0.9, emissive: 0x300611, emissiveIntensity: 0.5 });
    for (let i = 0; i < 14; i++) {
      const ang = (i / 14) * Math.PI * 2, rr = R + 1.5;
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.85, 6, 8), pMat);
      p.position.set(Math.cos(ang) * rr, 3, Math.sin(ang) * rr); p.castShadow = true; s.add(p);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.45, 12, 12), new THREE.MeshBasicMaterial({ color: a.ringColor ?? 0xff5e7a }));
      cap.position.set(Math.cos(ang) * rr, 6.4, Math.sin(ang) * rr); s.add(cap);
    }
  }

  _initPostFX() {
    const c = new EffectComposer(this.renderer);
    c.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.35, 0.6, 0.85);
    c.addPass(this.bloom);
    this.grade = new ShaderPass({
      uniforms: { tDiffuse: { value: null }, flash: { value: 0 }, vig: { value: 1.0 } },
      vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader: `uniform sampler2D tDiffuse;uniform float flash;uniform float vig;varying vec2 vUv;
        void main(){vec4 c=texture2D(tDiffuse,vUv);vec2 q=vUv-.5;float v=1.-dot(q,q)*1.6*vig;c.rgb*=clamp(v,.35,1.);
        c.rgb=mix(c.rgb,vec3(c.r*1.05,c.g*.96,c.b*1.1),.25);c.rgb+=flash*vec3(1.,.4,.6);gl_FragColor=c;}`
    });
    c.addPass(this.grade);
    const out = new OutputPass(); c.addPass(out);
    this.composer = c;
  }

  _noiseTexture() {
    const cv = document.createElement('canvas'); cv.width = cv.height = 256;
    const x = cv.getContext('2d'); const im = x.createImageData(256, 256);
    for (let i = 0; i < im.data.length; i += 4) { const v = 110 + Math.random() * 80; im.data[i] = v; im.data[i + 1] = v; im.data[i + 2] = 255; im.data[i + 3] = 255; }
    x.putImageData(im, 0, 0); const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(10, 10); return t;
  }

  // ---------------------------------------------------------------- particles (juice/gore)
  _initParticles() {
    const MAX = 6000; this.MAXP = MAX;
    const g = new THREE.BufferGeometry();
    this.pPos = new Float32Array(MAX * 3); this.pCol = new Float32Array(MAX * 3); this.pSize = new Float32Array(MAX);
    g.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3));
    g.setAttribute('size', new THREE.BufferAttribute(this.pSize, 1));
    const m = new THREE.ShaderMaterial({
      uniforms: { tex: { value: this._dotTex() } },
      vertexShader: 'attribute float size;varying vec3 vC;void main(){vC=color;vec4 mv=modelViewMatrix*vec4(position,1.);gl_PointSize=size*(320./-mv.z);gl_Position=projectionMatrix*mv;}',
      fragmentShader: 'uniform sampler2D tex;varying vec3 vC;void main(){vec4 t=texture2D(tex,gl_PointCoord);if(t.a<.05)discard;gl_FragColor=vec4(vC,t.a);}',
      vertexColors: true, transparent: true, depthWrite: false, blending: THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, m); this.scene.add(this.points);
  }
  _dotTex() { const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d'); const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(.4, 'rgba(255,255,255,.7)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = gr; x.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); }
  juice(origin, hex, count = 18, speed = 8, life = 0.9, size = 0.7, grav = 12) {
    const col = new THREE.Color(hex);
    for (let i = 0; i < count; i++) {
      const ph = Math.random() * Math.PI * 2, th = Math.random() * Math.PI;
      const v = new THREE.Vector3(Math.sin(th) * Math.cos(ph), Math.cos(th) * .5 + .5, Math.sin(th) * Math.sin(ph)).multiplyScalar(speed * (.5 + Math.random()));
      this.state.parts.push({ p: origin.clone(), v, g: grav, life: life * rand(.6, 1.2), max: 1, col, size: size * rand(.7, 1.4) });
      const pt = this.state.parts[this.state.parts.length - 1]; pt.max = pt.life;
    }
  }

  // ---------------------------------------------------------------- assets + characters
  async _loadAssets() {
    const pm = new THREE.PMREMGenerator(this.renderer); pm.compileEquirectangularShader();
    await new Promise((res) => new RGBELoader().load(this.spec.assets.hdri, (tex) => { tex.mapping = THREE.EquirectangularReflectionMapping; this.scene.environment = pm.fromEquirectangular(tex).texture; tex.dispose(); res(); }, undefined, () => res()));
    this.gltf = await new Promise((res) => new GLTFLoader().load(this.spec.assets.character, (g) => { g.scene.traverse(n => { if (n.isMesh) { n.castShadow = true; n.receiveShadow = true; } }); res(g); }, undefined, (err) => { console.error('[Orchard] character GLB failed to load:', this.spec.assets.character, err); res(null); }));
    if (!this.gltf || !this.gltf.scene) {
      const msg = `Could not load the character model (${this.spec.assets.character}). Check the asset path.`;
      console.error('[Orchard]', msg);
      this.emit('loaderror', msg);
      throw new Error(msg);
    }
  }

  _makeFighter(def, isPlayer) {
    const rig = { def, isPlayer, hp: def.stats.hp, maxHp: def.stats.hp, state: 'idle', dying: 0, atkCd: 0, flash: 0 };
    rig.group = SkeletonUtils.clone(this.gltf.scene);
    rig.group.scale.setScalar(isPlayer ? 1.25 : (def.scale ?? 0.95));
    // tint body + add fruit head
    const tint = new THREE.Color(def.juice);
    rig.group.traverse(n => { if (n.isMesh) { n.material = n.material.clone(); if (n.material.color) n.material.color.copy(tint); if ('emissive' in n.material) n.material.emissive = tint.clone().multiplyScalar(.15); n.material.roughness = .5; n.userData.base = n.material.color ? n.material.color.clone() : null; } });
    // fruit head ornament — lit by the scene, NOT emissive (emissive blooms out the frame)
    const hr = 0.4;
    const head = new THREE.Mesh(new THREE.SphereGeometry(hr, 24, 24), new THREE.MeshStandardMaterial({ color: tint, roughness: .45, metalness: 0.0, emissive: tint.clone(), emissiveIntensity: 0 }));
    head.position.set(0, 2.05, 0); head.scale.set(1, isPlayer ? .92 : 1.12, 1); head.castShadow = true; rig.group.add(head); rig.head = head;
    if (def.stripes) { for (let i = 0; i < 7; i++) { const st = new THREE.Mesh(new THREE.TorusGeometry(hr, 0.03, 8, 28, Math.PI), new THREE.MeshStandardMaterial({ color: def.stripeColor ?? 0x0c4f1c, roughness: .5 })); st.rotation.y = (i / 7) * Math.PI * 2; st.rotation.x = Math.PI / 2; head.add(st); } }
    // little leaf so it reads as fruit
    const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.22, 6), new THREE.MeshStandardMaterial({ color: 0x3a8f2a, roughness: .6 }));
    leaf.position.set(0, hr + 0.1, 0); head.add(leaf);
    // animation
    rig.mixer = new THREE.AnimationMixer(rig.group);
    rig.actions = {}; const clips = this.gltf.animations || [];
    const pick = (names) => clips.find(c => names.some(n => c.name.toLowerCase().includes(n)));
    rig.clipIdle = pick(['idle']); rig.clipWalk = pick(['walk']); rig.clipRun = pick(['run']); rig.clipPunch = pick(['punch', 'attack']); rig.clipDeath = pick(['death', 'die']);
    const mk = (clip, loop) => { if (!clip) return null; const a = rig.mixer.clipAction(clip); a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1); if (!loop) a.clampWhenFinished = true; return a; };
    rig.actions.idle = mk(rig.clipIdle, true); rig.actions.walk = mk(rig.clipWalk, true); rig.actions.run = mk(rig.clipRun, true); rig.actions.punch = mk(rig.clipPunch, false); rig.actions.death = mk(rig.clipDeath, false);
    rig.cur = null;
    rig.play = (name, fade = 0.18) => { const nx = rig.actions[name]; if (!nx || rig.cur === nx) return; nx.reset().play(); nx.setEffectiveWeight(1); if (rig.cur) rig.cur.crossFadeTo(nx, fade, false); rig.cur = nx; rig.curName = name; };
    rig.play('idle');
    return rig;
  }

  _spawnPlayer() {
    this.player = this._makeFighter(this.spec.fighters.player, true);
    this.player.group.position.set(0, 0, -4);
    this.player.facing = new THREE.Vector3(0, 0, 1);
    this.scene.add(this.player.group);
  }

  _nextWave() {
    this.state.wave++;
    const waves = this.spec.waves;
    if (this.state.wave > waves.length) { this._end(true); return; }
    const w = waves[this.state.wave - 1];
    this.state.waveActive = true; this.state.toSpawn = 0;
    let delay = 0;
    for (const grp of w) {
      for (let i = 0; i < grp.count; i++) {
        this.state.toSpawn++;
        setTimeout(() => { this._spawnEnemy(grp.type); this.state.toSpawn--; }, delay); delay += 220;
      }
    }
    this.audio.wave();
    this.emit('wave', this.state.wave, waves.length);
    this.emit('banner', `WAVE ${this.state.wave}`, `${w.reduce((n, g) => n + g.count, 0)} INCOMING`);
  }

  _spawnEnemy(typeId) {
    const def = this.spec.fighters.enemies[typeId];
    const e = this._makeFighter(def, false);
    const ang = Math.random() * Math.PI * 2, rr = this.arenaR - 3;
    e.group.position.set(Math.cos(ang) * rr, 0, Math.sin(ang) * rr);
    e.vel = new THREE.Vector3();
    this.scene.add(e.group); this.state.enemies.push(e);
  }

  // ---------------------------------------------------------------- input
  _initInput() {
    addEventListener('keydown', (e) => { const k = e.key.toLowerCase(); if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' ', 'f', 'r'].includes(k)) e.preventDefault(); this.keys.add(k); if (k === ' ') this._attack(); if (k === 'f') this._finisher(); if (k === 'r') this.emit('restart'); });
    addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    addEventListener('mousedown', () => { if (this.state.running) this._attack(); });
    // touch buttons wired by html via game.btnAttack()/btnFinisher()/setStick()
  }
  btnAttack() { this._attack(); }
  btnFinisher() { this._finisher(); }
  setStick(x, y) { this.touch.x = x; this.touch.y = y; }

  _moveVec() {
    let x = 0, z = 0; const k = this.keys;
    if (k.has('d') || k.has('arrowright')) x += 1; if (k.has('a') || k.has('arrowleft')) x -= 1;
    if (k.has('w') || k.has('arrowup')) z += 1; if (k.has('s') || k.has('arrowdown')) z -= 1;
    if (Math.abs(this.touch.x) > .05 || Math.abs(this.touch.y) > .05) { x = this.touch.x; z = -this.touch.y; }
    return { x, z };
  }

  // ---------------------------------------------------------------- combat
  _attack() {
    if (!this.state.running || this.player.dying) return;
    if (this.player.atkCd > 0) return;
    const st = this.spec.fighters.player.stats;
    this.player.atkCd = st.attackCd; this.player.swing = 0.22; this.player.state = 'attack';
    this.player.play('punch', 0.05); this.audio.swing();
  }
  _resolveSwing() {
    if (this.player._swingDone) return; this.player._swingDone = true;
    const st = this.spec.fighters.player.stats, P = this.player.group.position, F = this.player.facing;
    for (const e of this.state.enemies) {
      if (e.dying) continue;
      const d = e.group.position.clone().sub(P); const dist = d.length(); if (dist > st.reach) continue;
      d.normalize(); if (d.dot(F) < 0.25) continue;
      this._hurt(e, st.damage, d);
    }
  }
  _hurt(e, dmg, dir) {
    e.hp -= dmg; e.flash = 0.18; e.vel.add(dir.clone().multiplyScalar(this.spec.combat.knockback ?? 4));
    const o = e.group.position.clone().setY(1.4);
    this.juice(o, e.def.juice, 16, 7.5);
    this._floater(`+${dmg}`, o.clone().setY(2.2), '#fff');
    this.audio.hit(); this._addCombo(this.spec.combat.pointsHit ?? 6);
    this.state.hitPause = this.spec.combat.hitPause ?? 0.06; this._shake(0.14, 0.18);
    if (e.hp <= 0) this._kill(e, dir, false);
  }
  _kill(e, dir, finisher) {
    e.dying = finisher ? 0.1 : 1.4; e.state = 'dead'; e.play('death', 0.08);
    const o = e.group.position.clone().setY(1.2);
    // GORE: juice geyser + chunks in the victim's color (normal-blended = reads as juice, not light)
    this.juice(o, e.def.juice, finisher ? 90 : 38, finisher ? 16 : 11, 1.5, finisher ? 0.6 : 0.5, finisher ? 10 : 13);
    this.juice(o, 0xfff4d0, 8, 5, 0.6, 0.32);
    this.audio.heavy();
    if (finisher) { this.state.finishers++; this._floater(e.def.finisher || 'FRUITALITY!', o.clone().setY(3), '#e13c5a'); }
  }
  _finisher() {
    if (!this.state.running || this.player.dying) return;
    const st = this.spec.fighters.player.stats, P = this.player.group.position;
    let target = null, best = Infinity;
    for (const e of this.state.enemies) { if (e.dying) continue; if (e.hp / e.maxHp > (this.spec.combat.finisherThreshold ?? 0.16)) continue; const dd = e.group.position.distanceTo(P); if (dd < st.reach * 1.7 && dd < best) { best = dd; target = e; } }
    if (!target) return;
    this._addCombo(this.spec.combat.pointsFinisher ?? 70);
    this.state.hitPause = 0.5; this.state.slowmo = 0.95; this.state.flash = 0.65; this._shake(0.26, 0.55);
    this.audio.finisher();
    this._camFinisher(target.group.position.clone());
    const dir = P.clone().sub(target.group.position).setY(0).normalize();
    this._kill(target, dir, true);
    this.emit('banner', 'FRUITALITY', '+70 STYLE');
  }
  _hurtPlayer(dmg, dir) {
    if (this.player.iFrame > 0 || this.player.dying) return;
    this.player.hp -= dmg; this.player.iFrame = 0.5;
    this.juice(this.player.group.position.clone().setY(1.3), this.spec.fighters.player.juice, 12, 6);
    this.audio.hurt(); this._shake(0.18, 0.22);
    if (this.player.hp <= 0) { this.player.dying = 99; this.player.play('death'); this._end(false); }
  }

  _addCombo(p) { const c = this.state.combo; c.points += p; c.last = this.state.t; this._refreshRank(); }
  _refreshRank() {
    const c = this.state.combo, th = this.spec.combat.combo;
    let r = 'None'; for (let i = th.length - 1; i >= 0; i--) if (c.points >= th[i][1]) { r = th[i][0]; break; }
    if (r !== c.rank) { c.rank = r; this.emit('rank', r); }
    this.emit('points', Math.round(c.points));
  }
  _floater(text, pos, color) { this.state.floaters.push({ text, pos: pos.clone(), color, life: 1 }); }
  _shake(mag, dur) { this.state.shake.mag = Math.max(this.state.shake.mag, mag); this.state.shake.t = Math.max(this.state.shake.t, dur); }
  _camFinisher(focus) { this.cam = { fin: true, t: 1.8, focus }; }

  _end(won) {
    if (this.state.finished) return;
    this.state.finished = true; this.state.running = false; this.state.won = won;
    setTimeout(() => this.emit('end', { won, rank: this.state.combo.rank, score: Math.round(this.state.combo.points), finishers: this.state.finishers }), 400);
  }

  // ---------------------------------------------------------------- loop
  _loop(ts) {
    requestAnimationFrame((t) => this._loop(t));
    let raw = (ts - this._lastTs) / 1000; this._lastTs = ts; if (raw > 0.1) raw = 0.1;
    let dt = raw;
    if (this.state.slowmo > 0) { dt *= 0.3; this.state.slowmo -= raw; }
    if (this.state.hitPause > 0) { this.state.hitPause -= raw; dt = 0; }
    if (this.state.running) this._update(dt, raw);
    // mixers advance even during hitpause-light using raw*0.001? keep frozen on hitpause for punch impact
    this._render();
  }

  _update(dt, raw) {
    this.state.t += dt;
    const P = this.player, st = this.spec.fighters.player.stats;

    // player move
    const mv = this._moveVec();
    const camF = new THREE.Vector3(); this.camera.getWorldDirection(camF); camF.y = 0; camF.normalize();
    const camR = new THREE.Vector3().crossVectors(camF, new THREE.Vector3(0, 1, 0)).normalize();
    const world = new THREE.Vector3().addScaledVector(camR, mv.x).addScaledVector(camF, mv.z);
    const moving = world.lengthSq() > 0.001;
    if (!P.dying) {
      if (moving) { world.normalize(); P.facing.lerp(world, 0.22).normalize(); }
      if (P.atkCd > 0) P.atkCd -= dt;
      if (P.iFrame > 0) P.iFrame -= dt;
      if (P.state === 'attack') {
        P.swing -= dt; if (P.swing < 0.14) this._resolveSwing();
        if (P.swing <= 0) { P.state = 'idle'; P._swingDone = false; }
      } else {
        const canMove = true;
        if (canMove) { P.group.position.addScaledVector(world, st.speed * dt); }
        P.play(moving ? (mv.x || mv.z ? 'run' : 'idle') : 'idle', 0.15);
      }
      // clamp arena
      const flat = P.group.position.clone(); flat.y = 0; if (flat.length() > this.arenaR - 1.5) { flat.setLength(this.arenaR - 1.5); P.group.position.x = flat.x; P.group.position.z = flat.z; }
      P.group.lookAt(P.group.position.clone().add(P.facing));
    }
    P.mixer.update(dt);

    // enemies
    for (const e of this.state.enemies) {
      e.flash = Math.max(0, e.flash - dt);
      if (e.head) e.head.material.emissiveIntensity = e.flash * 3;
      if (e.dying) { e.dying -= dt; e.mixer.update(dt); continue; }
      e.vel.multiplyScalar(Math.pow(0.001, dt));
      const to = P.group.position.clone().sub(e.group.position); to.y = 0; const dist = to.length();
      const def = e.def.stats;
      if (dist > def.reach) { e.vel.addScaledVector(to.normalize(), def.speed * dt * 6); e.play('run', 0.2); }
      else e.play('idle', 0.2);
      const v = e.vel.length(); if (v > def.speed) e.vel.multiplyScalar(def.speed / v);
      e.group.position.add(e.vel.clone().multiplyScalar(dt));
      const flat = e.group.position.clone(); flat.y = 0; if (flat.length() > this.arenaR - 1.5) { flat.setLength(this.arenaR - 1.5); e.group.position.x = flat.x; e.group.position.z = flat.z; }
      e.group.lookAt(P.group.position.x, 0.5, P.group.position.z);
      e.atkCd -= dt;
      if (dist <= def.reach && e.atkCd <= 0) { e.atkCd = def.attackCd; e.play('punch', 0.08); setTimeout(() => this._hurtPlayer(def.damage, to.clone().normalize()), 250); }
      e.mixer.update(dt);
    }
    // remove finished-dying enemies
    for (const e of this.state.enemies) if (e.dying < 0) this.scene.remove(e.group);
    this.state.enemies = this.state.enemies.filter(e => !(e.dying < 0));

    // wave done? (only when all scheduled enemies have spawned AND been cleared)
    const alive = this.state.enemies.filter(e => !e.dying).length;
    if (this.state.waveActive && this.state.toSpawn === 0 && alive === 0 && !this.state.finished) {
      this.state.waveActive = false; this._nextWave();
    }
    this.emit('count', alive);
    this.emit('hp', clamp(P.hp / P.maxHp, 0, 1));

    // combo decay
    const c = this.state.combo; if (c.points > 0 && this.state.t - c.last > 1.2) { c.points = Math.max(0, c.points - 10 * dt); this._refreshRank(); }

    // particles
    for (const p of this.state.parts) { p.p.addScaledVector(p.v, dt); p.v.y -= p.g * dt; p.v.multiplyScalar(Math.pow(0.4, dt)); p.life -= dt; }
    this.state.parts = this.state.parts.filter(p => p.life > 0); if (this.state.parts.length > this.MAXP) this.state.parts.splice(0, this.state.parts.length - this.MAXP);
    for (const f of this.state.floaters) { f.pos.y += dt * 1.2; f.life -= dt; }
    this.state.floaters = this.state.floaters.filter(f => f.life > 0);
    this.emit('floaters', this.state.floaters, this.camera);

    // fx decay
    if (this.state.shake.t > 0) this.state.shake.t -= dt; else this.state.shake.mag = 0;
    if (this.state.flash > 0) this.state.flash = Math.max(0, this.state.flash - dt * 1.5);

    this._updateCamera(dt);
  }

  _updateCamera(dt) {
    const P = this.player.group.position;
    if (this.cam && this.cam.fin) {
      this.cam.t -= dt; const t = 1 - this.cam.t / 1.8; const a = t * Math.PI * 0.85, r = 5 + Math.cos(t * Math.PI) * 1.5;
      this.camera.position.set(this.cam.focus.x + Math.cos(a) * r, 2.6 + Math.sin(t * Math.PI) * 3, this.cam.focus.z + Math.sin(a) * r);
      this.camera.lookAt(this.cam.focus.x, this.cam.focus.y + 1, this.cam.focus.z);
      if (this.cam.t <= 0) this.cam.fin = false;
    } else {
      const f = this.player.facing;
      const want = new THREE.Vector3(P.x - f.x * 8.5, P.y + 10, P.z - f.z * 8.5);
      this.camera.position.lerp(want, 1 - Math.pow(0.003, dt));
      const look = new THREE.Vector3(P.x, P.y + 1.0, P.z);
      if (this.state.shake.t > 0) { const i = this.state.shake.t / 0.5; look.x += rand(-1, 1) * this.state.shake.mag * i * 4; look.y += rand(-1, 1) * this.state.shake.mag * i * 2; }
      this.camera.lookAt(look);
    }
    this.grade.uniforms.flash.value = this.state.flash;
    this.bloom.strength = 0.3 + (this.state.combo.rank === 'JUICEMASTER' ? 0.3 : 0) + this.state.flash * 0.9;
  }

  _render() {
    const n = this.state.parts.length; this.points.geometry.setDrawRange(0, n);
    for (let i = 0; i < n; i++) { const p = this.state.parts[i], a = Math.max(0, p.life / p.max); this.pPos[i * 3] = p.p.x; this.pPos[i * 3 + 1] = p.p.y; this.pPos[i * 3 + 2] = p.p.z; const b = 0.55 + 0.45 * a; this.pCol[i * 3] = p.col.r * b; this.pCol[i * 3 + 1] = p.col.g * b; this.pCol[i * 3 + 2] = p.col.b * b; this.pSize[i] = p.size * (0.4 + 0.6 * a); }
    this.points.geometry.attributes.position.needsUpdate = true; this.points.geometry.attributes.color.needsUpdate = true; this.points.geometry.attributes.size.needsUpdate = true;
    this.composer.render();
  }

  _resize() { this.renderer.setSize(innerWidth, innerHeight); this.composer.setSize(innerWidth, innerHeight); this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix(); }
}

// ---------------------------------------------------------------- tiny web-audio sfx
class SfxKit {
  constructor() { try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); this.ok = true; } catch (e) { this.ok = false; } }
  blip(f, d, type, g, sweep = 0) { if (!this.ok) return; const t = this.ctx.currentTime, o = this.ctx.createOscillator(), gn = this.ctx.createGain(); o.type = type; o.frequency.setValueAtTime(f, t); if (sweep) o.frequency.exponentialRampToValueAtTime(Math.max(40, f + sweep), t + d); gn.gain.setValueAtTime(g, t); gn.gain.exponentialRampToValueAtTime(.0001, t + d); o.connect(gn).connect(this.ctx.destination); o.start(t); o.stop(t + d + .02); }
  hit() { this.blip(220, .06, 'square', .18, -180); this.blip(1200, .04, 'triangle', .1, -1000); }
  heavy() { this.blip(140, .12, 'sawtooth', .22, -90); }
  swing() { this.blip(600, .05, 'sawtooth', .08, -400); }
  hurt() { this.blip(110, .18, 'triangle', .2, -40); }
  finisher() { this.blip(80, .5, 'sawtooth', .3, -60); setTimeout(() => this.blip(60, .7, 'sine', .22, 200), 100); }
  wave() { this.blip(660, .2, 'sine', .18, 200); }
}

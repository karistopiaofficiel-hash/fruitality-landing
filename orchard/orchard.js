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
      wave: 0, enemies: [], parts: [], gibs: [], puddles: [], floaters: [], fountains: [], pickups: [], slashes: [], waveActive: false, toSpawn: 0,
      combo: { points: 0, rank: 'None', last: -10 },
      finishers: 0,
      rage: 0, rageT: 0,        // RAMPAGE meter (0..1) + active timer (s)
      weapon: null,             // grabbed cutting weapon { type, tier, t }
      grabbed: null,            // a low-HP enemy currently grabbed/dragged
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
    this.emit('ready'); // scene renders (idle preview) until begin() is called
  }
  // pick a playable fighter from the roster before the fight starts
  selectFighter(idx) {
    const roster = this.spec.fighters.roster;
    if (!roster || !roster[idx]) return;
    this.spec.fighters.player = roster[idx];
    if (this.player) this.scene.remove(this.player.group);
    this._spawnPlayer();
    if (this.audio) { this.audio._resume(); this.audio.chirp(this.player.voicePitch || 1); }
    this.emit('hp', 1);
  }
  // start the actual fight (waves + music). Triggered by a user gesture (fighter pick).
  begin() {
    if (this.state.running || this.state.finished) return;
    this.state.running = true;
    this.audio._resume();
    // real music track if the GameSpec provides one (e.g. a licensed/AI loop);
    // else fall back to the procedural soundtrack. Ducks on finisher either way.
    const m = this.spec.assets && this.spec.assets.music;
    if (m) this.audio.loadMusic(m).then(ok => { if (!ok) this.audio.startMusic(); });
    else this.audio.startMusic();
    this._nextWave();
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
    // gore meshes: reusable chunk geometries (ripped-off body parts) + head + floor puddle
    this._gibGeo = [
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.BoxGeometry(1, 0.5, 0.7),
      new THREE.TetrahedronGeometry(0.8),
      new THREE.IcosahedronGeometry(0.7, 0),
      new THREE.CylinderGeometry(0.45, 0.55, 1.1, 6),
    ];
    this._headGibGeo = new THREE.SphereGeometry(1, 16, 16);
    this._puddleGeo = new THREE.CircleGeometry(1, 24);
  }

  // ---------------------------------------------------------------- gore: gibs + puddles
  // Dismemberment chunks: real meshes flung with velocity/spin/gravity that
  // bounce on the floor and fade. This is the "body parts ripped out" read.
  _gib(origin, hex, count, power, big) {
    const col = new THREE.Color(hex);
    for (let i = 0; i < count; i++) {
      const sz = rand(big ? 0.18 : 0.12, big ? 0.44 : 0.28);
      const geo = this._gibGeo[Math.floor(Math.random() * this._gibGeo.length)];
      const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.5, metalness: 0, emissive: col.clone().multiplyScalar(0.12) });
      const m = new THREE.Mesh(geo, mat);
      m.scale.setScalar(sz);
      m.position.copy(origin).add(new THREE.Vector3(rand(-.3, .3), rand(-.2, .5), rand(-.3, .3)));
      m.rotation.set(rand(0, 6), rand(0, 6), rand(0, 6)); m.castShadow = true;
      this.scene.add(m);
      const ph = Math.random() * Math.PI * 2;
      const v = new THREE.Vector3(Math.cos(ph), 0, Math.sin(ph)).multiplyScalar(power * rand(.5, 1.2));
      v.y = rand(3, 7) + (big ? 2 : 0);
      const av = new THREE.Vector3(rand(-9, 9), rand(-9, 9), rand(-9, 9));
      this.state.gibs.push({ mesh: m, v, av, life: rand(2.6, 4.4), max: 4.4, size: sz, rest: false });
    }
    while (this.state.gibs.length > 150) { const g = this.state.gibs.shift(); this.scene.remove(g.mesh); }
  }
  // The fruit head pops clean off and rolls — the signature finisher gore beat.
  _popHead(e) {
    const wp = new THREE.Vector3(); (e.head || e.group).getWorldPosition(wp);
    const col = new THREE.Color(e.def.juice);
    const m = new THREE.Mesh(this._headGibGeo, new THREE.MeshStandardMaterial({ color: col, roughness: .45, metalness: 0, emissive: col.clone().multiplyScalar(.12) }));
    const sz = 0.34 * (e.def.scale ?? 1);
    m.scale.setScalar(sz); m.position.copy(wp); m.castShadow = true; this.scene.add(m);
    const ph = Math.random() * Math.PI * 2;
    const v = new THREE.Vector3(Math.cos(ph) * rand(2.5, 5), rand(6, 9), Math.sin(ph) * rand(2.5, 5));
    const av = new THREE.Vector3(rand(-7, 7), rand(-7, 7), rand(-7, 7));
    this.state.gibs.push({ mesh: m, v, av, life: rand(4, 5.5), max: 5.5, size: sz, rest: false });
  }
  // Juice splatter that stains the arena floor — the aftermath read.
  _puddle(pos, hex, r) {
    const col = new THREE.Color(hex);
    const mat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0, depthWrite: false });
    const m = new THREE.Mesh(this._puddleGeo, mat);
    m.rotation.x = -Math.PI / 2; m.rotation.z = rand(0, 6);
    m.position.set(pos.x, 0.025 + Math.random() * 0.01, pos.z); m.scale.setScalar(0.2 * r);
    this.scene.add(m);
    this.state.puddles.push({ mesh: m, target: r * rand(.9, 1.3), life: 9, max: 9, op: rand(.4, .6) });
    while (this.state.puddles.length > 28) { const p = this.state.puddles.shift(); this.scene.remove(p.mesh); }
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
  // Load one GLB, but NEVER hang: a stalled download (no success/error fired) resolves
  // null after `timeoutMs` so the loading screen can't spin forever. Errors → null too.
  _loadGLB(path, timeoutMs = 18000) {
    return new Promise((res) => {
      let done = false; const finish = (v) => { if (!done) { done = true; clearTimeout(to); res(v); } };
      const to = setTimeout(() => { console.warn('[Orchard] asset timed out:', path); finish(null); }, timeoutMs);
      try {
        new GLTFLoader().load(path,
          (gl) => { gl.scene.traverse(n => { if (n.isMesh) { n.castShadow = true; n.receiveShadow = true; } }); finish(gl); },
          undefined,
          (err) => { console.warn('[Orchard] asset failed:', path, err); finish(null); });
      } catch (e) { console.warn('[Orchard] asset threw:', path, e); finish(null); }
    });
  }
  async _loadAssets() {
    const pm = new THREE.PMREMGenerator(this.renderer); pm.compileEquirectangularShader();
    // HDRI — also timeout-guarded so a stalled env map can't hang the boot.
    await new Promise((res) => {
      let done = false; const fin = () => { if (!done) { done = true; clearTimeout(to); res(); } };
      const to = setTimeout(fin, 10000);
      new RGBELoader().load(this.spec.assets.hdri, (tex) => { tex.mapping = THREE.EquirectangularReflectionMapping; this.scene.environment = pm.fromEquirectangular(tex).texture; tex.dispose(); fin(); }, undefined, fin);
    });
    // character rig GLB (procedural fallback only — current fighters all use sculpted models). Non-fatal.
    this.gltf = await this._loadGLB(this.spec.assets.character);
    if (!this.gltf || !this.gltf.scene) console.warn('[Orchard] character rig GLB unavailable; sculpted models carry the roster.');
    // preload per-fighter sculpted GLBs IN PARALLEL (was sequential — one slow 3MB file blocked the rest).
    this.models = {};
    const F = this.spec.fighters;
    const paths = new Set();
    const collect = (d) => { if (d && d.model) paths.add(d.model); };
    collect(F.player); (F.roster || []).forEach(collect); Object.values(F.enemies || {}).forEach(collect);
    const results = await Promise.all([...paths].map((p) => this._loadGLB(p).then((g) => [p, g])));
    for (const [p, g] of results) if (g && g.scene) this.models[p] = g.scene;
    // Hard guarantee against a crash if BOTH a fighter's model AND the rig GLB are missing:
    // synthesize a tiny stand-in scene so _makeFighter's procedural path never dereferences null.
    if (!this.gltf || !this.gltf.scene) {
      const anyModel = Object.values(this.models)[0];
      if (anyModel) this.gltf = { scene: anyModel, animations: [] };
    }
  }

  // Procedural imperfect/spoiled fruit skin: equirectangular CanvasTexture with
  // mottling/ripening + soft bruise patches + blemish specks, plus a bump map for
  // dents. Each fighter gets a unique skin (fruit is never perfect). Returns {map, bump}.
  _fruitTexture(hex) {
    const W = 512, H = 256;
    const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d');
    const bc = document.createElement('canvas'); bc.width = W; bc.height = H; const bx = bc.getContext('2d');
    const base = new THREE.Color(hex);
    const rgb = (col, a = 1) => `rgba(${Math.round(col.r * 255)},${Math.round(col.g * 255)},${Math.round(col.b * 255)},${a})`;
    x.fillStyle = rgb(base); x.fillRect(0, 0, W, H);
    bx.fillStyle = 'rgb(128,128,128)'; bx.fillRect(0, 0, W, H);
    const blob = (ctx, px, py, r, style) => { const g = ctx.createRadialGradient(px, py, 0, px, py, r); g.addColorStop(0, style); g.addColorStop(1, style.replace(/[\d.]+\)$/, '0)')); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(px, py, r, 0, 7); ctx.fill(); };
    // mottling / uneven ripening
    for (let i = 0; i < 80; i++) { const col = base.clone().offsetHSL(0, (Math.random() - 0.5) * 0.07, (Math.random() - 0.5) * 0.34); blob(x, Math.random() * W, Math.random() * H, 10 + Math.random() * 42, rgb(col, 0.5)); }
    // bruise patches (darker, brownish) + matching dents in the bump map
    const nB = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < nB; i++) {
      const px = Math.random() * W, py = 30 + Math.random() * (H - 60), r = 16 + Math.random() * 34;
      const br = base.clone().multiplyScalar(0.45).offsetHSL(0, -0.12, -0.04);
      blob(x, px, py, r, rgb(br, 0.72)); blob(x, px, py, r * 0.6, rgb(br, 0.55));
      blob(bx, px, py, r, 'rgba(64,64,64,0.85)');
    }
    // tiny blemish specks
    for (let i = 0; i < 70; i++) { x.fillStyle = `rgba(40,26,18,${0.25 + Math.random() * 0.4})`; x.beginPath(); x.arc(Math.random() * W, Math.random() * H, 0.8 + Math.random() * 2, 0, 7); x.fill(); }
    const map = new THREE.CanvasTexture(c); map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 4;
    const bump = new THREE.CanvasTexture(bc);
    return { map, bump };
  }

  _makeFighter(def, isPlayer) {
    const rig = { def, isPlayer, hp: def.stats.hp, maxHp: def.stats.hp, state: 'idle', dying: 0, atkCd: 0, flash: 0 };
    if (def.model && this.models && this.models[def.model]) return this._makeModelFighter(rig, def, isPlayer);
    rig.group = SkeletonUtils.clone(this.gltf.scene);
    rig.group.scale.setScalar(isPlayer ? 1.25 : (def.scale ?? 0.95));
    // tint body + add fruit head
    const tint = new THREE.Color(def.juice);
    rig.group.traverse(n => { if (n.isMesh) { n.material = n.material.clone(); if (n.material.color) n.material.color.copy(tint); if ('emissive' in n.material) n.material.emissive = tint.clone().multiplyScalar(.15); n.material.roughness = .5; n.userData.base = n.material.color ? n.material.color.clone() : null; } });
    // --- FRUIT-WARRIOR BODY: the fruit IS the torso. Hide the robot chest+head
    //     shells, keep the (tinted) arms/legs/hands so limbs still animate, and
    //     bolt a big fruit body onto the torso bone so it moves with the rig. ---
    const bones = {}; rig.group.traverse(n => { if (n.isBone) bones[n.name] = n; });
    rig.group.traverse(n => { if (n.isMesh && /^(Torso_|Head_)/.test(n.name)) n.visible = false; });
    const torsoBone = bones['Torso_1'] || bones['Abdomen'] || bones['Body'];
    // bones carry a 100x local scale; child local scale = worldRadius / 100
    const bodyR = def.bodyR ?? (isPlayer ? 0.82 : 0.9);
    const s = bodyR / 100;
    const skin = this._fruitTexture(def.juice);
    const fruitMat = new THREE.MeshStandardMaterial({ map: skin.map, bumpMap: skin.bump, bumpScale: 0.5, roughness: 0.55, metalness: 0.0, emissive: tint.clone(), emissiveIntensity: 0 });
    const body = new THREE.Mesh(new THREE.SphereGeometry(1, 36, 28), fruitMat);
    body.scale.set(s, s * 1.12, s); body.castShadow = true; body.receiveShadow = true;
    torsoBone.add(body); rig.head = body; // (hit-flash + head-pop reuse rig.head)
    // watermelon-style rind stripes (meridians)
    if (def.stripes) {
      for (let i = 0; i < 7; i++) {
        const st = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.045, 8, 40, Math.PI), new THREE.MeshStandardMaterial({ color: def.stripeColor ?? 0x0c4f1c, roughness: .5 }));
        st.rotation.y = (i / 7) * Math.PI * 2; st.rotation.x = Math.PI / 2; body.add(st);
      }
    }
    // face — eyes + brows on the +Z front of the body (tuned visually)
    const eyeW = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .25 });
    const pupM = new THREE.MeshBasicMaterial({ color: 0x140e14 });
    const browM = new THREE.MeshStandardMaterial({ color: 0x140e14, roughness: .6 });
    for (const sx of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.2, 18, 18), eyeW);
      eye.position.set(sx * 0.34, 0.14, 0.9); body.add(eye);
      const pp = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 12), pupM);
      pp.position.set(sx * 0.36, 0.11, 1.04); body.add(pp);
      const brow = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.07, 0.07), browM);
      brow.position.set(sx * 0.34, 0.42, 0.93); brow.rotation.z = sx * 0.5; body.add(brow); // angry V
    }
    // stem + leaf crown
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 0.32, 6), new THREE.MeshStandardMaterial({ color: 0x4a7a32, roughness: .7 }));
    stem.position.set(0, 1.0, 0); body.add(stem);
    const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.4, 6), new THREE.MeshStandardMaterial({ color: 0x3a8f2a, roughness: .6 }));
    leaf.position.set(0.16, 1.05, 0); leaf.rotation.z = -0.6; body.add(leaf);
    // --- GAIT PERSONALITY + jelly-wobble spring (Fall-Guys-style soft-body motion) ---
    const G = def.gait || {};
    rig.gait = {
      bob: G.bob ?? 0.12, hop: G.hop ?? 0.13, waddle: G.waddle ?? 0.12,
      squash: G.squash ?? 0.15, lean: G.lean ?? 0.09, freq: G.freq ?? 9,
      wobble: G.wobble ?? 0.4, stomp: G.stomp ?? 0.6,
    };
    rig.gaitPhase = Math.random() * Math.PI * 2;
    rig.wob = 0; rig.wobV = 0; rig._lastSin = 0; // 1D squash spring (jelly jiggle)
    // voice pitch: bigger fruit = lower/deeper squeak; small = higher
    rig.voicePitch = isPlayer ? 1.0 : clamp(1.55 - (def.scale ?? 0.95) * 0.42, 0.55, 1.6) * (0.92 + Math.random() * 0.16);
    rig.bodyBaseScale = body.scale.clone();
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

  // Sculpted-model fighter: a TRELLIS-generated textured GLB driven entirely by
  // the procedural gait (no skeleton needed — chunky fruit have barely any limbs).
  _makeModelFighter(rig, def, isPlayer) {
    rig.isModel = true;
    rig.group = new THREE.Group();
    const m = this.models[def.model].clone(true);
    // per-instance materials (so hit-flash emissive doesn't bleed across clones)
    const tint = new THREE.Color(def.juice); rig.bodyMats = [];
    // Per-fruit self-illumination so each reads in ITS natural color, not uniformly dark in the
    // moody arena. Sunny fruit (banana/lime/lemon) lift a lot; naturally dark ones (coconut) barely.
    // `bright` (0..1) can override per fighter; otherwise derived from the fruit's own luminance.
    const lum = 0.299 * tint.r + 0.587 * tint.g + 0.114 * tint.b;
    const lift = def.bright ?? clamp(lum * 1.15, 0.1, 0.9);
    rig.baseEmi = lift * 0.28;                                 // gentle self-glow in the fruit's own hue
    m.traverse(n => {
      if (!n.isMesh) return;
      n.material = n.material.clone();
      n.material.emissive = tint.clone();                      // glow/flash now actually shows (was black before)
      n.material.emissiveIntensity = rig.baseEmi;
      if (n.material.color) n.material.color.multiplyScalar(0.92 + lift * 0.5); // brighten albedo of sunny fruit
      n.castShadow = true; n.receiveShadow = true; rig.bodyMats.push(n.material);
    });
    // scale the (height-1) model to world height, feet on the ground
    const H = (isPlayer ? 3.4 : 3.4 * (def.scale ?? 0.95));
    m.scale.setScalar(H);
    const box = new THREE.Box3().setFromObject(m); m.position.y = -box.min.y;
    rig.group.add(m); rig.head = m; rig.bodyBaseScale = m.scale.clone(); rig._footY = m.position.y;
    // gait personality + jelly-wobble spring
    const G = def.gait || {};
    rig.gait = { bob: G.bob ?? 0.12, hop: G.hop ?? 0.13, waddle: G.waddle ?? 0.12, squash: G.squash ?? 0.15, lean: G.lean ?? 0.09, freq: G.freq ?? 9, wobble: G.wobble ?? 0.4, stomp: G.stomp ?? 0.6 };
    rig.gaitPhase = Math.random() * Math.PI * 2; rig.wob = 0; rig.wobV = 0; rig._lastSin = 0;
    rig.voicePitch = isPlayer ? 1.0 : clamp(1.55 - (def.scale ?? 0.95) * 0.42, 0.55, 1.6) * (0.92 + Math.random() * 0.16);
    rig.mixer = null; // no skeletal animation
    rig.play = (name) => { rig.curName = name; if (name === 'punch') rig.wobV += 0.9; }; // punch = effort squash
    return rig;
  }
  // procedural death for sculpted models (no skeletal 'death' clip): topple + sink + shrink
  _toppleModel(rig, dt) {
    if (!rig.head) return;
    rig.head.rotation.z = Math.min((rig.head.rotation.z || 0) + dt * 3.2, Math.PI * 0.5);
    rig.head.position.y = Math.max(0, rig.head.position.y - dt * 0.7);
    if (rig.dying < 0.6) { const sc = Math.max(0.01, rig.dying / 0.6); rig.head.scale.setScalar(rig.bodyBaseScale.x * sc); }
  }

  // Procedural "Fall Guys" gait layered on top of the skeletal walk: bob/hop,
  // waddle, squash-&-stretch, lean, per-step stomp + a jelly-wobble spring.
  // Applied AFTER group.lookAt so waddle/lean layer onto the facing.
  _applyGait(rig, dt, speed01) {
    if (rig.dying) return;
    const g = rig.gait, body = rig.head, grp = rig.group;
    const moving = speed01 > 0.05;
    rig.gaitPhase += dt * (moving ? g.freq * (0.6 + 0.4 * speed01) : 2.2);
    const ph = rig.gaitPhase;
    // hop: bouncy abs-sin while moving; gentle breathing when idle
    const hopN = moving ? Math.abs(Math.sin(ph)) : (0.5 + 0.5 * Math.sin(ph)) * 0.25;
    grp.position.y = hopN * (moving ? g.hop : g.bob * 0.4);
    // step landing detection -> stomp impulse into the wobble spring
    const sinv = Math.sin(ph);
    if (moving && rig._lastSin > 0 && sinv <= 0) { rig.wobV -= g.stomp * (0.5 + 0.5 * speed01); this._step(rig, speed01); }
    rig._lastSin = sinv;
    // jelly wobble spring (underdamped -> jiggle)
    rig.wobV += (-150 * rig.wob - 13 * rig.wobV) * dt;
    rig.wob = clamp(rig.wob + rig.wobV * dt, -0.45, 0.45);
    // squash-&-stretch: stretch at hop apex, squash on landing, + wobble
    const sq = (hopN - 0.5) * g.squash * (moving ? 1 : 0.4) + rig.wob;
    const b = rig.bodyBaseScale;
    body.scale.set(b.x * (1 - sq * 0.6), b.y * (1 + sq), b.z * (1 - sq * 0.6));
    // waddle (side sway, half-step cadence) + lean into motion — layer onto facing
    grp.rotateZ(Math.sin(ph * 0.5) * g.waddle * (moving ? 1 : 0.15));
    if (moving) grp.rotateX(speed01 * g.lean);
  }
  _step(rig, speed01) {
    if (this.audio) this.audio.step(rig.isPlayer || (rig.def.scale ?? 1) > 1.4);
    if (rig.isPlayer && speed01 > 0.4) { const p = rig.group.position.clone(); p.y = 0.06; this.juice(p, 0xcdbba6, 2, 1.2, 0.35, 0.28, 6); }
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
    addEventListener('keydown', (e) => { const k = e.key.toLowerCase(); if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' ', 'f', 'r'].includes(k)) e.preventDefault(); this.keys.add(k); if (k === ' ') this._attack(); if (k === 'f') this._finisher(); if (k === 'shift') this._dash(); if (k === 'q') this._rampage(); if (k === 'e') this._grabEnemy(); if (k === 'r') this.emit('restart'); });
    addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    addEventListener('mousedown', () => { if (this.state.running) this._attack(); });
    // touch buttons wired by html via game.btnAttack()/btnFinisher()/setStick()
  }
  btnAttack() { this._attack(); }
  btnFinisher() { this._finisher(); }
  btnDash() { this._dash(); }
  setStick(x, y) { this.touch.x = x; this.touch.y = y; }

  // dash/dodge: quick burst in the move (or facing) direction with i-frames + juice trail
  _dash() {
    if (!this.state.running || this.player.dying) return;
    const P = this.player; if ((P.dashCd || 0) > 0 || (P.dashT || 0) > 0) return;
    const mv = this._moveVec();
    const camF = new THREE.Vector3(); this.camera.getWorldDirection(camF); camF.y = 0; camF.normalize();
    const camR = new THREE.Vector3().crossVectors(camF, new THREE.Vector3(0, 1, 0)).normalize();
    let dir = new THREE.Vector3().addScaledVector(camR, mv.x).addScaledVector(camF, mv.z);
    if (dir.lengthSq() < 0.001) dir = P.facing.clone();
    dir.y = 0; dir.normalize();
    P.dashDir = dir; P.facing.copy(dir);
    P.dashT = 0.18; P.dashCd = 0.72; P.iFrame = Math.max(P.iFrame || 0, 0.26);
    P.state = 'idle'; P._swingDone = false; P.atkCd = Math.max(P.atkCd || 0, 0.05);
    P.play('run', 0.04);
    this.audio.dash(); this.audio.effort(this.player.voicePitch || 1); this._shake(0.06, 0.1);
    this.emit('dash');
  }

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
    if (this.state.finisher) return;
    if (this.state.grabbed) { this._swingHeld(); return; } // holding a body → swing it as a club
    if (this.player.atkCd > 0) return;
    const st = this.spec.fighters.player.stats, P = this.player;
    // combo chain: two quick jabs then a HEAVY slam (3rd hit). resets if you pause.
    if (this.state.t - (P._lastAtk || -9) > 0.8) P.combo = 0;
    P._lastAtk = this.state.t; P.combo = (P.combo || 0) + 1;
    P.heavy = (P.combo % 3 === 0);
    P.atkCd = P.heavy ? st.attackCd * 2.0 : st.attackCd;
    P.swing = P.heavy ? 0.34 : 0.22; P.state = 'attack';
    P.atkSide = ((P.atkSide || 0) + 1) % 2;
    P.atkAnim = 1; P.play('punch', 0.05);
    this._slash(P, P.heavy); // bright swipe arc so the attack READS regardless of camera angle
    if (P.heavy) { this.audio.heavy(); this.audio.effort(P.voicePitch); this._shake(0.12, 0.14); this._floater('HEAVY!', P.group.position.clone().setY(4), '#ffd23c'); } else this.audio.swing();
  }
  // Bright additive crescent that sweeps in front of the fighter on each swing — the
  // clearest "an attack happened" signal (the chunky models have no arms to punch with).
  _slash(rig, heavy) {
    if (!this._slashGeo) this._slashGeo = {
      // wide crescents CENTERED on the fighter so the arc sweeps out past the body
      // silhouette and reads even when attacking away from the follow-cam.
      q: new THREE.RingGeometry(1.5, 2.7, 40, 1, -0.85, 1.7),
      h: new THREE.RingGeometry(1.9, 3.6, 48, 1, -1.0, 2.0),
      qe: new THREE.RingGeometry(2.45, 2.8, 40, 1, -0.85, 1.7),  // thin white-hot leading edge
      he: new THREE.RingGeometry(3.25, 3.65, 48, 1, -1.0, 2.0),
    };
    const juice = new THREE.Color(this.spec.fighters.player.juice);
    const f = rig.facing, aim = Math.atan2(f.x, f.z), side = rig.atkSide ? 1 : -1;
    // two layers: a juice-colored body (bloody) + a white-hot leading edge (sharp)
    const mk = (geo, col, op, ro) => {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: op, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false, depthTest: false }));
      m.renderOrder = ro; m.rotation.x = -Math.PI / 2; m.position.copy(rig.group.position); m.position.y = 2.0;
      m.rotation.z = aim - side * 0.7; this.scene.add(m); return m;
    };
    const body = mk(heavy ? this._slashGeo.h : this._slashGeo.q, juice.clone().lerp(new THREE.Color(0xffffff), 0.12), 0.95, 999);
    const edge = mk(heavy ? this._slashGeo.he : this._slashGeo.qe, new THREE.Color(0xffffff).lerp(juice, 0.25), 1.0, 1000);
    this.state.slashes.push({ m: body, m2: edge, t: 0, dur: heavy ? 0.24 : 0.16, side, rot0: aim - side * 0.7 });
    // forward juice streak + a quick screen pop so the swing has impact even on a whiff
    const o = rig.group.position.clone().setY(1.4).addScaledVector(f, 1.2);
    for (let i = 0; i < (heavy ? 14 : 8); i++) { const a = (i / (heavy ? 14 : 8) - 0.5) * 0.8; const d = f.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), a); this.state.parts.push({ p: o.clone(), v: d.multiplyScalar(rand(9, 15)).setY(rand(-1.5, 2.5)), g: 10, life: rand(0.12, 0.26), max: 0.26, col: juice.clone(), size: heavy ? 0.5 : 0.34 }); }
    this.state.flash = Math.max(this.state.flash, heavy ? 0.16 : 0.09);
  }
  // Procedural attack for sculpted models (no skeleton): windup back -> thrust
  // forward + chomp-pitch + stretch. Reads as a body-slam/headbutt strike.
  _attackAnim(rig, dt) {
    const heavy = rig.heavy;
    rig.atkAnim -= dt / (heavy ? 0.34 : 0.22);
    const u = clamp(1 - rig.atkAnim, 0, 1), peak = heavy ? 0.42 : 0.34;
    // jab/slam profile: fast OUT toward target then ease back. NO windup-back, NO bend-over.
    let p; if (u < peak) p = 1 - Math.pow(1 - u / peak, 2); else p = Math.max(0, 1 - (u - peak) / (1 - peak));
    const big = heavy ? 1.6 : 1, side = rig.atkSide ? 1 : -1, b = rig.bodyBaseScale;
    rig.head.position.z = p * 0.95 * big;                                  // forward jab/lunge toward target
    rig.head.position.x = side * p * 0.3 * (heavy ? 0.4 : 1);              // alternating hook (quick only)
    rig.head.position.y = (rig._footY || 0) + p * 0.28 + (heavy ? Math.sin(clamp(u, 0, 1) * Math.PI) * 0.4 : 0); // heavy lifts then slams down
    rig.head.rotation.x = p * (heavy ? 0.15 : 0.10);                       // small forward dip only
    rig.head.rotation.z = side * p * 0.2 * (heavy ? 0.4 : 1);
    rig.head.scale.set(b.x * (1 - p * 0.16 * big), b.y * (1 - p * 0.14), b.z * (1 + p * 0.3 * big));
    if (rig.atkAnim <= 0) { rig.atkAnim = 0; rig.heavy = false; rig.head.position.set(0, rig._footY || 0, 0); rig.head.rotation.set(0, 0, 0); }
  }
  _resolveSwing() {
    if (this.player._swingDone) return; this.player._swingDone = true;
    const st = this.spec.fighters.player.stats, P = this.player.group.position, F = this.player.facing;
    const heavy = !!this.player.heavy;
    const reach = heavy ? st.reach * 1.45 : st.reach;        // heavy slam sweeps wider
    const arc = heavy ? -0.15 : 0.25;                        // heavy = near half-circle; quick = tight cone
    const dmg = heavy ? Math.round(st.damage * 2.3) : st.damage;
    const knock = heavy ? (this.spec.combat.knockback ?? 4) * 2.4 : null;
    let any = false;
    for (const e of this.state.enemies) {
      if (e.dying) continue;
      const d = e.group.position.clone().sub(P); const dist = d.length(); if (dist > reach) continue;
      d.normalize(); if (d.dot(F) < arc) continue;
      this._hurt(e, dmg, d, knock); any = true;
    }
    if (heavy && any) { this.state.hitPause = 0.13; this._shake(0.28, 0.32); }  // weighty slam impact
  }
  _hurt(e, dmg, dir, knock) {
    e.hp -= dmg; e.flash = 0.18; e.vel.add(dir.clone().multiplyScalar(knock ?? this.spec.combat.knockback ?? 4));
    e.wobV = (e.wobV || 0) + 0.8; // jelly-jiggle on hit
    const o = e.group.position.clone().setY(1.4);
    this.juice(o, e.def.juice, 16, 7.5);
    this._floater(`+${dmg}`, o.clone().setY(2.2), '#fff');
    this.audio.hit(); this.audio.squeak(e.voicePitch); this._addCombo(this.spec.combat.pointsHit ?? 6); this._addRage(0.05);
    this.state.hitPause = this.spec.combat.hitPause ?? 0.06; this._shake(0.14, 0.18);
    if (e.hp <= 0) this._kill(e, dir, false);
  }
  _kill(e, dir, finisher, opts = {}) {
    const rip = !!opts.rip, weapon = opts.weapon || null;
    const mixer = weapon && weapon.type === 'mixer';
    e.dying = finisher ? (rip ? 0.05 : 0.1) : 1.4; e.state = 'dead'; e.play('death', 0.08);
    const o = e.group.position.clone().setY(1.2);
    // GORE: juice geyser in the victim's color (scaled up hard for a RIP)
    this.juice(o, e.def.juice, finisher ? (rip ? 170 : 90) : 38, finisher ? 16 : 11, 1.5, finisher ? 0.6 : 0.5, finisher ? 10 : 13);
    this.juice(o, 0xfff4d0, 8, 5, 0.6, 0.32);
    // GORE: dismemberment chunks + floor stain
    this._gib(o, e.def.juice, finisher ? (mixer ? 36 : rip ? 18 : 16) : 6, finisher ? 13 : 7, finisher);
    this._puddle(e.group.position.clone(), e.def.juice, finisher ? (rip ? 3.4 : 2.6) : 1.5);
    if (finisher) {
      this._popHead(e); e.group.visible = false;
      if (rip) {
        // RIP IN TWO: two big half-chunks fly apart + a sustained JUICE FOUNTAIN
        this._ripHalves(e, dir, mixer ? 4 : 2);
        this._fountain(e.group.position.clone().setY(1.3), e.def.juice, 1.4, mixer ? 11 : 7);
        this._fountain(e.group.position.clone().setY(1.4), 0xfff4d0, 0.6, 2);
        this._shake(0.45, 0.55);
      }
    }
    this.audio.heavy(); this.audio.splat();
    if (finisher) {
      this.state.finishers++; this._floater(opts.label || e.def.finisher || 'FRUITALITY!', o.clone().setY(3), '#e13c5a');
      // chance to drop a rarity cutting weapon (more likely on a RIP)
      if (!this.state.weapon && this.state.pickups.length < 2 && Math.random() < (rip ? 0.55 : 0.32)) this._spawnPickup(e.group.position.clone());
    }
  }
  // two (or more) big halves of the victim torn apart, flung perpendicular to the rip
  _ripHalves(e, dir, n = 2) {
    const o = e.group.position.clone().setY(1.4); const col = new THREE.Color(e.def.juice);
    const side = new THREE.Vector3(-dir.z, 0, dir.x).normalize();
    for (let i = 0; i < n; i++) {
      const sgn = i % 2 ? 1 : -1, sz = (n > 2 ? 0.34 : 0.55) * (e.def.scale ?? 1);
      const m = new THREE.Mesh(this._gibGeo[Math.floor(Math.random() * this._gibGeo.length)], new THREE.MeshStandardMaterial({ color: col, roughness: .5, emissive: col.clone().multiplyScalar(.12) }));
      m.scale.setScalar(sz); m.position.copy(o).addScaledVector(side, sgn * 0.2); m.castShadow = true; this.scene.add(m);
      const v = side.clone().multiplyScalar(sgn * rand(3, 5.5)); v.y = rand(5, 8.5);
      this.state.gibs.push({ mesh: m, v, av: new THREE.Vector3(rand(-9, 9), rand(-9, 9), rand(-9, 9)), life: rand(3, 4.6), max: 4.6, size: sz, rest: false });
    }
  }
  // sustained juice fountain (vs the instant burst): emits upward over `dur` seconds
  _fountain(origin, hex, dur = 1.2, rate = 6) {
    this.state.fountains.push({ pos: origin.clone(), col: hex, t: dur, rate });
  }
  _addRage(amt) {
    if (this.state.rageT > 0) return;
    const b = this.state.rage; this.state.rage = clamp(this.state.rage + amt, 0, 1);
    if (b < 1 && this.state.rage >= 1) { this.emit('banner', 'RAMPAGE READY', 'press Q / tap ⚡'); this.audio.wave(); }
    this.emit('rage', this.state.rage, this.state.rageT);
  }
  _rampage() {
    if (!this.state.running || this.player.dying || this.state.rageT > 0 || this.state.rage < 1) return;
    this.state.rageT = 8; this.state.rage = 0;
    this.emit('banner', 'RAMPAGE!', 'RIP THEM APART'); this.emit('rage', 0, this.state.rageT);
    this.state.flash = 0.3; this._shake(0.3, 0.4); this.audio.finisher(); this.audio.chirp(0.8);
  }
  btnRampage() { this._rampage(); }

  // ---- rarity cutting weapons (rare -> mythic), grabbable, single-use on the next finisher ----
  _weaponMesh(type, col) {
    const g = new THREE.Group();
    const steel = new THREE.MeshStandardMaterial({ color: 0xcfd6df, roughness: 0.22, metalness: 0.95 });
    const handle = new THREE.MeshStandardMaterial({ color: 0x3a2a1e, roughness: 0.7 });
    if (type === 'mixer') {
      g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.62, 1.1, 16), steel));
      for (let i = 0; i < 4; i++) { const bl = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.05, 0.18), steel); bl.position.y = 0.45; bl.rotation.y = i * Math.PI / 2; g.add(bl); }
    } else if (type === 'cleaver') {
      g.add(new THREE.Mesh(new THREE.BoxGeometry(0.95, 1.2, 0.06), steel));
      const h = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.5, 0.18), handle); h.position.y = -0.85; g.add(h);
    } else if (type === 'saw') {
      const d = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.06, 20), steel); d.rotation.x = Math.PI / 2; g.add(d);
      for (let i = 0; i < 14; i++) { const t = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.06, 0.14), steel); const a = i / 14 * Math.PI * 2; t.position.set(Math.cos(a) * 0.72, Math.sin(a) * 0.72, 0); g.add(t); }
    } else { // knife
      const bl = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.35, 0.04), steel); bl.position.y = 0.35; g.add(bl);
      const h = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.5, 0.18), handle); h.position.y = -0.5; g.add(h);
    }
    g.add(new THREE.Mesh(new THREE.SphereGeometry(1.1, 16, 12), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false })));
    g.traverse(n => { if (n.isMesh) n.castShadow = true; });
    return g;
  }
  _spawnPickup(pos, forceTier) {
    const tiers = [['rare', 0x4ea0ff, 0.5], ['epic', 0xb24cff, 0.3], ['legendary', 0xffc83a, 0.15], ['mythic', 0xff3a5a, 0.05]];
    let tier = forceTier;
    if (!tier) { let r = Math.random(), acc = 0; for (const [n, , p] of tiers) { acc += p; if (r <= acc) { tier = n; break; } } tier = tier || 'rare'; }
    const col = (tiers.find(t => t[0] === tier) || tiers[0])[1];
    const type = ['knife', 'cleaver', 'mixer', 'saw'][Math.floor(Math.random() * 4)];
    const mesh = this._weaponMesh(type, col); const baseY = 1.5;
    mesh.position.set(pos.x, baseY, pos.z); mesh.scale.setScalar(0.85); this.scene.add(mesh);
    this.state.pickups.push({ mesh, type, tier, col, baseY, ph: Math.random() * 6, t: 15 });
    while (this.state.pickups.length > 4) { const p = this.state.pickups.shift(); this.scene.remove(p.mesh); }
    this.emit('banner', tier.toUpperCase() + ' ' + type.toUpperCase(), 'grab it!');
  }
  _grabWeapon(pk) {
    this.state.weapon = { type: pk.type, tier: pk.tier, col: pk.col };
    this.audio.chirp(1.4); this.audio.wave();
    this.emit('weapon', this.state.weapon);
    this._floater(pk.tier.toUpperCase() + ' ' + pk.type.toUpperCase(), this.player.group.position.clone().setY(3.5), '#' + pk.col.toString(16).padStart(6, '0'));
  }
  _finisher() {
    if (!this.state.running || this.player.dying) return;
    const st = this.spec.fighters.player.stats, P = this.player.group.position;
    const rampaging = this.state.rageT > 0, weapon = this.state.weapon;
    const rip = rampaging || !!weapon;
    const thr = rampaging ? 0.45 : (weapon ? 0.3 : (this.spec.combat.finisherThreshold ?? 0.16)); // easier to RIP
    let target = null, best = Infinity;
    for (const e of this.state.enemies) { if (e.dying) continue; if (e.hp / e.maxHp > thr) continue; const dd = e.group.position.distanceTo(P); if (dd < st.reach * 1.8 && dd < best) { best = dd; target = e; } }
    if (!target) return;
    if (this.state.finisher) return; // one at a time
    this._addCombo(this.spec.combat.pointsFinisher ?? 70); this._addRage(0.18);
    this.state.hitPause = 0.08; this.state.slowmo = 1.3; this.state.flash = 0.16; // brief freeze, then slow-mo through the move
    this.audio.finisher(); this.audio.duck(800); this.audio.chirp(1.25);
    // dir points from victim -> player (player faces the OPPOSITE, toward victim)
    const dir = P.clone().sub(target.group.position).setY(0).normalize();
    const faceDir = dir.clone().multiplyScalar(-1); // player faces the victim
    const pdef = this.player.def || this.spec.fighters.player;
    const label = weapon ? (weapon.type === 'mixer' ? 'BLENDED!' : 'SLICED!') : (pdef.finisher || 'FRUITALITY!');
    // signature move per fighter (overhead SLAM / body PRESS / jab FLURRY / CRACK headbutt)
    const move = weapon ? 'slice' : (pdef.finMove || 'slam');
    this._camFinisher(target.group.position.clone(), move, faceDir); // per-move cinematic camera
    // lock the victim in place; make the player invulnerable through the sequence
    target.atkCd = 999; target.vel.set(0, 0, 0); target._finVictim = true;
    this.player.iFrame = 3.0; this.player.atkAnim = 0; this.player.state = 'finisher';
    this.state.finisher = {
      v: target, t: 0, dur: move === 'flurry' ? 1.15 : 0.95, dir, faceDir, rip, weapon, label, move,
      struck: false, pStart: this.player.group.position.clone(),
      vPos: target.group.position.clone(), reach: st.reach,
    };
    this.emit('banner', weapon ? weapon.type.toUpperCase() + ' KILL' : (rampaging ? 'RIP!' : 'FRUITALITY'), weapon ? weapon.tier.toUpperCase() : '+70 STYLE');
  }
  // Procedural finisher choreography: seize -> wind-up -> signature STRIKE (triggers the
  // kill/gore at the impact frame) -> recoil. Driven by RAW time so it plays through the
  // slow-mo + hit-pause. Static sculpted models, so we animate body transforms (à la gaits).
  _updateFinisher(raw) {
    const f = this.state.finisher, P = this.player, v = f.v;
    f.t += raw; const u = clamp(f.t / f.dur, 0, 1);
    // face & close on the victim: stand a touch in front of it
    const dirN = f.faceDir.clone(); P.facing.lerp(dirN, 0.4).normalize();
    const standoff = 1.7;
    const want = f.vPos.clone().addScaledVector(dirN, -standoff);
    P.group.position.lerp(want, 1 - Math.pow(0.0001, raw)); P.group.position.y = 0;
    P.group.lookAt(P.group.position.clone().add(P.facing));
    const b = P.bodyBaseScale, fy = P._footY || 0;
    let z = 0, y = 0, pitch = 0, sx = 1, sy = 1, sz = 1, roll = 0;
    // shared anticipation envelope
    const ease = (a, b2, t) => a + (b2 - a) * (t < 0 ? 0 : t > 1 ? 1 : (t * t * (3 - 2 * t)));
    if (f.move === 'press') {
      // PINEAPPLE — barge forward and crush
      if (u < 0.35) { const t = u / 0.35; z = ease(0, -0.35, t); sy = ease(1, 1.15, t); }            // coil back
      else if (u < 0.66) { const t = (u - 0.35) / 0.31; z = ease(-0.35, 1.7, t); y = ease(0, 0.15, t); sz = ease(1, 1.35, t); pitch = ease(0, 0.18, t); } // RAM
      else { const t = (u - 0.66) / 0.34; z = ease(1.7, 0, t); pitch = ease(0.18, 0, t); sz = ease(1.35, 1, t); sy = ease(1.15, 1, t); }
    } else if (f.move === 'crack') {
      // COCONUT — rear way back then a sharp headbutt snap
      if (u < 0.42) { const t = u / 0.42; z = ease(0, -0.5, t); pitch = ease(0, -0.18, t); y = ease(0, 0.2, t); } // big wind-up
      else if (u < 0.6) { const t = (u - 0.42) / 0.18; z = ease(-0.5, 1.5, t); pitch = ease(-0.18, 0.28, t); y = ease(0.2, 0, t); } // SNAP
      else { const t = (u - 0.6) / 0.4; z = ease(1.5, 0, t); pitch = ease(0.28, 0, t); }
    } else if (f.move === 'flurry') {
      // KIWI — fast multi-jab then a finishing lunge
      if (u < 0.7) { const k = Math.sin(u / 0.7 * Math.PI * 5); z = Math.max(0, k) * 0.7; roll = k * 0.18; y = Math.abs(k) * 0.08; } // rapid jabs
      else if (u < 0.82) { const t = (u - 0.7) / 0.12; z = ease(0, 1.6, t); sz = ease(1, 1.3, t); pitch = ease(0, 0.14, t); } // big finisher lunge
      else { const t = (u - 0.82) / 0.18; z = ease(1.6, 0, t); sz = ease(1.3, 1, t); pitch = ease(0.14, 0, t); }
    } else {
      // SLAM (melon default + 'slice' weapon) — leap up, overhead smash down
      if (u < 0.34) { const t = u / 0.34; z = ease(0, 0.3, t); y = ease(0, 0.7, t); sy = ease(1, 1.12, t); pitch = ease(0, -0.12, t); } // rise + slight rear
      else if (u < 0.62) { const t = (u - 0.34) / 0.28; z = ease(0.3, 1.3, t); y = ease(0.7, 0.0, t); pitch = ease(-0.12, 0.22, t); sz = ease(1, 1.3, t); sy = ease(1.12, 0.86, t); } // SMASH down
      else { const t = (u - 0.62) / 0.38; z = ease(1.3, 0, t); pitch = ease(0.22, 0, t); sz = ease(1.3, 1, t); sy = ease(0.86, 1, t); } // recoil
    }
    P.head.position.set(0, fy + y, z); P.head.rotation.set(pitch, 0, roll);
    P.head.scale.set(b.x * sx, b.y * sy, b.z * sz);
    // victim reacts: cower + shake until struck
    if (!f.struck && v.head && !v.dying) {
      const shake = Math.sin(f.t * 40) * 0.05 * (0.4 + u);
      v.head.position.x = shake; v.head.rotation.z = shake * 2;
      v.head.scale.set(v.bodyBaseScale.x * (1 - u * 0.08), v.bodyBaseScale.y * (1 - u * 0.06), v.bodyBaseScale.z * (1 - u * 0.08));
    }
    // strike frame -> trigger the kill/gore
    if (!f.struck && u >= 0.6) {
      f.struck = true;
      this._kill(v, f.dir, true, { rip: f.rip, weapon: f.weapon, label: f.label });
      this.state.hitPause = 0.07; this.state.flash = f.rip ? 0.32 : 0.24; this._shake(f.rip ? 0.5 : 0.32, 0.55);
      this.audio.heavy(); this.audio.splat();
      if (f.weapon) { this.state.weapon = null; this.emit('weapon', null); }
    }
    // done -> restore the player to a neutral pose and release control
    if (u >= 1) {
      P.head.position.set(0, fy, 0); P.head.rotation.set(0, 0, 0); P.head.scale.copy(b);
      P.state = 'idle'; this.state.finisher = null;
    }
  }
  _hurtPlayer(dmg, dir) {
    if (this.player.iFrame > 0 || this.player.dying) return;
    this.player.hp -= dmg; this.player.iFrame = 0.5; this.player.wobV = (this.player.wobV || 0) + 0.7;
    this.juice(this.player.group.position.clone().setY(1.3), this.spec.fighters.player.juice, 12, 6);
    this.audio.hurt(); this.audio.grunt(); this._shake(0.18, 0.22);
    if (this.player.hp <= 0) { this.player.dying = 99; this.player.play('death'); this._end(false); }
  }

  // ---- GRAB a low-HP fruit, DRAG it (juice trail), bludgeon others with its body, THROW it ----
  btnGrab() { this._grabEnemy(); }
  _grabEnemy() {
    if (!this.state.running || this.player.dying) return;
    if (this.state.grabbed) { this._throwHeld(); return; } // E again = hurl it
    const P = this.player.group.position, st = this.spec.fighters.player.stats;
    let best = Infinity, target = null;
    for (const e of this.state.enemies) {
      if (e.dying || e.thrown > 0) continue;
      if (e.hp / e.maxHp > 0.4) continue; // only a weakened fruit can be grabbed
      const d = e.group.position.distanceTo(P); if (d < st.reach * 1.8 && d < best) { best = d; target = e; }
    }
    if (!target) return;
    this.state.grabbed = target; target.vel.set(0, 0, 0); target.atkCd = 999; target._ramCd = 0;
    this.audio.swing(); this.audio.squeak(target.voicePitch);
    this._floater('GRABBED', target.group.position.clone().setY(3), '#fff');
    this.emit('banner', 'GRABBED', 'SPACE swing · E throw · drag = juice trail');
  }
  // swing the grabbed fruit overhead like a club (attack while holding)
  _swingHeld() {
    const e = this.state.grabbed, P = this.player; if (!e) return;
    if ((P.heldSwingT || 0) > 0) return; // mid-swing
    P.heldSwingT = 0.42; e._swHit = false;
    this.audio.swing(); this.audio.effort(P.voicePitch || 1); this._shake(0.1, 0.12);
  }
  _updateHeld(e, dt) {
    const P = this.player, f = P.facing;
    // --- ACTIVE SWING: arc the body from overhead-back down to the front, AoE on the downswing ---
    if ((P.heldSwingT || 0) > 0) {
      P.heldSwingT -= dt; const s = clamp(1 - P.heldSwingT / 0.42, 0, 1); // 0..1 through the swing
      const ang = lerp(-1.25, 1.05, s);                                   // overhead-behind → slammed-front
      const reach = 2.6, hx = Math.cos(ang), hy = Math.sin(ang + 0.55);
      e.group.position.set(P.group.position.x + f.x * hx * reach, Math.max(0.4, 1.3 + hy * 1.7), P.group.position.z + f.z * hx * reach);
      e.group.lookAt(P.group.position.x, e.group.position.y, P.group.position.z); e.group.rotateX(s * 2.4);
      this.juice(e.group.position.clone(), e.def.juice, 4, 3, 0.5, 0.4, 9);   // heavy spray off the swung body
      this._puddle(e.group.position.clone().setY(0), e.def.juice, 0.4);
      // impact on the downswing
      if (!e._swHit && s > 0.5) {
        e._swHit = true; let any = false;
        for (const o of this.state.enemies) {
          if (o === e || o.dying || o.thrown > 0 || o === this.state.grabbed) continue;
          if (o.group.position.distanceTo(e.group.position) < 2.8) {
            const dir = o.group.position.clone().sub(P.group.position).setY(0).normalize();
            this._hurt(o, 30, dir); any = true;
          }
        }
        e.hp -= e.maxHp * 0.12; this._shake(0.24, 0.26); this.audio.heavy();
        if (any) { this._floater('WHACK!', e.group.position.clone().setY(2.4), '#ff5277'); this._addRage(0.05); }
      }
      if (e.bodyMats) e.bodyMats.forEach(m => m.emissiveIntensity = 0.5);
      if (e.hp <= 0) { this.state.grabbed = null; P.heldSwingT = 0; this._kill(e, f.clone(), false); }
      return; // skip passive drag while swinging
    }
    const tgt = new THREE.Vector3(P.group.position.x - f.x * 2.3, 0.45, P.group.position.z - f.z * 2.3);
    e.group.position.lerp(tgt, 1 - Math.pow(0.0006, dt)); // lag = drag trail
    e.group.lookAt(P.group.position.x, 0.45, P.group.position.z); e.group.rotateX(-0.7); // dragged-on-its-back tilt
    // bleed out + juice trail
    e.hp -= e.maxHp * 0.11 * dt;
    if (Math.random() < 0.7) this.juice(e.group.position.clone().setY(0.5), e.def.juice, 2, 1.4, 0.5, 0.42, 7);
    if (Math.random() < 0.22) this._puddle(e.group.position.clone(), e.def.juice, 0.7);
    // BLUDGEON: the dragged body damages other enemies it's pulled into
    e._ramCd -= dt;
    if (e._ramCd <= 0) {
      for (const o of this.state.enemies) {
        if (o === e || o.dying || o.thrown > 0 || o === this.state.grabbed) continue;
        if (o.group.position.distanceTo(e.group.position) < 2.0) {
          const dir = o.group.position.clone().sub(e.group.position).setY(0).normalize();
          this._hurt(o, 14, dir); e.hp -= e.maxHp * 0.07; e._ramCd = 0.28; this.audio.heavy(); this._shake(0.13, 0.12);
          this._addRage(0.04); break;
        }
      }
    }
    if (e.bodyMats) e.bodyMats.forEach(m => m.emissiveIntensity = 0.2 + 0.2 * Math.sin(this.state.t * 10));
    else if (e.head && e.head.material) e.head.material.emissiveIntensity = 0.2 + 0.2 * Math.sin(this.state.t * 10);
    if (e.hp <= 0) { this.state.grabbed = null; this._kill(e, f.clone(), false); } // bled out -> bursts
  }
  _throwHeld() {
    const e = this.state.grabbed; if (!e) return;
    this.state.grabbed = null;
    const f = this.player.facing.clone(); e.thrown = 0.9; e.vel = f.multiplyScalar(24); e.vel.y = 6.5; e.atkCd = 999;
    this.audio.swing(); this.audio.heavy(); this._shake(0.18, 0.2);
    this._floater('THROW!', e.group.position.clone().setY(3), '#ffce4d');
  }
  _updateThrown(e, dt) {
    e.thrown -= dt; e.vel.y -= 24 * dt; e.group.position.addScaledVector(e.vel, dt); e.group.rotateX(dt * 9);
    if (Math.random() < 0.5) this.juice(e.group.position.clone(), e.def.juice, 2, 2, 0.45, 0.4, 6);
    let hit = e.group.position.y <= 0.45 || e.thrown <= 0;
    for (const o of this.state.enemies) {
      if (o === e || o.dying || o.thrown > 0) continue;
      if (o.group.position.distanceTo(e.group.position) < 2.2) { this._hurt(o, 24, e.vel.clone().setY(0).normalize()); hit = true; }
    }
    if (hit) {
      e.thrown = 0; const d = e.vel.clone().setY(0).normalize();
      this._fountain(e.group.position.clone().setY(1), e.def.juice, 0.8, 6); this._shake(0.28, 0.32);
      this._kill(e, d.lengthSq() ? d : new THREE.Vector3(0, 0, 1), false);
    }
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
  _camFinisher(focus, style = 'slam', dir = null) {
    const d = dir ? dir.clone().setY(0).normalize() : new THREE.Vector3(0, 0, 1);
    const side = new THREE.Vector3(-d.z, 0, d.x).normalize(); // perpendicular to the strike
    this.cam = { fin: true, t: 2.0, dur: 2.0, focus: focus.clone(), style, dir: d, side };
    this.emit('cinematic', true);
  }

  _end(won) {
    if (this.state.finished) return;
    this.state.finished = true; this.state.running = false; this.state.won = won;
    this.audio.stopMusic();
    if (won && this.spec.assets && this.spec.assets.victorySfx) this.audio.playSample(this.spec.assets.victorySfx, 0.7);
    setTimeout(() => this.emit('end', { won, rank: this.state.combo.rank, score: Math.round(this.state.combo.points), finishers: this.state.finishers }), 400);
  }

  // ---------------------------------------------------------------- loop
  _loop(ts) {
    requestAnimationFrame((t) => this._loop(t));
    let raw = (ts - this._lastTs) / 1000; this._lastTs = ts; if (raw > 0.1) raw = 0.1;
    let dt = raw;
    if (this.state.slowmo > 0) { dt *= 0.3; this.state.slowmo -= raw; }
    if (this.state.hitPause > 0) { this.state.hitPause -= raw; dt = 0; }
    const tsc = this.state.timeScale ?? 1; // debug/cinematic global slow-mo (1 = normal)
    if (this.state.running) this._update(dt * tsc, raw * tsc);
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
    if (this.state.finisher) {
      this._updateFinisher(raw); // cinematic move owns the player; runs on real time through slow-mo
    } else if (!P.dying) {
      if (P.dashCd > 0) P.dashCd -= dt;
      if (P.dashT > 0 && moving) { /* keep dash dir */ } else if (moving) { world.normalize(); P.facing.lerp(world, 0.22).normalize(); }
      if (P.atkCd > 0) P.atkCd -= dt;
      if (P.iFrame > 0) P.iFrame -= dt;
      if (P.dashT > 0) {
        P.dashT -= dt;
        P.group.position.addScaledVector(P.dashDir, st.speed * 3.1 * dt);
        // juice afterimage trail
        if (Math.random() < 0.7) this.juice(P.group.position.clone().setY(0.9), this.spec.fighters.player.juice, 2, 1.5, 0.45, 0.45, 3);
        P.play('run', 0.05);
      } else if (P.state === 'attack') {
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
      if (P.isModel && (P.atkAnim || 0) > 0) this._attackAnim(P, dt);
      else this._applyGait(P, dt, P.dashT > 0 ? 1.4 : (moving ? 1 : 0));
    }
    if (P.mixer) P.mixer.update(dt);

    // enemies
    // finisher discoverability: pulse-glow any enemy weak enough to EXECUTE + flag for the HUD prompt
    const _ramp = this.state.rageT > 0, _wpn = !!this.state.weapon;
    const finThr = _ramp ? 0.45 : (_wpn ? 0.3 : (this.spec.combat.finisherThreshold ?? 0.25));
    const finRange = st.reach * 1.8;
    let anyFin = false;
    for (const e of this.state.enemies) {
      e.flash = Math.max(0, e.flash - dt);
      let emi = Math.max(e.flash * 3, e.baseEmi || 0);          // keep the fruit's natural self-glow between hits
      const fin = !e.dying && !(e.thrown > 0) && e !== this.state.grabbed && (e.hp / e.maxHp <= finThr) && e.group.position.distanceTo(P.group.position) <= finRange;
      e.finishable = fin;
      if (fin) { emi = Math.max(emi, 1.05 + Math.sin(this.state.t * 10) * 0.75); anyFin = true; } // throbbing "execute me" glow
      if (e.bodyMats) e.bodyMats.forEach(mt => mt.emissiveIntensity = emi);
      else if (e.head && e.head.material) e.head.material.emissiveIntensity = emi;
      if (e.thrown > 0) { this._updateThrown(e, dt); if (e.mixer) e.mixer.update(dt); continue; }
      if (e === this.state.grabbed) { this._updateHeld(e, dt); if (e.mixer) e.mixer.update(dt); continue; }
      if (e.dying) { e.dying -= dt; if (e.mixer) e.mixer.update(dt); else this._toppleModel(e, dt); continue; }
      e.vel.multiplyScalar(Math.pow(0.001, dt));
      const to = P.group.position.clone().sub(e.group.position); to.y = 0; const dist = to.length();
      const def = e.def.stats;
      if (dist > def.reach) { e.vel.addScaledVector(to.normalize(), def.speed * dt * 6); e.play('run', 0.2); }
      else e.play('idle', 0.2);
      const v = e.vel.length(); if (v > def.speed) e.vel.multiplyScalar(def.speed / v);
      e.group.position.add(e.vel.clone().multiplyScalar(dt));
      const flat = e.group.position.clone(); flat.y = 0; if (flat.length() > this.arenaR - 1.5) { flat.setLength(this.arenaR - 1.5); e.group.position.x = flat.x; e.group.position.z = flat.z; }
      // SEPARATION: don't clip into the player, don't stack on other enemies
      const sP = e.group.position.clone().sub(P.group.position); sP.y = 0; const dP = sP.length();
      const standoff = 1.4 + (def.reach * 0.5);
      if (dP < standoff && dP > 0.01) { e.group.position.addScaledVector(sP.normalize(), (standoff - dP) * Math.min(1, dt * 12)); }
      for (const o of this.state.enemies) {
        if (o === e || o.dying || o.thrown > 0 || o === this.state.grabbed) continue;
        const s = e.group.position.clone().sub(o.group.position); s.y = 0; const d = s.length();
        const want = 1.1 + (e.def.scale ?? 1) + (o.def.scale ?? 1);
        if (d < want && d > 0.01) e.group.position.addScaledVector(s.normalize(), (want - d) * Math.min(1, dt * 8));
      }
      e.group.lookAt(P.group.position.x, 0.5, P.group.position.z);
      if (e.isModel && (e.atkAnim || 0) > 0) this._attackAnim(e, dt);
      else this._applyGait(e, dt, clamp(e.vel.length() / def.speed, 0, 1.2));
      e.atkCd -= dt;
      if (dist <= def.reach && e.atkCd <= 0) { e.atkCd = def.attackCd; e.play('punch', 0.08); e.atkAnim = 1; e.atkSide = ((e.atkSide || 0) + 1) % 2; setTimeout(() => this._hurtPlayer(def.damage, to.clone().normalize()), 250); }
      if (e.mixer) e.mixer.update(dt);
    }
    // FINISH prompt: fire once when an enemy first becomes executable (and clear when none are)
    if (anyFin && !this.state._finReady) { this.state._finReady = true; this.emit('banner', 'FINISH READY', 'press F / tap 🔪'); this.audio.chirp(1.3); }
    else if (!anyFin) this.state._finReady = false;
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

    // RAMPAGE timer + red player glow
    if (this.state.rageT > 0) {
      this.state.rageT -= raw;
      const mats = this.player.bodyMats || (this.player.head && this.player.head.material ? [this.player.head.material] : []);
      const gl = 0.35 + 0.28 * Math.sin(this.state.t * 14);
      mats.forEach(m => { if (m.emissive) { m.emissive.setHex(0xff2a2a); m.emissiveIntensity = gl; } });
      if (this.state.rageT <= 0) { const be = this.player.baseEmi || 0; mats.forEach(m => { if (m.emissive) { m.emissive.setHex(this.player.def.juice); m.emissiveIntensity = be; } }); this.emit('rage', 0, 0); }
      else if (Math.random() < 0.2) this.emit('rage', this.state.rage, Math.max(0, this.state.rageT));
    }
    // attack slash arcs: sweep, expand, fade, then retire (two layers: body + hot edge)
    for (const s of this.state.slashes) {
      s.t += dt; const u = clamp(s.t / s.dur, 0, 1);
      const rot = s.rot0 + s.side * (0.5 + u * 1.25), sc = 0.8 + u * 0.7;
      s.m.material.opacity = 0.95 * (1 - u * u); s.m.scale.setScalar(sc); s.m.rotation.z = rot;
      if (s.m2) { s.m2.material.opacity = 1 - u; s.m2.scale.setScalar(sc); s.m2.rotation.z = rot; }
      if (u >= 1) { this.scene.remove(s.m); if (s.m2) this.scene.remove(s.m2); }
    }
    if (this.state.slashes.length) this.state.slashes = this.state.slashes.filter(s => s.t < s.dur);
    // juice fountains (sustained emitters)
    for (const ft of this.state.fountains) {
      ft.t -= dt; const col = new THREE.Color(ft.col);
      for (let i = 0, n = Math.max(1, Math.round(ft.rate)); i < n; i++) {
        const a = Math.random() * Math.PI * 2, sp = rand(0.3, 1.0) * 3;
        this.state.parts.push({ p: ft.pos.clone().add(new THREE.Vector3(rand(-.2, .2), 0, rand(-.2, .2))), v: new THREE.Vector3(Math.cos(a) * sp, rand(9, 15), Math.sin(a) * sp), g: 22, life: rand(0.5, 1.1), max: 1, col, size: rand(0.35, 0.7) });
        const pt = this.state.parts[this.state.parts.length - 1]; pt.max = pt.life;
      }
    }
    this.state.fountains = this.state.fountains.filter(ft => ft.t > 0);
    // weapon pickups: float, spin, collect on overlap
    for (const pk of this.state.pickups) {
      pk.t -= dt; pk.mesh.rotation.y += dt * 2.2; pk.mesh.position.y = pk.baseY + Math.sin(this.state.t * 3 + pk.ph) * 0.25;
      if (!this.player.dying && pk.mesh.position.distanceTo(this.player.group.position) < 2.0) { this._grabWeapon(pk); pk.t = -1; }
    }
    for (const pk of this.state.pickups) if (pk.t <= 0) this.scene.remove(pk.mesh);
    this.state.pickups = this.state.pickups.filter(pk => pk.t > 0);

    // particles
    for (const p of this.state.parts) { p.p.addScaledVector(p.v, dt); p.v.y -= p.g * dt; p.v.multiplyScalar(Math.pow(0.4, dt)); p.life -= dt; }
    this.state.parts = this.state.parts.filter(p => p.life > 0); if (this.state.parts.length > this.MAXP) this.state.parts.splice(0, this.state.parts.length - this.MAXP);

    // gore chunks — gravity, spin, floor bounce, then fade
    for (const g of this.state.gibs) {
      g.life -= dt;
      if (!g.rest) {
        g.v.y -= 20 * dt;
        g.mesh.position.addScaledVector(g.v, dt);
        g.mesh.rotation.x += g.av.x * dt; g.mesh.rotation.y += g.av.y * dt; g.mesh.rotation.z += g.av.z * dt;
        const floorY = g.size * 0.5;
        if (g.mesh.position.y <= floorY) {
          g.mesh.position.y = floorY;
          if (g.v.y < -1.2) { g.v.y *= -0.36; g.v.x *= 0.55; g.v.z *= 0.55; g.av.multiplyScalar(0.45); }
          else { g.v.set(0, 0, 0); g.rest = true; }
        }
      }
      if (g.life < 0.7) g.mesh.scale.setScalar(g.size * Math.max(0.001, g.life / 0.7));
    }
    for (const g of this.state.gibs) if (g.life <= 0) this.scene.remove(g.mesh);
    this.state.gibs = this.state.gibs.filter(g => g.life > 0);
    // juice puddles — grow, fade in then out
    for (const pu of this.state.puddles) {
      pu.life -= dt;
      pu.mesh.scale.setScalar(lerp(pu.mesh.scale.x, pu.target, 1 - Math.pow(0.02, dt)));
      const age = pu.max - pu.life;
      pu.mesh.material.opacity = age < 0.4 ? pu.op * (age / 0.4) : (pu.life < 1.6 ? pu.op * (pu.life / 1.6) : pu.op);
    }
    for (const pu of this.state.puddles) if (pu.life <= 0) this.scene.remove(pu.mesh);
    this.state.puddles = this.state.puddles.filter(p => p.life > 0);
    for (const f of this.state.floaters) { f.pos.y += dt * 1.2; f.life -= dt; }
    this.state.floaters = this.state.floaters.filter(f => f.life > 0);
    this.emit('floaters', this.state.floaters, this.camera);

    // fx decay
    if (this.state.shake.t > 0) this.state.shake.t -= dt; else this.state.shake.mag = 0;
    if (this.state.flash > 0) this.state.flash = Math.max(0, this.state.flash - raw * 2.8); // real-time decay (punch, not a wash through slow-mo)

    this._updateCamera(dt);
  }

  _updateCamera(dt) {
    const P = this.player.group.position;
    if (this.cam && this.cam.fin) {
      this.cam.t -= dt; const u = clamp(1 - this.cam.t / this.cam.dur, 0, 1);
      const ein = 1 - Math.pow(1 - u, 3); // ease-out punch-in
      const fc = this.cam.focus, d = this.cam.dir || new THREE.Vector3(0, 0, 1), side = this.cam.side || new THREE.Vector3(1, 0, 0);
      const style = this.cam.style || 'slam';
      let pos, lkY = fc.y + 1.1;
      if (style === 'press') {
        // PINEAPPLE — side-on dolly that tracks IN along the barge (profile of the crush)
        const r = lerp(9, 4.2, ein), sgn = 1;
        pos = new THREE.Vector3(fc.x + side.x * r * sgn, fc.y + 1.5 + Math.sin(u * Math.PI) * 0.5, fc.z + side.z * r * sgn);
        lkY = fc.y + 1.0;
      } else if (style === 'crack') {
        // COCONUT — pull BACK during the wind-up, then SNAP in hard on the headbutt (~u 0.3)
        const punch = u < 0.32 ? lerp(5.0, 8.0, u / 0.32) : lerp(8.0, 2.6, clamp((u - 0.32) / 0.28, 0, 1));
        pos = new THREE.Vector3(fc.x - d.x * punch + side.x * 1.6, fc.y + 2.6 - ein * 1.2, fc.z - d.z * punch + side.z * 1.6);
        lkY = fc.y + 1.3;
      } else if (style === 'flurry') {
        // KIWI — energetic low fast orbit with tiny jolts during the jab storm
        const a = -0.5 + ein * 2.7 + Math.sin(u * 34) * 0.06 * (1 - u);
        const r = lerp(7, 3.2, ein);
        pos = new THREE.Vector3(fc.x + Math.cos(a) * r, fc.y + 1.2 + Math.sin(u * Math.PI) * 1.2, fc.z + Math.sin(a) * r);
      } else if (style === 'slice') {
        // WEAPON — smooth full orbit around the cut
        const a = Math.atan2(d.z, d.x) + ein * Math.PI * 1.7;
        const r = lerp(6.8, 3.5, ein);
        pos = new THREE.Vector3(fc.x + Math.cos(a) * r, fc.y + 1.7 + Math.sin(u * Math.PI) * 0.4, fc.z + Math.sin(a) * r);
        lkY = fc.y + 1.3;
      } else {
        // SLAM (melon) — low 3/4 hero angle from the victim's FRONT-side: frames the melon
        // smashing DOWN onto the victim. Punch in + rise into the smash.
        const r = lerp(8.5, 4.4, ein);
        pos = new THREE.Vector3(fc.x + d.x * r * 0.55 + side.x * r * 0.85, fc.y + 0.9 + Math.sin(u * Math.PI) * 1.9, fc.z + d.z * r * 0.55 + side.z * r * 0.85);
        lkY = fc.y + 1.6;
      }
      this.camera.position.copy(pos);
      const lk = new THREE.Vector3(fc.x, lkY, fc.z);
      if (this.state.shake.t > 0) { const i = this.state.shake.t / 0.5; lk.x += rand(-1, 1) * this.state.shake.mag * i * 3; lk.y += rand(-1, 1) * this.state.shake.mag * i * 1.5; }
      this.camera.lookAt(lk);
      if (this.cam.t <= 0) { this.cam.fin = false; this.emit('cinematic', false); }
    } else {
      const f = this.player.facing;
      // lower, closer, slightly side-kicked cam → attacks read as forward jabs (not top-down "backshot"),
      // and the framing is more heroic/cinematic. look-target raised so we look UP at the action.
      const side = 0.16; // small lateral offset for a 3/4 angle instead of dead-behind
      const want = new THREE.Vector3(P.x - f.x * 11.5 + f.z * side * 11.5, P.y + 6.2, P.z - f.z * 11.5 - f.x * side * 11.5);
      this.camera.position.lerp(want, 1 - Math.pow(0.003, dt));
      const look = new THREE.Vector3(P.x + f.x * 1.5, P.y + 1.7, P.z + f.z * 1.5);
      if (this.state.shake.t > 0) { const i = this.state.shake.t / 0.5; look.x += rand(-1, 1) * this.state.shake.mag * i * 4; look.y += rand(-1, 1) * this.state.shake.mag * i * 2; }
      this.camera.lookAt(look);
    }
    this.grade.uniforms.flash.value = this.state.flash;
    this.bloom.strength = 0.3 + (this.state.combo.rank === 'JUICEMASTER' ? 0.3 : 0) + this.state.flash * 0.45;
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
  constructor() {
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      // master bus: soft limiter so layered hits + music never clip
      this.comp = this.ctx.createDynamicsCompressor();
      this.comp.threshold.value = -10; this.comp.knee.value = 24; this.comp.ratio.value = 12; this.comp.attack.value = 0.003; this.comp.release.value = 0.25;
      this.master = this.ctx.createGain(); this.master.gain.value = 0.9;
      this.sfx = this.ctx.createGain(); this.sfx.gain.value = 0.85;
      this.music = this.ctx.createGain(); this.music.gain.value = 0.0; // fades in on start
      this.sfx.connect(this.master); this.music.connect(this.master); this.master.connect(this.comp); this.comp.connect(this.ctx.destination);
      // shared noise buffer for impacts/percussion
      const n = this.ctx.sampleRate * 1.0; this.noiseBuf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0); for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      this.ok = true;
    } catch (e) { this.ok = false; }
  }
  _resume() { if (this.ok && this.ctx.state === 'suspended') this.ctx.resume(); }
  // tonal voice
  blip(f, d, type, g, sweep = 0, bus = this.sfx) { if (!this.ok) return; const t = this.ctx.currentTime, o = this.ctx.createOscillator(), gn = this.ctx.createGain(); o.type = type; o.frequency.setValueAtTime(f, t); if (sweep) o.frequency.exponentialRampToValueAtTime(Math.max(30, f + sweep), t + d); gn.gain.setValueAtTime(g, t); gn.gain.exponentialRampToValueAtTime(.0001, t + d); o.connect(gn).connect(bus); o.start(t); o.stop(t + d + .02); }
  // filtered noise burst (impacts, hats, splats)
  noise(d, g, lp = 4000, hp = 0, when = 0) { if (!this.ok) return; const t = this.ctx.currentTime + when; const s = this.ctx.createBufferSource(); s.buffer = this.noiseBuf; const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp; const gn = this.ctx.createGain(); gn.gain.setValueAtTime(g, t); gn.gain.exponentialRampToValueAtTime(.0001, t + d); let node = s.connect(f); if (hp) { const h = this.ctx.createBiquadFilter(); h.type = 'highpass'; h.frequency.value = hp; f.connect(h); node = h; } else node = f; node.connect(gn).connect(this.sfx); s.start(t); s.stop(t + d + .02); }
  // --- combat sfx (punchier: noise body + tonal snap) ---
  hit() { this.noise(0.07, 0.5, 2600, 400); this.blip(240, .05, 'square', .12, -160); this.blip(1500, .03, 'triangle', .07, -1200); }
  heavy() { this.noise(0.16, 0.7, 1500); this.blip(120, .16, 'sawtooth', .22, -70); this.blip(60, .2, 'sine', .18, -20); }
  swing() { this.noise(0.05, 0.18, 6000, 1500); }
  dash() { this.noise(0.22, 0.32, 3500, 500); this.blip(520, .16, 'sawtooth', .06, -320); }
  step(big) { this.noise(big ? 0.09 : 0.05, big ? 0.10 : 0.05, big ? 500 : 800); }
  // --- squeaky cartoon-fruit voices (formant-ish: osc -> bandpass -> env) ---
  voice(f, dur, bend, type = 'sawtooth', g = 0.16, fc = 1500, q = 7) {
    if (!this.ok) return; const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(Math.max(50, f + bend), t + dur);
    const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = fc; bp.Q.value = q;
    const gn = this.ctx.createGain(); gn.gain.setValueAtTime(0.0001, t); gn.gain.exponentialRampToValueAtTime(g, t + 0.012); gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(bp).connect(gn).connect(this.sfx); o.start(t); o.stop(t + dur + 0.02);
  }
  squeak(p = 1) { const f = 680 * p; this.voice(f, 0.12, f * 0.8, 'sawtooth', 0.15, 1600, 8); this.voice(f * 1.5, 0.09, -f * 0.5, 'square', 0.05, 2400, 10); }
  splat() { this.voice(190, 0.22, -130, 'sawtooth', 0.18, 800, 4); this.noise(0.18, 0.38, 1400); }
  chirp(p = 1) { this.voice(480 * p, 0.13, 420 * p, 'square', 0.12, 1800, 7); }
  grunt() { this.voice(165, 0.16, -60, 'sawtooth', 0.16, 700, 5); }
  effort(p = 1) { this.voice(430 * p, 0.1, 260, 'square', 0.1, 1600, 6); }
  hurt() { this.blip(120, .18, 'triangle', .18, -50); this.noise(0.1, 0.25, 1200); }
  finisher() { this.blip(90, .5, 'sawtooth', .28, -60); this.blip(70, .7, 'sine', .2, 240); this.noise(0.5, 0.5, 3000); setTimeout(() => { this.blip(330, .25, 'square', .12, 200); this.blip(440, .3, 'square', .1, 260); }, 90); }
  wave() { this.blip(330, .18, 'sine', .14, 180); this.blip(660, .22, 'triangle', .1, 220); }
  // --- procedural music: driving four-on-the-floor loop, lookahead scheduler ---
  startMusic() {
    if (!this.ok || this._mTimer) return; this._resume();
    this.music.gain.setValueAtTime(0.0001, this.ctx.currentTime);
    this.music.gain.exponentialRampToValueAtTime(0.22, this.ctx.currentTime + 2.5);
    const bpm = 134, step16 = 60 / bpm / 4;
    this._step = 0; this._nextT = this.ctx.currentTime + 0.1;
    // A-minor-ish driving riff (bass MIDI -> Hz)
    const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
    const bass = [33, 33, 33, 45, 40, 40, 28, 28, 33, 33, 36, 33, 31, 31, 43, 43]; // per 16th
    const arp = [69, null, 72, null, 76, null, 72, null, 67, null, 71, null, 74, null, 79, null];
    const schedStep = (s, t) => {
      // kick (four on the floor)
      if (s % 4 === 0) { const o = this.ctx.createOscillator(), g = this.ctx.createGain(); o.type = 'sine'; o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12); g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(.001, t + 0.16); o.connect(g).connect(this.music); o.start(t); o.stop(t + 0.18); }
      // clap/snare on 2 & 4
      if (s === 4 || s === 12) { const sN = this.ctx.createBufferSource(); sN.buffer = this.noiseBuf; const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1800; const g = this.ctx.createGain(); g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(.001, t + 0.13); sN.connect(f).connect(g).connect(this.music); sN.start(t); sN.stop(t + 0.15); }
      // hat on offbeats
      if (s % 2 === 1) { const sN = this.ctx.createBufferSource(); sN.buffer = this.noiseBuf; const f = this.ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7000; const g = this.ctx.createGain(); g.gain.setValueAtTime(0.18, t); g.gain.exponentialRampToValueAtTime(.001, t + 0.05); sN.connect(f).connect(g).connect(this.music); sN.start(t); sN.stop(t + 0.06); }
      // bass
      { const o = this.ctx.createOscillator(), g = this.ctx.createGain(), lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700; o.type = 'sawtooth'; o.frequency.value = hz(bass[s]); g.gain.setValueAtTime(0.0, t); g.gain.linearRampToValueAtTime(0.32, t + 0.01); g.gain.exponentialRampToValueAtTime(.001, t + step16 * 0.9); o.connect(lp).connect(g).connect(this.music); o.start(t); o.stop(t + step16); }
      // arp lead (quieter)
      if (arp[s] != null) { const o = this.ctx.createOscillator(), g = this.ctx.createGain(); o.type = 'square'; o.frequency.value = hz(arp[s]); g.gain.setValueAtTime(0.0, t); g.gain.linearRampToValueAtTime(0.09, t + 0.005); g.gain.exponentialRampToValueAtTime(.001, t + 0.18); o.connect(g).connect(this.music); o.start(t); o.stop(t + 0.2); }
    };
    this._mTimer = setInterval(() => {
      if (!this.ok) return;
      while (this._nextT < this.ctx.currentTime + 0.12) {
        schedStep(this._step % 16, this._nextT);
        this._nextT += step16; this._step++;
      }
    }, 25);
  }
  // one-shot sample (decoded + cached) through the sfx bus
  async playSample(url, gain = 0.6) {
    if (!this.ok) return; this._resume();
    try {
      this._samp = this._samp || {};
      const buf = this._samp[url] || (this._samp[url] = await fetch(url).then(r => r.arrayBuffer()).then(a => this.ctx.decodeAudioData(a)));
      const s = this.ctx.createBufferSource(); s.buffer = buf; const g = this.ctx.createGain(); g.gain.value = gain; s.connect(g).connect(this.sfx); s.start();
    } catch (e) { }
  }
  // load + loop a real audio file (licensed/AI track) through the music bus
  async loadMusic(url) {
    if (!this.ok) return false;
    try {
      const buf = await fetch(url).then(r => r.arrayBuffer()).then(a => this.ctx.decodeAudioData(a));
      this._resume();
      const src = this.ctx.createBufferSource(); src.buffer = buf; src.loop = true; src.connect(this.music);
      const t = this.ctx.currentTime; this.music.gain.setValueAtTime(0.0001, t); this.music.gain.exponentialRampToValueAtTime(0.5, t + 2.0);
      src.start(); this._musicSrc = src; return true;
    } catch (e) { console.warn('[music] file load failed; using procedural', e); return false; }
  }
  stopMusic() { if (this._mTimer) { clearInterval(this._mTimer); this._mTimer = null; } if (this._musicSrc) { try { this._musicSrc.stop(); } catch (e) { } this._musicSrc = null; } if (this.ok) { this.music.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.8); } }
  duck(ms = 400) { if (!this.ok) return; const t = this.ctx.currentTime; this.music.gain.cancelScheduledValues(t); const cur = this.music.gain.value || 0.22; this.music.gain.setValueAtTime(cur, t); this.music.gain.linearRampToValueAtTime(cur * 0.35, t + 0.04); this.music.gain.linearRampToValueAtTime(cur, t + ms / 1000); }
}

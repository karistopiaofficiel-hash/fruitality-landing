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
      wave: 0, enemies: [], parts: [], gibs: [], puddles: [], floaters: [], waveActive: false, toSpawn: 0,
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
    addEventListener('keydown', (e) => { const k = e.key.toLowerCase(); if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' ', 'f', 'r'].includes(k)) e.preventDefault(); this.keys.add(k); if (k === ' ') this._attack(); if (k === 'f') this._finisher(); if (k === 'shift') this._dash(); if (k === 'r') this.emit('restart'); });
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
    e.wobV = (e.wobV || 0) + 0.8; // jelly-jiggle on hit
    const o = e.group.position.clone().setY(1.4);
    this.juice(o, e.def.juice, 16, 7.5);
    this._floater(`+${dmg}`, o.clone().setY(2.2), '#fff');
    this.audio.hit(); this.audio.squeak(e.voicePitch); this._addCombo(this.spec.combat.pointsHit ?? 6);
    this.state.hitPause = this.spec.combat.hitPause ?? 0.06; this._shake(0.14, 0.18);
    if (e.hp <= 0) this._kill(e, dir, false);
  }
  _kill(e, dir, finisher) {
    e.dying = finisher ? 0.1 : 1.4; e.state = 'dead'; e.play('death', 0.08);
    const o = e.group.position.clone().setY(1.2);
    // GORE: juice geyser in the victim's color (normal-blended = reads as juice, not light)
    this.juice(o, e.def.juice, finisher ? 90 : 38, finisher ? 16 : 11, 1.5, finisher ? 0.6 : 0.5, finisher ? 10 : 13);
    this.juice(o, 0xfff4d0, 8, 5, 0.6, 0.32);
    // GORE: dismemberment chunks fly off + juice stains the floor
    this._gib(o, e.def.juice, finisher ? 16 : 6, finisher ? 12 : 7, finisher);
    this._puddle(e.group.position.clone(), e.def.juice, finisher ? 2.6 : 1.5);
    if (finisher) {
      // FRUITALITY: the head pops clean off + the body is torn apart (hidden → it "became" the gibs)
      this._popHead(e);
      e.group.visible = false;
    }
    this.audio.heavy(); this.audio.splat();
    if (finisher) { this.state.finishers++; this._floater(e.def.finisher || 'FRUITALITY!', o.clone().setY(3), '#e13c5a'); }
  }
  _finisher() {
    if (!this.state.running || this.player.dying) return;
    const st = this.spec.fighters.player.stats, P = this.player.group.position;
    let target = null, best = Infinity;
    for (const e of this.state.enemies) { if (e.dying) continue; if (e.hp / e.maxHp > (this.spec.combat.finisherThreshold ?? 0.16)) continue; const dd = e.group.position.distanceTo(P); if (dd < st.reach * 1.7 && dd < best) { best = dd; target = e; } }
    if (!target) return;
    this._addCombo(this.spec.combat.pointsFinisher ?? 70);
    this.state.hitPause = 0.5; this.state.slowmo = 0.95; this.state.flash = 0.22; this._shake(0.26, 0.55);
    this.audio.finisher(); this.audio.duck(700); this.audio.chirp(1.25);
    this._camFinisher(target.group.position.clone());
    const dir = P.clone().sub(target.group.position).setY(0).normalize();
    this._kill(target, dir, true);
    this.emit('banner', 'FRUITALITY', '+70 STYLE');
  }
  _hurtPlayer(dmg, dir) {
    if (this.player.iFrame > 0 || this.player.dying) return;
    this.player.hp -= dmg; this.player.iFrame = 0.5; this.player.wobV = (this.player.wobV || 0) + 0.7;
    this.juice(this.player.group.position.clone().setY(1.3), this.spec.fighters.player.juice, 12, 6);
    this.audio.hurt(); this.audio.grunt(); this._shake(0.18, 0.22);
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
  _camFinisher(focus) { this.cam = { fin: true, t: 2.0, dur: 2.0, focus }; this.emit('cinematic', true); }

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
      this._applyGait(P, dt, P.dashT > 0 ? 1.4 : (moving ? 1 : 0));
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
      this._applyGait(e, dt, clamp(e.vel.length() / def.speed, 0, 1.2));
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
      const a = -0.7 + ein * 1.7;         // slow dramatic orbit (~100°)
      const r = lerp(7.5, 3.3, ein);      // punch in close
      const y = this.cam.focus.y + 1.0 + Math.sin(u * Math.PI) * 1.7; // low, rises, settles
      this.camera.position.set(this.cam.focus.x + Math.cos(a) * r, y, this.cam.focus.z + Math.sin(a) * r);
      const lk = new THREE.Vector3(this.cam.focus.x, this.cam.focus.y + 1.1, this.cam.focus.z);
      if (this.state.shake.t > 0) { const i = this.state.shake.t / 0.5; lk.x += rand(-1, 1) * this.state.shake.mag * i * 3; lk.y += rand(-1, 1) * this.state.shake.mag * i * 1.5; }
      this.camera.lookAt(lk);
      if (this.cam.t <= 0) { this.cam.fin = false; this.emit('cinematic', false); }
    } else {
      const f = this.player.facing;
      const want = new THREE.Vector3(P.x - f.x * 12, P.y + 9, P.z - f.z * 12);
      this.camera.position.lerp(want, 1 - Math.pow(0.003, dt));
      const look = new THREE.Vector3(P.x, P.y + 1.2, P.z);
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

"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

/**
 * Taviron's hero truck: a day-cab tractor pulling an aggregate end-dump trailer, modelled in code (original geometry,
 * no third-party model or texture, so there is no licence to track). Real-time WebGL with physically based materials,
 * an environment for reflections and soft shadows.
 *
 * `progress` (0–1, the visitor's position in the story; scene k of SCENES is fully shown at k / (SCENES.length - 1))
 * drives one scene per homepage chapter — see the storyboard in docs/WEBSITE_3D.md. The truck stays the subject of every
 * scene; what changes around it illustrates the chapter's text (the fleet planned together, the drive to a delivery,
 * the checks, compared plans, the delivery itself). Nothing animates by itself, so the GPU idles when the page is
 * still. The caller decides when to mount it (WebGL available, motion allowed) and provides the static fallback.
 */

export interface TruckSceneProps {
  /** Scroll position through the story, 0–1. Read on every animation frame from this ref. */
  progress: { current: number };
  /** Shift the framed truck right by this fraction of the canvas width (the text sits on the left). */
  frameRight?: number;
  className?: string;
  onReady?: () => void;
}

// Brand palette (master plan §4): navy body, silver detailing, electric-blue light.
const NAVY = 0x13283f;
const NAVY_DEEP = 0x0b1726;
const SILVER = 0xc7d1de;
const ELECTRIC = 0x168bff;

/**
 * One scene per story step (intro + five chapters). Values between scenes are interpolated with an ease.
 * cam/look: camera position and target. fleet: two more trucks in the yard (0 gone, 1 parked). links: assignment lines
 * drawn from the trucks to the day's loads (not road routes — Taviron does not calculate routes). checks: the
 * inspection pad and gate. plans: two alternative sets of assignments, one highlighted. dump: bed raised and load
 * discharged. travel: metres driven (wheels and road follow it).
 */
interface Scene {
  cam: [number, number, number];
  look: [number, number, number];
  fleet: number;
  links: number;
  checks: number;
  plans: number;
  dump: number;
  travel: number;
}
export const SCENES: Scene[] = [
  // Intro — the rig, front three-quarter, framed so the whole nose stays inside the window from 1024 to 1920 px wide.
  { cam: [15.6, 3.9, 18.4], look: [-0.3, 1.3, 0], fleet: 0, links: 0, checks: 0, plans: 0, dump: 0, travel: 0 },
  // Every load, truck and driver, planned together: the fleet in the yard, lines to each load.
  { cam: [13, 19, 31], look: [-1, 0, 0], fleet: 1, links: 1, checks: 0, plans: 0, dump: 0, travel: 0 },
  // Revenue in view, honestly estimated: on the way to the delivery, in profile, the road moving under the truck.
  { cam: [-1, 2.8, 21.5], look: [-2, 1.5, 0], fleet: 0, links: 0, checks: 0, plans: 0, dump: 0, travel: 26 },
  // Promises you can keep — every rule checked: the rig on the inspection pad, rear three-quarter.
  { cam: [-17, 4.2, 12.5], look: [-3, 1.3, 0], fleet: 0, links: 0, checks: 1, plans: 0, dump: 0, travel: 34 },
  // Compare plans, not guesses — from above: the same fleet, two ways to plan the day.
  { cam: [-2, 44, 16], look: [-3, 0, -2], fleet: 1, links: 0, checks: 0, plans: 1, dump: 0, travel: 34 },
  // The office work follows the truck — the delivery that becomes the ticket: the bed raises and the load pours out.
  { cam: [-1, 6.5, 28], look: [-3.5, 2.2, 0], fleet: 0, links: 0, checks: 0, plans: 0, dump: 1, travel: 52 },
];

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function sceneAt(p: number): Scene {
  const x = Math.min(Math.max(p, 0), 1) * (SCENES.length - 1);
  const i = Math.min(Math.floor(x), SCENES.length - 2);
  const a = SCENES[i];
  const b = SCENES[i + 1];
  const t = ease(x - i);
  const n = (u: number, v: number) => u + (v - u) * t;
  const v3 = (u: number[], v: number[]) => u.map((k, j) => n(k, v[j])) as [number, number, number];
  return { cam: v3(a.cam, b.cam), look: v3(a.look, b.look), fleet: n(a.fleet, b.fleet), links: n(a.links, b.links), checks: n(a.checks, b.checks), plans: n(a.plans, b.plans), dump: n(a.dump, b.dump), travel: n(a.travel, b.travel) };
}

interface Truck {
  group: THREE.Group;
  wheels: THREE.Object3D[];
  /** The tipping body (pivots at its rear lower edge), its tailgate (hinged at the top) and the heaped load. */
  bed: THREE.Group;
  tailgate: THREE.Group;
  load: THREE.Mesh;
  dispose: () => void;
}

function buildTruck(): Truck {
  const disposables: Array<{ dispose: () => void }> = [];
  const track = <T extends { dispose: () => void }>(x: T) => (disposables.push(x), x);

  const paint = track(new THREE.MeshPhysicalMaterial({ color: NAVY, metalness: 0.55, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.08 }));
  const paintDeep = track(new THREE.MeshPhysicalMaterial({ color: NAVY_DEEP, metalness: 0.4, roughness: 0.45, clearcoat: 0.6, clearcoatRoughness: 0.2 }));
  const chrome = track(new THREE.MeshStandardMaterial({ color: 0xeef3f8, metalness: 1, roughness: 0.12 }));
  const brushed = track(new THREE.MeshStandardMaterial({ color: SILVER, metalness: 0.9, roughness: 0.35 }));
  const steel = track(new THREE.MeshStandardMaterial({ color: 0x2a3644, metalness: 0.7, roughness: 0.55 }));
  const rubber = track(new THREE.MeshStandardMaterial({ color: 0x0c0f13, metalness: 0, roughness: 0.92 }));
  const glass = track(new THREE.MeshPhysicalMaterial({ color: 0x0a1624, metalness: 0.2, roughness: 0.05, clearcoat: 1, transmission: 0, reflectivity: 0.9 }));
  const lamp = track(new THREE.MeshStandardMaterial({ color: 0xe8f4ff, emissive: 0xbfe2ff, emissiveIntensity: 2.2 }));
  const marker = track(new THREE.MeshStandardMaterial({ color: 0xffb547, emissive: 0xff9f1a, emissiveIntensity: 1.4 }));
  const tail = track(new THREE.MeshStandardMaterial({ color: 0x5a0d10, emissive: 0xb3161c, emissiveIntensity: 0.9 }));
  const accent = track(new THREE.MeshStandardMaterial({ color: ELECTRIC, emissive: ELECTRIC, emissiveIntensity: 0.6, metalness: 0.3, roughness: 0.4 }));
  const gravel = track(new THREE.MeshStandardMaterial({ color: 0x8a8278, roughness: 1, metalness: 0, flatShading: true }));

  const g = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = g) => {
    track(geo);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  const box = (w: number, h: number, d: number, r = 0.06, seg = 4) => new RoundedBoxGeometry(w, h, d, seg, r);

  // --- Tractor (front faces +x) -------------------------------------------------------------------------------
  // Frame rails
  add(box(9.6, 0.22, 0.18, 0.03), steel, -1.4, 0.78, 0.48);
  add(box(9.6, 0.22, 0.18, 0.03), steel, -1.4, 0.78, -0.48);
  // Hood: long, slightly sloped nose
  const hood = add(box(2.1, 0.95, 2.2, 0.22, 6), paint, 3.05, 1.55, 0);
  hood.rotation.z = -0.06;
  add(box(0.18, 1.05, 1.85, 0.06), chrome, 4.12, 1.32, 0); // grille surround
  add(box(0.06, 0.85, 1.55, 0.02), steel, 4.2, 1.32, 0); // grille
  for (let i = 0; i < 7; i++) add(box(0.04, 0.03, 1.5, 0.01), brushed, 4.24, 0.98 + i * 0.11, 0);
  add(box(0.3, 0.28, 2.5, 0.08), chrome, 4.22, 0.78, 0); // bumper
  // Headlights and amber markers
  for (const z of [0.98, -0.98]) {
    add(box(0.22, 0.18, 0.42, 0.05), lamp, 4.02, 1.1, z);
    add(box(0.05, 0.05, 0.12, 0.01), marker, 3.4, 2.05, z * 0.9);
  }
  // Fenders over the steer axle
  for (const z of [1.08, -1.08]) {
    const f = add(new THREE.CylinderGeometry(0.72, 0.72, 0.32, 24, 1, true, Math.PI, Math.PI), paintDeep, 3.0, 0.62, z);
    f.rotation.x = Math.PI / 2;
    (f.material as THREE.Material).side = THREE.DoubleSide;
  }
  // Cab
  add(box(1.85, 1.75, 2.35, 0.2, 6), paint, 1.2, 2.25, 0);
  add(box(0.08, 0.8, 2.05, 0.04), glass, 2.15, 2.62, 0); // windshield
  for (const z of [1.18, -1.18]) {
    add(box(1.1, 0.7, 0.04, 0.02), glass, 1.25, 2.6, z); // side windows
    add(box(0.1, 0.42, 0.05, 0.02), chrome, 2.25, 2.55, z * 1.05); // mirror arm
    add(box(0.12, 0.38, 0.22, 0.03), chrome, 2.35, 2.55, z * 1.16); // mirror
  }
  add(box(1.85, 0.1, 2.38, 0.04), accent, 1.2, 1.4, 0); // electric-blue cab stripe
  add(box(0.9, 0.12, 2.0, 0.05), paintDeep, 1.0, 3.18, 0); // roof cap
  // Exhaust stacks and air intakes
  for (const z of [1.25, -1.25]) {
    add(new THREE.CylinderGeometry(0.09, 0.09, 2.6, 18), chrome, 0.2, 2.35, z);
    add(new THREE.CylinderGeometry(0.2, 0.2, 0.7, 20), brushed, 2.2, 1.65, z * 0.98).rotation.z = Math.PI / 2;
  }
  // Fuel tanks and steps
  for (const z of [1.02, -1.02]) {
    const tank = add(new THREE.CylinderGeometry(0.34, 0.34, 1.4, 28), chrome, 0.9, 0.88, z);
    tank.rotation.z = Math.PI / 2;
    add(box(0.5, 0.06, 0.32, 0.02), brushed, 1.95, 0.55, z * 1.02);
  }
  // Fifth wheel
  add(new THREE.CylinderGeometry(0.62, 0.62, 0.12, 32), steel, -1.3, 1.0, 0);

  // --- End-dump trailer ---------------------------------------------------------------------------------------
  const trailer = new THREE.Group();
  trailer.position.set(-5.2, 0, 0);
  g.add(trailer);
  // The body tips about its rear lower edge (x = -3.78, y = 1.12 in trailer space); the chassis rails stay put.
  const bed = new THREE.Group();
  bed.position.set(-3.78, 1.12, 0);
  trailer.add(bed);
  const B = (x: number, y: number) => [x + 3.78, y - 1.12] as const;
  // Tapered tub: wider at the top, rounded bottom
  const tubShape = new THREE.Shape();
  tubShape.moveTo(-1.18, 0);
  tubShape.lineTo(1.18, 0);
  tubShape.quadraticCurveTo(1.32, 0.9, 1.25, 1.65);
  tubShape.lineTo(-1.25, 1.65);
  tubShape.quadraticCurveTo(-1.32, 0.9, -1.18, 0);
  const tubGeo = track(new THREE.ExtrudeGeometry(tubShape, { depth: 7.4, bevelEnabled: true, bevelSize: 0.05, bevelThickness: 0.05, bevelSegments: 3, curveSegments: 18 }));
  tubGeo.translate(0, 0, -3.7);
  tubGeo.rotateY(Math.PI / 2);
  const tub = new THREE.Mesh(tubGeo, brushed);
  tub.position.set(...B(0, 1.12), 0);
  tub.castShadow = tub.receiveShadow = true;
  bed.add(tub);
  // Vertical ribs along the tub
  for (let i = 0; i < 9; i++) add(box(0.06, 1.62, 2.62, 0.02), steel, ...B(-3.4 + i * 0.85, 1.95), 0, bed);
  add(box(7.5, 0.1, 2.66, 0.03), accent, ...B(0, 2.78), 0, bed); // top rail with the electric accent
  // Tailgate, hinged along its top edge so it swings open as the body tips.
  const tailgate = new THREE.Group();
  tailgate.position.set(...B(-3.78, 2.8), 0);
  bed.add(tailgate);
  add(box(0.12, 1.75, 2.6, 0.04), steel, 0, -0.85, 0, tailgate);
  // The load: a gently heaped gravel top
  const heap = track(new THREE.SphereGeometry(1, 28, 10, 0, Math.PI * 2, 0, Math.PI / 2));
  const load = new THREE.Mesh(heap, gravel);
  load.scale.set(3.4, 0.38, 1.12);
  load.position.set(...B(0, 2.72), 0);
  load.receiveShadow = true;
  bed.add(load);
  add(box(7.2, 0.25, 0.22, 0.04), steel, 0, 0.98, 0.55, trailer);
  add(box(7.2, 0.25, 0.22, 0.04), steel, 0, 0.98, -0.55, trailer);
  // Landing gear and mud flaps
  for (const z of [0.7, -0.7]) add(box(0.12, 0.9, 0.12, 0.02), steel, 2.6, 0.5, z, trailer);
  for (const z of [1.05, -1.05]) {
    add(box(0.04, 0.55, 0.6, 0.02), rubber, -3.65, 0.45, z, trailer);
    add(box(0.05, 0.12, 0.24, 0.02), tail, -3.86, 0.95, z * 0.95, trailer); // tail lights
  }

  // --- Wheels -------------------------------------------------------------------------------------------------
  const wheels: THREE.Object3D[] = [];
  const tireGeo = track(new THREE.TorusGeometry(0.4, 0.17, 18, 40));
  const tireTread = track(new THREE.CylinderGeometry(0.57, 0.57, 0.34, 40, 1, true));
  const rimGeo = track(new THREE.CylinderGeometry(0.33, 0.33, 0.36, 28));
  const hubGeo = track(new THREE.CylinderGeometry(0.12, 0.14, 0.42, 16));
  const lugGeo = track(new THREE.CylinderGeometry(0.025, 0.025, 0.44, 8));
  const wheel = (x: number, z: number, parent: THREE.Object3D, dual = false) => {
    const w = new THREE.Group();
    w.name = "wheel";
    w.position.set(x, 0.57, z);
    const sides = dual ? [-0.19, 0.19] : [0];
    for (const dz of sides) {
      const tire = new THREE.Mesh(tireGeo, rubber);
      tire.position.z = dz;
      tire.castShadow = true;
      w.add(tire);
      const tread = new THREE.Mesh(tireTread, rubber);
      tread.rotation.x = Math.PI / 2;
      tread.position.z = dz;
      w.add(tread);
    }
    const rim = new THREE.Mesh(rimGeo, chrome);
    rim.rotation.x = Math.PI / 2;
    w.add(rim);
    const hub = new THREE.Mesh(hubGeo, brushed);
    hub.rotation.x = Math.PI / 2;
    w.add(hub);
    for (let i = 0; i < 8; i++) {
      const lug = new THREE.Mesh(lugGeo, chrome);
      lug.rotation.x = Math.PI / 2;
      lug.position.set(Math.cos((i / 8) * Math.PI * 2) * 0.2, Math.sin((i / 8) * Math.PI * 2) * 0.2, 0);
      w.add(lug);
    }
    parent.add(w);
    wheels.push(w);
  };
  for (const z of [1.08, -1.08]) {
    wheel(3.0, z, g); // steer
    wheel(-0.9, z * 0.9, g, true); // drive axles
    wheel(-2.15, z * 0.9, g, true);
    wheel(-2.0, z * 0.9, trailer, true); // trailer tandem
    wheel(-3.2, z * 0.9, trailer, true);
  }

  return { group: g, wheels, bed, tailgate, load, dispose: () => disposables.forEach((d) => d.dispose()) };
}

export function TruckScene({ progress, className, onReady, frameRight = 0 }: TruckSceneProps) {
  const host = useRef<HTMLDivElement>(null);
  const shift = useRef(frameRight);
  useEffect(() => { shift.current = frameRight; }, [frameRight]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    el.appendChild(renderer.domElement);
    renderer.domElement.setAttribute("aria-hidden", "true");

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const env = pmrem.fromScene(room, 0.04).texture;
    scene.environment = env;

    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 200);
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(8, 14, 9);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -12;
    key.shadow.camera.right = 12;
    key.shadow.camera.top = 10;
    key.shadow.camera.bottom = -10;
    key.shadow.radius = 6;
    key.shadow.bias = -0.0004;
    scene.add(key);
    const rim = new THREE.DirectionalLight(ELECTRIC, 1.6);
    rim.position.set(-10, 5, -8);
    scene.add(rim);
    scene.add(new THREE.HemisphereLight(0xbfd6ff, 0x0b1726, 0.35));

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.ShadowMaterial({ opacity: 0.42 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    // Road: subtle dashed centre line that slides under the truck as the story advances.
    const dashGeo = new THREE.PlaneGeometry(1.6, 0.12);
    const dashMat = new THREE.MeshBasicMaterial({ color: SILVER, transparent: true, opacity: 0.18 });
    const dashes = new THREE.Group();
    for (let i = 0; i < 24; i++) {
      const d = new THREE.Mesh(dashGeo, dashMat);
      d.rotation.x = -Math.PI / 2;
      d.position.set(-30 + i * 3, 0.01, 2.2);
      dashes.add(d);
    }
    scene.add(dashes);

    const truck = buildTruck();
    truck.group.position.x = 0.9;
    scene.add(truck.group);

    // --- Story props (all original geometry; each one illustrates a chapter, see SCENES) ------------------------
    const props: Array<{ dispose: () => void }> = [];
    const keep = <T extends { dispose: () => void }>(x: T) => (props.push(x), x);
    const glow = (opacity: number) => keep(new THREE.MeshBasicMaterial({ color: ELECTRIC, transparent: true, opacity, depthWrite: false }));

    // The fleet: two more of the same rigs parked in the yard behind the hero truck (shared geometry, no shadows).
    const fleet = [-6.5, -13].map((z) => {
      const t = truck.group.clone(true);
      t.traverse((o) => { o.castShadow = false; });
      t.position.set(0.9, 0, z);
      t.visible = false;
      scene.add(t);
      return { group: t, z, wheels: (() => { const w: THREE.Object3D[] = []; t.traverse((o) => { if (o.name === "wheel") w.push(o); }); return w; })() };
    });

    // The day's loads: pins on the ground ahead of the yard.
    const pinGeo = keep(new THREE.ConeGeometry(0.42, 1.1, 20));
    const pinHead = keep(new THREE.SphereGeometry(0.42, 20, 14));
    const pinMat = keep(new THREE.MeshStandardMaterial({ color: ELECTRIC, emissive: ELECTRIC, emissiveIntensity: 0.9, metalness: 0.2, roughness: 0.4, transparent: true }));
    const LOADS: Array<[number, number]> = [[6, 7.5], [2, 10], [-2.5, 8], [9.5, 11], [12, 7.5]];
    const pins = LOADS.map(([x, z]) => {
      const pin = new THREE.Group();
      const cone = new THREE.Mesh(pinGeo, pinMat);
      cone.rotation.x = Math.PI;
      cone.position.y = 0.55;
      const head = new THREE.Mesh(pinHead, pinMat);
      head.position.y = 1.2;
      pin.add(cone, head);
      pin.position.set(x, 0, z);
      scene.add(pin);
      return pin;
    });

    // Assignment lines from each truck to its loads, drawn progressively (drawRange). Two sets: the plan (links), and
    // for "compare plans" an alternative (dim) beside the chosen one (bright).
    const arc = (from: [number, number], to: [number, number], lift: number) => {
      const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(from[0], 0.15, from[1]), new THREE.Vector3((from[0] + to[0]) / 2, lift, (from[1] + to[1]) / 2), new THREE.Vector3(to[0], 0.15, to[1]));
      return keep(new THREE.TubeGeometry(curve, 48, 0.07, 8, false));
    };
    // Line start: beside each truck's cab, on the side facing the loads.
    const yard: Array<[number, number]> = [[2, 1.6], [2, -4.9], [2, -11.4]];
    const linkSets = (pairs: Array<[number, number]>, lift: number, mat: THREE.Material) => pairs.map(([t, l]) => {
      const m = new THREE.Mesh(arc(yard[t], LOADS[l], lift), mat);
      scene.add(m);
      return m;
    });
    const linkMat = glow(0.9);
    const planMat = glow(0.95);
    const altMat = glow(0.28);
    const links = linkSets([[0, 0], [0, 4], [1, 1], [2, 2], [2, 3]], 2.2, linkMat);
    const chosen = linkSets([[0, 0], [0, 4], [1, 1], [2, 2], [2, 3]], 0.6, planMat);
    const alternative = linkSets([[0, 1], [1, 0], [1, 4], [2, 3], [2, 2]], 3.4, altMat);

    // The checks: an inspection pad outlined around the rig and a gate frame ahead of the cab.
    const padMat = glow(0.85);
    const pad = new THREE.Group();
    for (const [w, d, x, z] of [[14.6, 0.08, -2.4, 1.9], [14.6, 0.08, -2.4, -1.9], [0.08, 3.8, 4.9, 0], [0.08, 3.8, -9.7, 0]] as const) {
      const m = new THREE.Mesh(keep(new THREE.BoxGeometry(w, 0.03, d)), padMat);
      m.position.set(x + 0.9, 0.02, z);
      pad.add(m);
    }
    const gateMat = keep(new THREE.MeshStandardMaterial({ color: SILVER, metalness: 0.8, roughness: 0.35, transparent: true }));
    for (const z of [2.3, -2.3]) {
      const post = new THREE.Mesh(keep(new THREE.BoxGeometry(0.22, 4.6, 0.22)), gateMat);
      post.position.set(7.2, 2.3, z);
      pad.add(post);
    }
    const beam = new THREE.Mesh(keep(new THREE.BoxGeometry(0.26, 0.3, 4.9)), gateMat);
    beam.position.set(7.2, 4.6, 0);
    pad.add(beam);
    const beamLight = new THREE.Mesh(keep(new THREE.BoxGeometry(0.28, 0.08, 4.4)), padMat);
    beamLight.position.set(7.2, 4.42, 0);
    pad.add(beamLight);
    scene.add(pad);

    // The delivery: a stream from the open tailgate and a pile growing on the ground behind the trailer.
    const stoneMat = keep(new THREE.MeshStandardMaterial({ color: 0x8a8278, roughness: 1, metalness: 0, flatShading: true }));
    const pile = new THREE.Mesh(keep(new THREE.ConeGeometry(2.4, 1.6, 28, 3)), stoneMat);
    pile.receiveShadow = pile.castShadow = true;
    pile.position.set(0.9 - 5.2 - 3.78 - 2.0, 0, 0);
    scene.add(pile);
    const stream = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.5, 0.95, 1, 16, 1, true)), stoneMat);
    scene.add(stream);

    const resize = () => {
      const w = el.clientWidth || 1;
      const h = el.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      // Narrow screens: widen the lens so the whole rig stays in frame.
      camera.fov = w / h < 0.9 ? 50 : w / h < 1.3 ? 40 : 32;
      // Side-by-side layout on a tall screen (a tablet in portrait at 1024 px): the text column is relatively wider, so
      // the truck is drawn smaller and further right to stay clear of it.
      const tallSideBySide = shift.current > 0 && w / h < 1.2;
      camera.zoom = tallSideBySide ? 0.6 : 1;
      const offset = shift.current * (tallSideBySide ? 1.15 : 1);
      if (offset) camera.setViewOffset(w, h, -w * offset, 0, w, h);
      else camera.clearViewOffset();
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    let visible = true;
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; }, { threshold: 0 });
    io.observe(el);

    let shown = -1;
    let lastShift = shift.current;
    let eased = progress.current;
    let frame = 0;
    let ready = false;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      if (!visible) return;
      // Ease towards the scroll position; render only while something changes.
      eased += (progress.current - eased) * 0.12;
      if (Math.abs(eased - progress.current) < 0.0004) eased = progress.current;
      if (lastShift !== shift.current) { lastShift = shift.current; resize(); shown = -1; }
      if (eased === shown && ready) return;
      shown = eased;
      const s = sceneAt(eased);
      camera.position.set(...s.cam);
      camera.lookAt(...s.look);
      const travel = s.travel;
      for (const w of truck.wheels) w.rotation.z = -travel / 0.57;
      dashes.position.x = -(travel % 3);

      // Fleet: drives into the yard from behind as the scene arrives (wheels turn with it), leaves the same way.
      for (const f of fleet) {
        f.group.visible = s.fleet > 0.01;
        f.group.position.x = 0.9 - (1 - s.fleet) * 34;
        for (const w of f.wheels) w.rotation.z = (1 - s.fleet) * 34 / 0.57;
      }
      // Loads and assignment lines, drawn from the truck to the load.
      const lineVisible = Math.max(s.links, s.plans);
      for (const p of pins) {
        p.visible = lineVisible > 0.01;
        p.scale.setScalar(Math.max(lineVisible, 0.001));
      }
      const draw = (meshes: THREE.Mesh[], amount: number) => meshes.forEach((m) => {
        m.visible = amount > 0.01;
        const count = (m.geometry.index?.count ?? 0);
        m.geometry.setDrawRange(0, Math.floor(count * Math.min(amount, 1) / 6) * 6);
      });
      draw(links, s.links);
      draw(chosen, s.plans);
      draw(alternative, s.plans);
      linkMat.opacity = 0.9 * Math.min(1, s.links * 1.5);
      planMat.opacity = 0.95 * Math.min(1, s.plans * 1.5);
      altMat.opacity = 0.28 * Math.min(1, s.plans * 1.5);
      pinMat.opacity = Math.min(1, lineVisible * 1.5);
      // Checks.
      pad.visible = s.checks > 0.01;
      padMat.opacity = 0.85 * s.checks;
      gateMat.opacity = s.checks;
      // Delivery: the body tips up to ~50°, the tailgate swings open, the heap leaves the body and the pile grows.
      const tip = Math.min(1, s.dump / 0.7);
      const pour = Math.min(1, Math.max(0, (s.dump - 0.35) / 0.65));
      truck.bed.rotation.z = tip * 0.72; // front of the body rises; it pivots at the rear
      truck.tailgate.rotation.z = -tip * 1.15; // hangs from its top hinge and swings clear of the body
      truck.load.visible = pour < 0.98;
      truck.load.scale.set(3.4 * (1 - pour * 0.35), Math.max(0.38 * (1 - pour), 0.001), 1.12);
      pile.visible = pour > 0.01;
      pile.scale.set(0.35 + pour * 0.65, Math.max(pour, 0.001), 0.35 + pour * 0.65);
      pile.position.y = 0.8 * pour;
      stream.visible = pour > 0.02 && pour < 0.97;
      if (stream.visible) {
        // From the tailgate opening down to the pile.
        const gate = new THREE.Vector3();
        truck.tailgate.getWorldPosition(gate);
        const top = gate.y - 1.2;
        const h = Math.max(top - pile.position.y * 1.6, 0.3);
        stream.scale.set(0.8, h, 0.8);
        stream.position.set(gate.x - 0.9, pile.position.y * 1.6 + h / 2, 0);
      }
      renderer.render(scene, camera);
      // What is on screen, for tests and screenshots (scene index, two decimals).
      el.dataset.shown = (eased * (SCENES.length - 1)).toFixed(2);
      if (!ready) {
        ready = true;
        onReady?.();
      }
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      io.disconnect();
      truck.dispose();
      props.forEach((d) => d.dispose());
      dashGeo.dispose();
      dashMat.dispose();
      ground.geometry.dispose();
      (ground.material as THREE.Material).dispose();
      env.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [progress, onReady]);

  return <div ref={host} className={className} />;
}

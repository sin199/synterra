// Synterra living-world renderer (three.js r169, vendored in /vendor so it works offline).
// Data contract is unchanged: reads the /local/map-data payload (scenes, residents, world.engine clock,
// trading) and exposes createWorld3D(canvas, labelsElement, onSelect) -> { update, select, dispose } | null.
import * as THREE from './vendor/three.module.min.js';

const TAU = Math.PI * 2;
const ISLAND_RADIUS = 18.5;
const ISLAND_Z = 0.8;
const FLAT_ZONE = 0.74;
const PLAZA_RADIUS = 4.1;
const PLAZA_RING = 3.55;
const WATER_LEVEL = -0.32;

const TYPE_STYLE = {
  garden: { accent: '#6fbf5f', label: '#7ccf6b' },
  studio: { accent: '#9b7fd1', label: '#b9a2f0' },
  library: { accent: '#3f6fb5', label: '#8fb4ef' },
  cafe: { accent: '#e08a3c', label: '#f2b277' },
  workshop: { accent: '#e3b23c', label: '#f0cf73' },
  observatory: { accent: '#4f7cc4', label: '#9ec0f2' },
  commons: { accent: '#a5c25a', label: '#c8e07f' },
  data_center: { accent: '#34c3d9', label: '#7fe6f5' }
};

// ---------------------------------------------------------------------------------------------
// small deterministic helpers
function hash(value) {
  let result = 2166136261;
  for (const char of String(value)) result = Math.imul(result ^ char.charCodeAt(0), 16777619);
  return result >>> 0;
}
function rng(seed) {
  let state = hash(seed) || 1;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return ((state >>> 0) % 100000) / 100000; };
}
function lattice(ix, iz) {
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function noise2(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = lattice(ix, iz), b = lattice(ix + 1, iz), c = lattice(ix, iz + 1), d = lattice(ix + 1, iz + 1);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}
function fbm(x, z) { return noise2(x, z) * 0.55 + noise2(x * 2.1 + 7.3, z * 2.1 - 3.1) * 0.3 + noise2(x * 4.3 - 2.2, z * 4.3 + 9.4) * 0.15; }
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function coastRadius(angle) {
  return ISLAND_RADIUS * (1 + (noise2(Math.cos(angle) * 1.6 + 4, Math.sin(angle) * 1.6 + 4) - 0.5) * 0.16);
}
// normalized elliptical distance from island center: 0 centre, 1 coastline
function islandDistance(x, z) {
  const zz = z / ISLAND_Z, angle = Math.atan2(zz, x);
  return Math.hypot(x, zz) / coastRadius(angle);
}
function heightAt(x, z) {
  const d = islandDistance(x, z);
  const hills = smooth(FLAT_ZONE, 0.86, d) * (0.45 + fbm(x * 0.16, z * 0.16) * 1.9) * (1 - smooth(0.9, 0.99, d));
  const shore = -smooth(0.93, 1.06, d) * 1.1;
  return hills + shore;
}

// ---------------------------------------------------------------------------------------------
// materials and geometry builders
function makeMaterials() {
  const cache = new Map();
  const std = (color, options = {}) => {
    const key = `${color}|${JSON.stringify(options)}`;
    if (!cache.has(key)) cache.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.82, metalness: 0, flatShading: true, ...options }));
    return cache.get(key);
  };
  return {
    std,
    window: new THREE.MeshStandardMaterial({ color: '#3d4f62', emissive: '#ffcf86', emissiveIntensity: 0.05, roughness: 0.3, flatShading: true }),
    lamp: new THREE.MeshStandardMaterial({ color: '#fff3d0', emissive: '#ffd27a', emissiveIntensity: 0.2, flatShading: true }),
    screen: new THREE.MeshStandardMaterial({ color: '#0d2a2c', emissive: '#4be3ff', emissiveIntensity: 0.9, roughness: 0.4, flatShading: true }),
    led: new THREE.MeshStandardMaterial({ color: '#082024', emissive: '#7dffb0', emissiveIntensity: 1.4, flatShading: true }),
    beacon: new THREE.MeshStandardMaterial({ color: '#3a0d0d', emissive: '#ff4040', emissiveIntensity: 1.5, flatShading: true }),
    glass: new THREE.MeshStandardMaterial({ color: '#cfeff2', roughness: 0.12, metalness: 0.1, transparent: true, opacity: 0.38, flatShading: true }),
    fountain: new THREE.MeshStandardMaterial({ color: '#6cc6e0', emissive: '#2a7fa0', emissiveIntensity: 0.25, roughness: 0.15, flatShading: true }),
    smoke: new THREE.MeshStandardMaterial({ color: '#e8e6e2', roughness: 1, transparent: true, opacity: 0.55, flatShading: true, depthWrite: false })
  };
}

function gableGeometry(width, height, depth) {
  const shape = new THREE.Shape();
  shape.moveTo(-width / 2, 0); shape.lineTo(width / 2, 0); shape.lineTo(0, height); shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  geometry.translate(0, 0, -depth / 2);
  return geometry;
}

class Builder {
  constructor(group, materials) { this.group = group; this.m = materials; }
  add(geometry, material, x = 0, y = 0, z = 0, options = {}) {
    const mesh = new THREE.Mesh(geometry, typeof material === 'string' ? this.m.std(material) : material);
    mesh.position.set(x, y, z);
    if (options.ry) mesh.rotation.y = options.ry;
    if (options.rx) mesh.rotation.x = options.rx;
    if (options.rz) mesh.rotation.z = options.rz;
    if (options.scale) mesh.scale.set(...options.scale);
    mesh.castShadow = options.cast !== false;
    mesh.receiveShadow = true;
    if (options.dynamic) mesh.userData.dynamic = true;
    (options.parent || this.group).add(mesh);
    return mesh;
  }
  box(w, h, d, material, x, y, z, options) { return this.add(new THREE.BoxGeometry(w, h, d), material, x, y + h / 2, z, options); }
  cyl(rt, rb, h, seg, material, x, y, z, options) { return this.add(new THREE.CylinderGeometry(rt, rb, h, seg), material, x, y + h / 2, z, options); }
  sphere(r, material, x, y, z, options, detail = 0) { return this.add(new THREE.IcosahedronGeometry(r, detail), material, x, y, z, options); }
  gable(w, h, d, material, x, y, z, options) { return this.add(gableGeometry(w, h, d), material, x, y, z, options); }
  pyramid(r, h, seg, material, x, y, z, options) {
    return this.add(new THREE.ConeGeometry(r, h, seg), material, x, y + h / 2, z, { ry: seg === 4 ? Math.PI / 4 : 0, ...options });
  }
  windowsRow(count, span, y, z, w = 0.22, h = 0.3, options = {}) {
    for (let i = 0; i < count; i += 1) {
      const x = count === 1 ? 0 : -span / 2 + (span / (count - 1)) * i;
      if (options.sideX !== undefined) this.box(0.04, h, w, this.m.window, options.sideX, y, x, { cast: false });
      else this.box(w, h, 0.04, this.m.window, x, y, z, { cast: false });
    }
  }
  door(x, y, z, color = '#6b4a32', w = 0.32, h = 0.55) {
    this.box(w + 0.08, h + 0.05, 0.05, '#efe7d6', x, y, z - 0.01, { cast: false });
    this.box(w, h, 0.06, color, x, y, z, { cast: false });
  }
  sign(color, x, y, z) {
    this.box(0.05, 0.75, 0.05, '#6d4c33', x, y, z);
    this.box(0.46, 0.26, 0.05, color, x, y + 0.62, z + 0.04);
    this.box(0.36, 0.06, 0.06, '#fdf6e3', x, y + 0.72, z + 0.05, { cast: false });
  }
  smokeStack(x, y, z) {
    const puffs = [];
    for (let i = 0; i < 4; i += 1) {
      const puff = this.sphere(0.12, this.m.smoke, x, y, z, { dynamic: true, cast: false });
      puff.userData.smoke = { x, y, z, offset: i / 4 };
      puffs.push(puff);
    }
    return puffs;
  }
}

// ---- place models: built in local space, front of building faces +z (toward the plaza) ------------
function buildPlace(b, type, seed) {
  const r = rng(seed);
  const style = TYPE_STYLE[type] || TYPE_STYLE.commons;
  b.cyl(1.75, 1.85, 0.12, 9, '#cbbf9f', 0, 0, 0, { cast: false });
  if (type === 'garden') {
    for (let row = 0; row < 3; row += 1) {
      b.box(1.7, 0.1, 0.36, '#6b4a2f', -0.15, 0.1, -0.55 + row * 0.55, { cast: false });
      for (let i = 0; i < 6; i += 1) {
        const color = row === 1 ? '#e2c84c' : (i % 2 ? '#5fae4f' : '#4f9b45');
        b.sphere(0.1 + r() * 0.05, color, -0.88 + i * 0.29, 0.28, -0.55 + row * 0.55);
      }
    }
    b.box(0.8, 0.55, 0.62, b.m.glass, 1.05, 0.12, -0.75, { cast: false });
    b.gable(0.84, 0.32, 0.66, b.m.glass, 1.05, 0.67, -0.75, { cast: false });
    b.box(0.86, 0.04, 0.68, '#f7f4ec', 1.05, 0.66, -0.75);
    for (const [x, z] of [[-1.45, -1.2], [1.45, 0.65], [-1.45, 0.9]]) {
      b.cyl(0.06, 0.08, 0.5, 6, '#7a5233', x, 0.1, z);
      b.sphere(0.36, '#5a9d48', x, 0.82, z, {}, 0);
      for (let k = 0; k < 3; k += 1) b.sphere(0.06, '#e2513f', x + (r() - 0.5) * 0.5, 0.7 + r() * 0.3, z + 0.28);
    }
    for (let i = 0; i < 12; i += 1) {
      const angle = (i / 12) * TAU;
      b.box(0.06, 0.32, 0.06, '#f2ead9', Math.cos(angle) * 1.65, 0.1, Math.sin(angle) * 1.65);
    }
    b.cyl(0.15, 0.15, 0.3, 8, '#7f5a3b', -1.15, 0.1, 1.15);
    for (let i = 0; i < 10; i += 1) b.sphere(0.06, ['#f2a1c1', '#f5d34f', '#ffffff', '#c58df0'][i % 4], -0.6 + r() * 1.4, 0.2, 1.05 + r() * 0.4, { cast: false });
    b.sign(style.accent, 0.95, 0.1, 1.25);
  } else if (type === 'studio') {
    b.box(2.1, 1.3, 1.6, '#ece6f5', 0, 0.12, -0.2);
    b.box(2.3, 0.12, 1.85, '#6c5b9e', 0, 1.5, -0.2, { rx: -0.16 });
    b.box(1.3, 0.75, 0.05, b.m.window, -0.25, 0.42, 0.61);
    b.box(1.36, 0.06, 0.08, '#4a3f6e', -0.25, 1.17, 0.62);
    b.door(0.72, 0.12, 0.6, '#6c5b9e');
    b.windowsRow(2, 0.8, 0.65, 0, 0.3, 0.35, { sideX: 1.06 });
    b.box(0.5, 0.18, 0.5, b.m.glass, 0.4, 1.55, -0.5, { cast: false });
    b.box(0.05, 0.75, 0.05, '#7b5536', -1.1, 0.12, 1.15, { rx: 0.15 });
    b.box(0.05, 0.75, 0.05, '#7b5536', -0.85, 0.12, 1.15, { rx: 0.15 });
    b.box(0.42, 0.34, 0.03, '#fdf8ee', -0.98, 0.55, 1.08, { rx: 0.15 });
    b.box(0.3, 0.12, 0.035, '#e86b6b', -0.98, 0.62, 1.1, { rx: 0.15, cast: false });
    b.box(0.2, 0.08, 0.035, '#5fa8e8', -0.92, 0.5, 1.1, { rx: 0.15, cast: false });
    b.sign(style.accent, 1.15, 0.1, 1.2);
  } else if (type === 'library') {
    b.box(2.4, 0.12, 1.25, '#e2d8c2', 0, 0.12, 0.95, { cast: false });
    b.box(2.2, 0.12, 1.05, '#e9e0cc', 0, 0.24, 0.9, { cast: false });
    b.box(2.2, 1.25, 1.5, '#efe2c4', 0, 0.12, -0.35);
    for (let i = 0; i < 4; i += 1) b.cyl(0.09, 0.1, 1.05, 8, '#f8f3e6', -0.84 + i * 0.56, 0.36, 1.2);
    b.box(2.3, 0.12, 0.6, '#f3ead7', 0, 1.41, 1.05);
    b.gable(2.45, 0.6, 2.45, '#8a3b32', 0, 1.37, 0.1);
    b.box(2.5, 0.06, 2.5, '#f3ead7', 0, 1.33, 0.1, { cast: false });
    b.door(0, 0.36, 0.42, '#5a3626', 0.42, 0.7);
    b.windowsRow(2, 1.2, 0.62, 0.42, 0.28, 0.42);
    b.windowsRow(3, 0.9, 0.55, 0, 0.26, 0.4, { sideX: 1.11 });
    b.windowsRow(3, 0.9, 0.55, 0, 0.26, 0.4, { sideX: -1.11 });
    b.sign(style.accent, 1.45, 0.1, 1.35);
  } else if (type === 'cafe') {
    b.box(1.8, 1.05, 1.35, '#f4dcb8', 0, 0.12, -0.3);
    b.gable(2.05, 0.75, 1.6, '#c4653a', 0, 1.17, -0.3, { ry: Math.PI / 2 });
    b.box(0.22, 0.6, 0.22, '#9a5b3c', 0.55, 1.45, -0.6);
    b.smokeStack(0.55, 2.1, -0.6);
    b.box(1.0, 0.5, 0.05, b.m.window, -0.25, 0.48, 0.38);
    b.door(0.6, 0.12, 0.38, '#7a3e22');
    for (let i = 0; i < 7; i += 1) {
      b.box(0.27, 0.05, 0.5, i % 2 ? '#fbf3e4' : '#d9534f', -0.81 + i * 0.27, 1.05, 0.6, { rx: 0.35 });
    }
    for (const [x, color] of [[-0.9, '#d9534f'], [0.35, '#3f8f6f']]) {
      b.cyl(0.24, 0.24, 0.04, 10, '#f7efe0', x, 0.42, 1.25);
      b.cyl(0.03, 0.03, 0.75, 6, '#5a4636', x, 0.12, 1.25);
      b.pyramid(0.5, 0.25, 8, color, x, 0.86, 1.25);
      b.cyl(0.08, 0.08, 0.28, 8, '#5a4636', x - 0.35, 0.12, 1.3);
      b.cyl(0.08, 0.08, 0.28, 8, '#5a4636', x + 0.35, 0.12, 1.3);
      b.cyl(0.05, 0.04, 0.06, 8, '#ffffff', x, 0.46, 1.25, { cast: false });
    }
    b.sign(style.accent, 1.2, 0.1, 0.9);
  } else if (type === 'workshop') {
    b.box(2.0, 1.15, 1.6, '#8fa7a0', 0, 0.12, -0.25);
    b.gable(2.25, 0.7, 1.85, '#4d5a5e', 0, 1.27, -0.25);
    b.box(0.85, 0.85, 0.06, '#9a6b43', -0.35, 0.12, 0.57);
    b.box(0.85, 0.06, 0.07, '#6e4a2c', -0.35, 0.5, 0.6, { rz: 0.78 });
    b.box(0.85, 0.06, 0.07, '#6e4a2c', -0.35, 0.5, 0.6, { rz: -0.78 });
    b.windowsRow(1, 0, 0.55, 0.57, 0.36, 0.32);
    b.box(0.36, 0.32, 0.04, b.m.window, 0.55, 0.55, 0.57);
    b.cyl(0.13, 0.15, 1.3, 8, '#6f6560', 0.7, 1.2, -0.75);
    b.smokeStack(0.7, 2.55, -0.75);
    for (const [x, z, s] of [[1.3, 0.6, 0.36], [1.3, 1.0, 0.3], [1.28, 0.8, 0.26]]) b.box(s, s, s, '#b4864f', x, z === 0.8 ? 0.48 : 0.12, z, { ry: r() * 0.4 });
    for (let i = 0; i < 3; i += 1) b.add(new THREE.CylinderGeometry(0.09, 0.09, 0.8, 7), '#8b5e3c', -1.25, 0.22 + (i === 2 ? 0.16 : 0), 0.55 + (i === 2 ? 0.09 : i * 0.18), { rz: Math.PI / 2 });
    b.box(0.32, 0.12, 0.16, '#3a3d42', 0.3, 0.45, 1.15);
    b.cyl(0.08, 0.12, 0.33, 6, '#55585e', 0.3, 0.12, 1.15);
    b.sign(style.accent, 1.35, 0.1, 1.3);
  } else if (type === 'observatory') {
    b.cyl(0.95, 1.05, 1.35, 12, '#e9eef2', 0, 0.12, -0.2);
    b.cyl(1.08, 1.08, 0.1, 12, '#b9c4cc', 0, 1.47, -0.2);
    const dome = new THREE.Group(); dome.position.set(0, 1.57, -0.2); dome.userData.dynamic = true; dome.userData.spin = 0.06;
    b.group.add(dome);
    b.add(new THREE.SphereGeometry(0.98, 14, 7, 0, TAU, 0, Math.PI / 2), '#a9bfd0', 0, 0, 0, { parent: dome });
    b.add(new THREE.BoxGeometry(0.28, 0.08, 1.0), '#26313d', 0, 0.82, 0.25, { parent: dome, rx: -0.55 });
    b.add(new THREE.CylinderGeometry(0.1, 0.13, 1.1, 8), '#d7dde3', 0, 0.85, 0.5, { parent: dome, rx: 0.95 });
    b.door(0, 0.12, 0.84, '#3d4f6e', 0.34, 0.6);
    b.windowsRow(1, 0, 0.95, 0.84, 0.2, 0.26);
    for (let i = 0; i < 3; i += 1) b.box(0.7, 0.06, 0.25, '#d7d0bf', 0, 0.06 + i * 0.03, 1.15 - i * 0.2, { cast: false });
    b.cyl(0.03, 0.03, 0.7, 6, '#8f9aa5', -1.2, 0.12, 0.85);
    b.sphere(0.1, b.m.lamp, -1.2, 0.86, 0.85, { cast: false });
    b.sign(style.accent, 1.2, 0.1, 1.05);
  } else if (type === 'data_center') {
    b.box(2.3, 1.1, 1.6, '#3c4a57', 0, 0.12, -0.25);
    b.box(2.36, 0.08, 1.66, '#2a343e', 0, 1.22, -0.25);
    for (let col = 0; col < 4; col += 1) {
      b.box(0.36, 0.75, 0.05, '#1c252e', -0.75 + col * 0.5, 0.25, 0.56, { cast: false });
      for (let row = 0; row < 4; row += 1) {
        const led = b.box(0.28, 0.04, 0.03, row % 2 ? b.m.screen : b.m.led, -0.75 + col * 0.5, 0.33 + row * 0.16, 0.59, { cast: false, dynamic: row === 1 });
        if (row === 1) led.userData.blink = r() * TAU;
      }
    }
    for (const x of [-0.55, 0.45]) {
      b.box(0.62, 0.3, 0.62, '#5a6976', x, 1.3, -0.3);
      const fan = b.add(new THREE.BoxGeometry(0.5, 0.03, 0.08), '#1f272e', x, 1.62, -0.3, { dynamic: true, cast: false });
      fan.userData.spin = 6 + r() * 2;
    }
    b.cyl(0.03, 0.04, 1.2, 6, '#9aa5ae', 0.95, 1.3, -0.8);
    const beacon = b.sphere(0.07, b.m.beacon, 0.95, 2.52, -0.8, { cast: false, dynamic: true });
    beacon.userData.beacon = true;
    b.box(0.5, 0.25, 0.05, b.m.screen, 0.95, 0.75, 0.57, { cast: false });
    b.sign(style.accent, 1.45, 0.1, 1.15);
  } else {
    // commons (and any new place type): open pavilion with a fountain
    b.cyl(1.25, 1.3, 0.16, 8, '#d8cfb8', 0, 0.12, -0.35, { cast: false });
    for (let i = 0; i < 6; i += 1) {
      const angle = (i / 6) * TAU;
      b.cyl(0.07, 0.08, 1.0, 6, '#f5efe0', Math.cos(angle) * 1.0, 0.28, -0.35 + Math.sin(angle) * 1.0);
    }
    b.pyramid(1.45, 0.75, 6, type === 'commons' ? '#5c9a55' : '#7f6aa8', 0, 1.28, -0.35, { ry: Math.PI / 6 });
    b.sphere(0.1, style.accent, 0, 2.06, -0.35);
    b.cyl(0.5, 0.56, 0.24, 10, '#cdc5b2', 0.85, 0.12, 0.95);
    b.cyl(0.44, 0.44, 0.04, 10, b.m.fountain, 0.85, 0.32, 0.95, { cast: false });
    b.cyl(0.06, 0.08, 0.45, 6, '#cdc5b2', 0.85, 0.32, 0.95);
    const spray = b.sphere(0.11, b.m.fountain, 0.85, 0.86, 0.95, { cast: false, dynamic: true });
    spray.userData.bob = true;
    for (const [x, z, ry] of [[-0.95, 0.85, 0.3], [-0.2, 1.3, 0]]) {
      b.box(0.62, 0.05, 0.2, '#9a6b43', x, 0.3, z, { ry });
      b.box(0.05, 0.18, 0.18, '#4a4a4a', x - 0.25, 0.12, z, { ry });
      b.box(0.05, 0.18, 0.18, '#4a4a4a', x + 0.25, 0.12, z, { ry });
    }
    b.sign(style.accent, 1.5, 0.1, 0.1);
  }
}

function buildExchange(b, boardTexture) {
  b.cyl(1.75, 1.85, 0.18, 8, '#d6ccb4', 0, 0.02, 0, { cast: false });
  b.cyl(1.45, 1.5, 1.3, 8, '#f1ead8', 0, 0.2, 0, { ry: Math.PI / 8 });
  for (let i = 0; i < 8; i += 1) {
    const angle = (i / 8) * TAU + Math.PI / 8;
    b.cyl(0.09, 0.1, 1.3, 7, '#fbf7ec', Math.cos(angle) * 1.62, 0.2, Math.sin(angle) * 1.62);
  }
  b.cyl(1.82, 1.82, 0.14, 8, '#e7dfca', 0, 1.5, 0, { ry: Math.PI / 8 });
  b.add(new THREE.SphereGeometry(1.25, 16, 8, 0, TAU, 0, Math.PI / 2), '#3aa58f', 0, 1.64, 0, { options: {} });
  b.cyl(0.05, 0.06, 0.55, 6, '#d9b45a', 0, 2.85, 0);
  b.sphere(0.12, '#f0c75e', 0, 3.45, 0);
  const board = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 0.62), new THREE.MeshBasicMaterial({ map: boardTexture, toneMapped: false }));
  board.position.set(0, 1.0, 1.52); b.group.add(board);
  b.box(1.82, 0.74, 0.06, '#26343a', 0, 0.63, 1.48, { cast: false });
  b.door(0, 0.2, 1.51, '#2f5a50', 0.42, 0.3);
  for (const angle of [0.6, -0.6, Math.PI - 0.6, Math.PI + 0.6]) {
    const x = Math.sin(angle) * 2.6, z = Math.cos(angle) * 2.6;
    b.cyl(0.035, 0.04, 2.1, 6, '#dcd6c8', x, 0.02, z);
    const flag = b.box(0.5, 0.3, 0.02, angle > 2 ? '#3aa58f' : '#e3b23c', x + 0.27, 1.75, z, { dynamic: true, cast: false });
    flag.userData.flag = hash(angle) % 100 / 10;
  }
}

// ---------------------------------------------------------------------------------------------
// resident figures
const SKIN = ['#f1c9a5', '#e0ac85', '#c68b5f', '#8d5a3b', '#f6d7bd', '#b97a52'];
const HAIR = ['#2b1d14', '#5a3a22', '#b5793c', '#d9b25d', '#1c1c22', '#8c4a2f', '#9a9aa0'];
const PANTS = ['#2f3a4d', '#4a3b2f', '#3d4a3a', '#22252b', '#5b4b6b'];

function buildResidentFigure(resident, materials) {
  const h = hash(resident.id);
  const shirt = new THREE.Color().setHSL((((h >>> 3) % 360) / 360), 0.68, 0.5);
  const std = (color) => materials.std(typeof color === 'string' ? color : `#${color.getHexString()}`);
  const skin = std(SKIN[(h >>> 9) % SKIN.length]);
  const hairMat = std(HAIR[(h >>> 13) % HAIR.length]);
  const pantsMat = std(PANTS[(h >>> 17) % PANTS.length]);
  const shirtMat = std(shirt);
  const root = new THREE.Group();
  root.scale.setScalar(1.25);
  const body = new THREE.Group(); root.add(body);
  const part = (geometry, material, x, y, z, parent = body) => {
    const mesh = new THREE.Mesh(geometry, material); mesh.position.set(x, y, z);
    mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh;
  };
  const limb = (x, y, parent = body) => { const pivot = new THREE.Group(); pivot.position.set(x, y, 0); parent.add(pivot); return pivot; };
  const legL = limb(-0.075, 0.42), legR = limb(0.075, 0.42);
  for (const leg of [legL, legR]) {
    part(new THREE.BoxGeometry(0.11, 0.36, 0.12), pantsMat, 0, -0.18, 0, leg);
    part(new THREE.BoxGeometry(0.12, 0.07, 0.17), std('#2a2522'), 0, -0.38, 0.025, leg);
  }
  const torso = part(new THREE.CylinderGeometry(0.16, 0.13, 0.38, 8), shirtMat, 0, 0.6, 0);
  torso.scale.z = 0.72;
  part(new THREE.CylinderGeometry(0.135, 0.15, 0.06, 8), pantsMat, 0, 0.42, 0).scale.z = 0.75;
  const armL = limb(-0.205, 0.76), armR = limb(0.205, 0.76);
  for (const arm of [armL, armR]) {
    part(new THREE.BoxGeometry(0.085, 0.3, 0.09), shirtMat, 0, -0.14, 0, arm);
    part(new THREE.IcosahedronGeometry(0.05, 0), skin, 0, -0.32, 0, arm);
  }
  const head = new THREE.Group(); head.position.set(0, 0.97, 0); body.add(head);
  part(new THREE.IcosahedronGeometry(0.155, 1), skin, 0, 0, 0, head);
  part(new THREE.SphereGeometry(0.165, 10, 6, 0, TAU, 0, Math.PI * 0.55), hairMat, 0, 0.015, -0.015, head).rotation.x = -0.25;
  if (resident.gender === 'female') part(new THREE.BoxGeometry(0.28, 0.24, 0.08), hairMat, 0, -0.08, -0.12, head);
  for (const x of [-0.055, 0.055]) part(new THREE.BoxGeometry(0.03, 0.04, 0.02), std('#1d1d1f'), x, 0.01, 0.148, head).castShadow = false;
  const archetype = resident.archetype;
  if (archetype === 'naturalist') {
    part(new THREE.CylinderGeometry(0.22, 0.22, 0.025, 12), std('#e3c27a'), 0, 0.11, 0, head);
    part(new THREE.CylinderGeometry(0.12, 0.14, 0.09, 12), std('#d8b468'), 0, 0.16, 0, head);
  } else if (archetype === 'scholar') {
    part(new THREE.BoxGeometry(0.3, 0.025, 0.3), std('#26272e'), 0, 0.17, 0, head).rotation.y = Math.PI / 4;
    part(new THREE.CylinderGeometry(0.11, 0.12, 0.07, 10), std('#26272e'), 0, 0.13, 0, head);
  } else if (archetype === 'maker') {
    part(new THREE.SphereGeometry(0.175, 10, 5, 0, TAU, 0, Math.PI / 2), std('#f2c335'), 0, 0.05, 0, head);
    part(new THREE.CylinderGeometry(0.2, 0.2, 0.02, 12), std('#f2c335'), 0, 0.05, 0.03, head);
  } else if (archetype) {
    part(new THREE.SphereGeometry(0.17, 10, 5, 0, TAU, 0, Math.PI / 2), std(`#${shirt.clone().offsetHSL(0.5, 0, -0.1).getHexString()}`), 0, 0.04, 0, head);
    part(new THREE.IcosahedronGeometry(0.05, 0), std('#fdf6e3'), 0, 0.22, 0, head);
  }
  // hand-held props for actions
  const props = {
    book: part(new THREE.BoxGeometry(0.2, 0.14, 0.04), std('#b8423a'), 0.0, 0.62, 0.22),
    tablet: part(new THREE.BoxGeometry(0.2, 0.13, 0.02), materials.screen, 0.0, 0.64, 0.22),
    cup: part(new THREE.CylinderGeometry(0.04, 0.035, 0.08, 8), std('#ffffff'), 0, -0.36, 0.04, armR),
    hammer: new THREE.Group()
  };
  part(new THREE.BoxGeometry(0.025, 0.24, 0.025), std('#8b5e3c'), 0, -0.04, 0.1, props.hammer).rotation.x = Math.PI / 2;
  part(new THREE.BoxGeometry(0.06, 0.06, 0.12), std('#5d6066'), 0, -0.04, 0.22, props.hammer);
  props.hammer.position.set(0, -0.32, 0); armR.add(props.hammer);
  props.book.rotation.x = -0.6; props.tablet.rotation.x = -0.9;
  for (const prop of Object.values(props)) prop.visible = false;
  // selection ring, soft contact shadow, and invisible hit proxy
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.38, 28), new THREE.MeshBasicMaterial({ color: '#c9f36a', transparent: true, opacity: 0.9, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03; ring.visible = false; root.add(ring);
  const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 1.3, 8), new THREE.MeshBasicMaterial({ visible: false }));
  hit.position.y = 0.65; hit.userData.residentId = resident.id; root.add(hit);
  return { root, body, legL, legR, armL, armR, head, props, ring, hit, phase: (h % 1000) / 1000 * TAU, heading: null, color: `#${shirt.getHexString()}` };
}

function poseResident(figure, activity, walking, time, reducedMotion) {
  const t = reducedMotion ? 0 : time / 1000 + figure.phase;
  const { body, legL, legR, armL, armR, head, props } = figure;
  let legSwing = 0, armLx = 0, armRx = 0, armRz = 0, armLz = 0, bob = 0, headX = 0, crouch = 0, sit = false;
  for (const prop of Object.values(props)) prop.visible = false;
  if (walking) {
    const s = Math.sin(t * 9);
    legSwing = s * 0.62; armLx = -s * 0.5; armRx = s * 0.5; bob = Math.abs(Math.cos(t * 9)) * 0.05;
  } else {
    const breathe = Math.sin(t * 1.6) * 0.012;
    bob = breathe;
    switch (activity?.kind) {
      case 'work': armRx = -1.6 + Math.sin(t * 7) * 0.55; armLx = -0.35; props.hammer.visible = true; headX = 0.2; break;
      case 'build': armRx = -1.6 + Math.sin(t * 7) * 0.55; armLx = -0.5; props.hammer.visible = true; crouch = 0.04; break;
      case 'learn': armLx = -0.95; armRx = -0.95; armLz = -0.25; armRz = 0.25; props.book.visible = true; headX = 0.35 + Math.sin(t * 0.7) * 0.05; break;
      case 'trade': armLx = -1.0; armRx = -1.0; armLz = -0.2; armRz = 0.2; props.tablet.visible = true; headX = 0.3 + Math.sin(t * 3) * 0.06; break;
      case 'socialize': armRz = 2.4 + Math.sin(t * 6) * 0.35; armLx = -0.15; headX = -0.05 + Math.sin(t * 2.3) * 0.08; break;
      case 'care':
        if (activity.label === '休息') { sit = true; headX = 0.25; }
        else { armRx = -1.9 + Math.max(0, Math.sin(t * 1.8)) * 0.9; props.cup.visible = true; }
        break;
      default: armLz = -0.06; armRz = 0.06; headX = Math.sin(t * 0.5) * 0.06;
    }
  }
  if (sit) {
    legL.rotation.x = legR.rotation.x = -1.45; body.position.y = -0.3; armLx = armRx = -0.35;
  } else {
    legL.rotation.x = legSwing; legR.rotation.x = -legSwing; body.position.y = bob - crouch;
  }
  armL.rotation.set(armLx, 0, armLz); armR.rotation.set(armRx, 0, armRz);
  head.rotation.x = headX;
}

// ---------------------------------------------------------------------------------------------
// sky / time-of-day palette
const SKY_KEYS = [
  [0, '#050b1e', '#16264a', '#8fa8ff', 0.6, 0.5, 1],
  [4.8, '#0b1736', '#34406e', '#9aa8ff', 0.55, 0.55, 0.95],
  [6.2, '#3d5a9a', '#f2a477', '#ffb37a', 1.8, 0.9, 0.35],
  [8, '#4e8fd8', '#f6dcb4', '#ffe2b8', 2.6, 1.05, 0],
  [12, '#3f8fe0', '#cfe6f6', '#fff4e2', 3.1, 1.2, 0],
  [16.5, '#4a8ad6', '#f3dcb2', '#ffe0b0', 2.7, 1.1, 0],
  [18.3, '#3b4f92', '#f39a68', '#ff9a5c', 1.8, 0.9, 0.3],
  [19.7, '#1a2350', '#6a4a74', '#a9a2ff', 0.65, 0.6, 0.8],
  [21, '#070e24', '#18284a', '#8fa8ff', 0.6, 0.5, 1],
  [24, '#050b1e', '#16264a', '#8fa8ff', 0.6, 0.5, 1]
];
const tmpA = new THREE.Color(), tmpB = new THREE.Color();
function skyAt(hour) {
  const h = ((hour % 24) + 24) % 24;
  let i = 0; while (i < SKY_KEYS.length - 2 && SKY_KEYS[i + 1][0] <= h) i += 1;
  const a = SKY_KEYS[i], b = SKY_KEYS[i + 1], k = (h - a[0]) / (b[0] - a[0]);
  const mix = (index) => tmpA.set(a[index]).lerp(tmpB.set(b[index]), k).clone();
  const lerp = (index) => a[index] + (b[index] - a[index]) * k;
  return { top: mix(1), horizon: mix(2), light: mix(3), lightIntensity: lerp(4), hemi: lerp(5), night: lerp(6) };
}

function makeSky() {
  const uniforms = { top: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunColor: { value: new THREE.Color() }, day: { value: 1 } };
  const material = new THREE.ShaderMaterial({
    uniforms, side: THREE.BackSide, depthWrite: false, fog: false,
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; uniform vec3 sunColor; uniform float day; varying vec3 vDir;
      void main(){ float h = vDir.y; vec3 c = mix(horizon, top, pow(clamp(h,0.0,1.0),0.55));
        c = mix(c, horizon*0.82, smoothstep(0.0,-0.25,h));
        float s = max(dot(normalize(vDir), normalize(sunDir)), 0.0);
        c += sunColor * (pow(s, 600.0) * 2.0 + pow(s, 12.0) * 0.28) * day;
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(180, 32, 16), material);
  mesh.renderOrder = -1; mesh.frustumCulled = false;
  return { mesh, uniforms };
}

function makeStars() {
  const r = rng('stars'), positions = [];
  for (let i = 0; i < 700; i += 1) {
    const u = r() * TAU, v = 0.08 + r() * 0.92, radius = 170;
    const y = v, s = Math.sqrt(1 - y * y);
    positions.push(Math.cos(u) * s * radius, y * radius, Math.sin(u) * s * radius);
  }
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return new THREE.Points(geometry, new THREE.PointsMaterial({ color: '#ffffff', size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }));
}

// ---------------------------------------------------------------------------------------------
// static terrain
function makeTerrain() {
  const rings = 56, segments = 160, positions = [], colors = [], index = [], grassMask = [], snowMask = [];
  const grassA = new THREE.Color('#78a956'), grassB = new THREE.Color('#5d9147'), grassC = new THREE.Color('#9bbf62');
  const sand = new THREE.Color('#e3cf9a'), rock = new THREE.Color('#8b8a7a'), wet = new THREE.Color('#b8a47a');
  const color = new THREE.Color();
  positions.push(0, heightAt(0, 0), 0); color.copy(grassA); colors.push(color.r, color.g, color.b); grassMask.push(1); snowMask.push(1);
  for (let ring = 1; ring <= rings; ring += 1) {
    const t = ring / rings, d = Math.pow(t, 0.85) * 1.08;
    for (let s = 0; s < segments; s += 1) {
      const angle = (s / segments) * TAU, radius = coastRadius(angle) * d;
      const x = Math.cos(angle) * radius, z = Math.sin(angle) * radius * ISLAND_Z, y = heightAt(x, z);
      positions.push(x, y, z);
      const n = fbm(x * 0.35, z * 0.35);
      color.copy(grassB).lerp(grassA, n).lerp(grassC, Math.max(0, fbm(x * 0.12 + 9, z * 0.12) - 0.55) * 1.4);
      const rocky = y > 1.2 ? Math.min(1, (y - 1.2) * 0.8) : 0;
      if (rocky) color.lerp(rock, rocky);
      const coast = smooth(0.88, 0.95, d);
      if (coast > 0) color.lerp(sand, coast);
      if (y < WATER_LEVEL + 0.05) color.lerp(wet, 0.6);
      colors.push(color.r, color.g, color.b);
      // how much of this vertex is vegetation (seasonal tint) and how much can hold snow
      grassMask.push((1 - rocky) * (1 - coast));
      snowMask.push(y < WATER_LEVEL + 0.05 ? 0 : 1 - coast * 0.6);
    }
  }
  for (let s = 0; s < segments; s += 1) index.push(0, 1 + ((s + 1) % segments), 1 + s);
  for (let ring = 1; ring < rings; ring += 1) {
    const a = 1 + (ring - 1) * segments, b = 1 + ring * segments;
    for (let s = 0; s < segments; s += 1) {
      const s1 = (s + 1) % segments;
      index.push(a + s, a + s1, b + s, a + s1, b + s1, b + s);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(index); geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true }));
  mesh.receiveShadow = true;
  mesh.userData.baseColors = Float32Array.from(colors);
  mesh.userData.grassMask = Float32Array.from(grassMask);
  mesh.userData.snowMask = Float32Array.from(snowMask);
  return mesh;
}

// Seasonal / snow tint of the ground. `tint` = { autumn, winter, summer, snow } each 0..1.
const SEASON_GROUND = { autumn: new THREE.Color('#b39a4e'), winter: new THREE.Color('#8e9a82'), summer: new THREE.Color('#9fb752'), snow: new THREE.Color('#eef3f8') };
function tintTerrain(mesh, tint) {
  const { baseColors, grassMask, snowMask } = mesh.userData;
  const attribute = mesh.geometry.attributes.color, out = attribute.array, c = new THREE.Color();
  for (let i = 0, v = 0; i < out.length; i += 3, v += 1) {
    c.setRGB(baseColors[i], baseColors[i + 1], baseColors[i + 2]);
    const g = grassMask[v];
    if (tint.summer) c.lerp(SEASON_GROUND.summer, 0.16 * tint.summer * g);
    if (tint.autumn) c.lerp(SEASON_GROUND.autumn, 0.34 * tint.autumn * g);
    if (tint.winter) c.lerp(SEASON_GROUND.winter, 0.36 * tint.winter * g);
    if (tint.snow) c.lerp(SEASON_GROUND.snow, 0.88 * tint.snow * snowMask[v]);
    out[i] = c.r; out[i + 1] = c.g; out[i + 2] = c.b;
  }
  attribute.needsUpdate = true;
}

function makeWater() {
  const geometry = new THREE.PlaneGeometry(240, 240, 84, 84); geometry.rotateX(-Math.PI / 2);
  const base = geometry.attributes.position.array.slice();
  const colors = [], deep = new THREE.Color('#5d86a8'), shallow = new THREE.Color('#d8fff6'), color = new THREE.Color();
  for (let i = 0; i < base.length; i += 3) {
    const d = islandDistance(base[i], base[i + 2]);
    color.copy(deep).lerp(new THREE.Color('#ffffff'), smooth(2.2, 1.15, d) * 0.55).lerp(shallow, smooth(1.12, 0.98, d) * 0.8);
    colors.push(color.r, color.g, color.b);
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const material = new THREE.MeshStandardMaterial({ color: '#4fb0cf', vertexColors: true, roughness: 0.5, metalness: 0.02, flatShading: true });
  const mesh = new THREE.Mesh(geometry, material); mesh.position.y = WATER_LEVEL;
  return { mesh, material, base };
}

// merge every static mesh under `root` into one mesh per material (huge draw-call saving)
function mergeStatic(root) {
  root.updateMatrixWorld(true);
  const buckets = new Map(), keep = [], meshes = [];
  const walk = (object) => {
    for (const child of object.children) {
      if (child.userData.dynamic || child.isSprite || (child.isMesh && child.material.isMeshBasicMaterial)) keep.push(child);
      else { if (child.isMesh) meshes.push(child); walk(child); }
    }
  };
  walk(root);
  for (const object of meshes) {
    const bucket = buckets.get(object.material) || { cast: false, parts: [] };
    let geometry = object.geometry.index ? object.geometry.toNonIndexed() : object.geometry.clone();
    for (const name of Object.keys(geometry.attributes)) if (name !== 'position' && name !== 'normal') geometry.deleteAttribute(name);
    if (!geometry.attributes.normal) geometry.computeVertexNormals();
    geometry.applyMatrix4(object.matrixWorld);
    bucket.parts.push(geometry); bucket.cast ||= object.castShadow;
    buckets.set(object.material, bucket);
    object.geometry.dispose();
  }
  const output = new THREE.Group();
  for (const [material, bucket] of buckets) {
    let count = 0; for (const part of bucket.parts) count += part.attributes.position.count;
    const positions = new Float32Array(count * 3), normals = new Float32Array(count * 3);
    let offset = 0;
    for (const part of bucket.parts) {
      positions.set(part.attributes.position.array, offset); normals.set(part.attributes.normal.array, offset);
      offset += part.attributes.position.array.length; part.dispose();
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material); mesh.castShadow = bucket.cast; mesh.receiveShadow = true;
    output.add(mesh);
  }
  for (const object of keep) {
    const world = object.matrixWorld.clone();
    object.parent.remove(object);
    world.decompose(object.position, object.quaternion, object.scale);
    if (object.userData.smoke) Object.assign(object.userData.smoke, { x: object.position.x, y: object.position.y, z: object.position.z });
    output.add(object);
  }
  return output;
}

function blobTexture() {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
  const context = canvas.getContext('2d');
  const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(0,0,0,0.55)'); gradient.addColorStop(1, 'rgba(0,0,0,0)');
  context.fillStyle = gradient; context.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}
function glowTexture() {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
  const context = canvas.getContext('2d');
  const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255,220,150,1)'); gradient.addColorStop(0.35, 'rgba(255,190,110,0.35)'); gradient.addColorStop(1, 'rgba(255,170,90,0)');
  context.fillStyle = gradient; context.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; return texture;
}

function flakeTexture() {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32;
  const context = canvas.getContext('2d');
  const gradient = context.createRadialGradient(16, 16, 0, 16, 16, 16);
  gradient.addColorStop(0, 'rgba(255,255,255,1)'); gradient.addColorStop(0.45, 'rgba(255,255,255,0.8)'); gradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = gradient; context.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(canvas);
}

// ---- residents' cottages: local space, front (door) faces +z toward the plaza ---------------------
const COTTAGE_WALLS = ['#f3e6cf', '#e9d6c0', '#dfe7ef', '#f0dcd0', '#e4ecd8', '#f5ecd9'];
const COTTAGE_ROOFS = ['#b5523b', '#6f4f8f', '#3f6f8f', '#8a5a34', '#4f7f4a', '#a8433f'];
function buildCottage(b, seed, windowMaterial, groundDrop) {
  const r = rng(seed), h = hash(seed);
  const wall = COTTAGE_WALLS[h % COTTAGE_WALLS.length], roof = COTTAGE_ROOFS[(h >>> 5) % COTTAGE_ROOFS.length];
  b.box(1.5, 0.14 + groundDrop, 1.25, '#a59a86', 0, -groundDrop, -0.05, { cast: false });
  b.box(1.2, 0.78, 0.95, wall, 0, 0.14, -0.1);
  b.gable(1.42, 0.6, 1.15, roof, 0, 0.92, -0.1);
  b.box(0.16, 0.42, 0.16, '#8a7a6a', 0.34, 1.1, -0.35);
  b.door(-0.22, 0.14, 0.38, '#6b4a32', 0.24, 0.42);
  b.box(0.26, 0.22, 0.04, windowMaterial, 0.28, 0.42, 0.38, { cast: false });
  b.box(0.04, 0.22, 0.26, windowMaterial, 0.61, 0.42, -0.1, { cast: false });
  b.box(0.04, 0.22, 0.26, windowMaterial, -0.61, 0.42, -0.1, { cast: false });
  b.box(0.32, 0.04, 0.08, '#efe7d6', 0.28, 0.38, 0.42, { cast: false });
  // little front garden: picket posts, a flower box and a bench
  for (let i = 0; i < 5; i += 1) b.box(0.04, 0.2, 0.04, '#f2ead9', -0.7 + i * 0.35, 0.1, 0.72, { cast: false });
  b.box(1.45, 0.03, 0.03, '#f2ead9', 0, 0.22, 0.72, { cast: false });
  b.box(0.3, 0.06, 0.08, '#7f5a3b', 0.28, 0.32, 0.44, { cast: false });
  for (let i = 0; i < 3; i += 1) b.sphere(0.04, ['#f2a1c1', '#f5d34f', '#ff8a5c'][Math.floor(r() * 3)], 0.19 + i * 0.09, 0.38, 0.44, { cast: false });
  return { chimney: [0.34, 1.6, -0.35] };
}

// ---- weather particles ---------------------------------------------------------------------------
const RAIN_MAX = 2600, SNOW_MAX = 1800;
const PRECIP_BOX = { x: 26, z: 22, top: 15 };
function makeRain() {
  const positions = new Float32Array(RAIN_MAX * 6), seeds = new Float32Array(RAIN_MAX * 3), r = rng('rain');
  for (let i = 0; i < RAIN_MAX; i += 1) { seeds[i * 3] = (r() * 2 - 1) * PRECIP_BOX.x; seeds[i * 3 + 1] = r() * PRECIP_BOX.top; seeds[i * 3 + 2] = (r() * 2 - 1) * PRECIP_BOX.z; }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setDrawRange(0, 0);
  const material = new THREE.LineBasicMaterial({ color: '#c9d6e6', transparent: true, opacity: 0.5, depthWrite: false, fog: true });
  const mesh = new THREE.LineSegments(geometry, material); mesh.frustumCulled = false; mesh.renderOrder = 3;
  return { mesh, positions, seeds, material };
}
function makeSnow(texture) {
  const positions = new Float32Array(SNOW_MAX * 3), seeds = new Float32Array(SNOW_MAX * 4), r = rng('snow');
  for (let i = 0; i < SNOW_MAX; i += 1) { seeds[i * 4] = (r() * 2 - 1) * PRECIP_BOX.x; seeds[i * 4 + 1] = r() * PRECIP_BOX.top; seeds[i * 4 + 2] = (r() * 2 - 1) * PRECIP_BOX.z; seeds[i * 4 + 3] = r() * TAU; }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setDrawRange(0, 0);
  const material = new THREE.PointsMaterial({ color: '#ffffff', map: texture, size: 0.17, sizeAttenuation: true, transparent: true, opacity: 0.95, depthWrite: false, alphaTest: 0.02 });
  const mesh = new THREE.Points(geometry, material); mesh.frustumCulled = false; mesh.renderOrder = 3;
  return { mesh, positions, seeds, material };
}

// Visual targets for each sim weather condition (all 0..1). Unknown conditions fall back to clear.
const WEATHER_LOOK = {
  clear: { cloud: 0.2, overcast: 0, rain: 0, snow: 0, storm: 0, fog: 0, heat: 0 },
  cloudy: { cloud: 0.85, overcast: 0.45, rain: 0, snow: 0, storm: 0, fog: 0.08, heat: 0 },
  fog: { cloud: 0.45, overcast: 0.4, rain: 0, snow: 0, storm: 0, fog: 1, heat: 0 },
  rain: { cloud: 1, overcast: 0.62, rain: 0.7, snow: 0, storm: 0, fog: 0.25, heat: 0 },
  storm: { cloud: 1, overcast: 0.9, rain: 1, snow: 0, storm: 1, fog: 0.35, heat: 0 },
  snow: { cloud: 0.95, overcast: 0.5, rain: 0, snow: 0.8, storm: 0, fog: 0.3, heat: 0 },
  heatwave: { cloud: 0, overcast: 0, rain: 0, snow: 0, storm: 0, fog: 0, heat: 1 }
};
const WEATHER_ICON = { clear: '☀', cloudy: '☁', fog: '≋', rain: '☂', storm: '⚡', snow: '❄', heatwave: '♨' };
const SEASON_LABEL = { spring: ['SPRING', '春'], summer: ['SUMMER', '夏'], autumn: ['AUTUMN', '秋'], winter: ['WINTER', '冬'] };
const WEEKDAY_ZH = { Monday: '周一', Tuesday: '周二', Wednesday: '周三', Thursday: '周四', Friday: '周五', Saturday: '周六', Sunday: '周日' };
const CLOSED_REASON = { storm: '风暴关闭', closed_hours: '已打烊', inactive: '停用', unknown: '关闭' };
const VARIANT_LABEL = { sleep: '睡觉', home_rest: '在家休息', home_meal: '在家做饭', cafe_meal: '咖啡馆用餐', picnic: '野餐', snack: '小吃',
  meal: '用餐', garden_stroll: '花园散步', garden_rest: '花园小憩', stargazing: '观星', observatory_study: '观测学习', library_study: '图书馆学习',
  gathering: '周末聚会', coffee_chat: '咖啡闲聊', chat: '聊天', night_shift: '夜班', data_shift: '数据值班', workshop_shift: '工坊轮班' };
const isHome = (location) => typeof location === 'string' && location.startsWith('home:');

// ---------------------------------------------------------------------------------------------
export function createWorld3D(canvas, labelsElement, onSelect) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  } catch { return null; }
  if (!renderer?.getContext()) return null;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const materials = makeMaterials();
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog('#cfe6f6', 55, 165);
  const camera = new THREE.PerspectiveCamera(36, 1, 0.5, 420);
  const sky = makeSky(); scene.add(sky.mesh);
  const stars = makeStars(); scene.add(stars);
  const hemi = new THREE.HemisphereLight('#dfefff', '#5b6b3a', 1.1); scene.add(hemi);
  const sun = new THREE.DirectionalLight('#fff4e2', 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -24, right: 24, top: 24, bottom: -24, near: 1, far: 140 });
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03; sun.shadow.radius = 3;
  scene.add(sun, sun.target);
  const terrain = makeTerrain(); scene.add(terrain);
  const water = makeWater(); scene.add(water.mesh);
  const blobMap = blobTexture(), glowMap = glowTexture();
  const blobMaterial = new THREE.MeshBasicMaterial({ map: blobMap, transparent: true, depthWrite: false, toneMapped: false });
  const blobGeometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

  // ticker board texture for the central exchange
  const boardCanvas = document.createElement('canvas'); boardCanvas.width = 256; boardCanvas.height = 96;
  const boardTexture = new THREE.CanvasTexture(boardCanvas); boardTexture.colorSpace = THREE.SRGBColorSpace;
  const priceHistory = [];
  function drawBoard(price) {
    const context = boardCanvas.getContext('2d');
    context.fillStyle = '#071816'; context.fillRect(0, 0, 256, 96);
    context.fillStyle = '#7ff0cf'; context.font = 'bold 15px monospace'; context.fillText('SYNTERRA EXCHANGE', 12, 22);
    context.fillStyle = '#f2f5df'; context.font = 'bold 20px monospace';
    context.fillText(price ? `ETH $${Number(price).toLocaleString('en-US', { maximumFractionDigits: 0 })}` : 'SIM MARKET', 12, 50);
    const series = priceHistory.length > 1 ? priceHistory : [1, 1.02, 0.99, 1.04, 1.01, 1.06, 1.03, 1.08];
    const min = Math.min(...series), max = Math.max(...series), span = max - min || 1;
    context.strokeStyle = '#c9f36a'; context.lineWidth = 2.5; context.beginPath();
    series.forEach((value, i) => { const x = 12 + (i / (series.length - 1)) * 232, y = 86 - ((value - min) / span) * 26; i ? context.lineTo(x, y) : context.moveTo(x, y); });
    context.stroke(); boardTexture.needsUpdate = true;
  }
  drawBoard(null);

  // ---- state ------------------------------------------------------------------------------------
  const view = { yaw: -0.55, pitch: 0.7, distance: 33, target: new THREE.Vector3(0, 0.4, 0) };
  const goal = { yaw: view.yaw, pitch: view.pitch, distance: view.distance, target: view.target.clone() };
  let data = null, selectedId = null, frame = 0, disposed = false, lastDrawAt = 0;
  let townGroup = null, townSignature = '', townFrames = [], dynamicParts = [], lampLights = [], glowSprites = [];
  const figures = new Map();
  const pointers = new Map();
  let drag = null, pinchDistance = 0;
  let inViewport = typeof IntersectionObserver !== 'function';
  const labelNodes = new Map();
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const clock = { minutes: 10 * 60, sampleMinutes: null, sampleAt: 0, rate: 0, display: null };
  const raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2(), projected = new THREE.Vector3();
  let projectedResidents = [];
  const clouds = new THREE.Group(); scene.add(clouds);
  const cloudMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, flatShading: true, transparent: true, opacity: 0.92 });
  {
    const r = rng('clouds');
    for (let i = 0; i < 18; i += 1) {
      const cloud = new THREE.Group();
      for (let k = 0; k < 4; k += 1) {
        const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(1 + r() * 0.9, 0), cloudMat);
        puff.position.set(k * 1.3 - 2, r() * 0.5, (r() - 0.5) * 1.2); puff.scale.y = 0.6; cloud.add(puff);
      }
      // the first 7 are the fair-weather clouds; the rest only appear as cover grows. All stay outside the
      // town ring (or high above it) so they never sit between the camera and the residents.
      cloud.userData.angle = r() * TAU; cloud.userData.radius = 21 + r() * 26; cloud.userData.speed = 0.004 + r() * 0.006;
      cloud.userData.baseY = i < 7 ? 11 + r() * 5 : 13 + r() * 6; cloud.position.y = cloud.userData.baseY; cloud.visible = i < 7; clouds.add(cloud);
    }
  }
  // ---- weather state ------------------------------------------------------------------------------
  const rain = makeRain(), snow = makeSnow(flakeTexture());
  scene.add(rain.mesh, snow.mesh);
  const lightning = new THREE.AmbientLight('#dfe8ff', 0); scene.add(lightning);
  const weatherNow = { cloud: 0.2, overcast: 0, rain: 0, snow: 0, storm: 0, fog: 0, heat: 0, wind: 10, windAngle: 0.7, flash: 0, nextFlash: 0, initialised: false };
  const groundTint = { autumn: 0, winter: 0, summer: 0, snow: 0 }, groundTarget = { autumn: 0, winter: 0, summer: 0, snow: 0 };
  let groundApplied = null, natureTrees = null;
  const homeWindowMats = new Map(), placeWindowMats = [], placeGlows = [];
  let homeSlots = [], homeById = new Map();
  const hud = document.createElement('div'); hud.className = 'world3d-hud'; hud.hidden = true; hud.setAttribute('aria-live', 'off');
  (labelsElement.parentElement || labelsElement).append(hud);
  let hudSignature = '';

  // ---- layout ------------------------------------------------------------------------------------
  function placeCenters(scenes) {
    const points = scenes.map((scene, index) => {
      const x = Number(scene.position?.x), z = Number(scene.position?.z);
      let angle, radius;
      if (Number.isFinite(x) && Number.isFinite(z) && Math.hypot(x, z) >= 0.2) {
        angle = Math.atan2(z, x); radius = 7.3 + Math.min(4.2, Math.hypot(x, z) * 4.6);
      } else {
        angle = -Math.PI / 2 + (index / Math.max(scenes.length, 1)) * TAU; radius = scenes.length <= 1 ? 7.5 : 8.6;
      }
      return [Math.cos(angle) * radius, Math.sin(angle) * radius * 0.82];
    });
    // relax overlapping places apart while keeping them in the flat town ring
    for (let iteration = 0; iteration < 40; iteration += 1) {
      for (let i = 0; i < points.length; i += 1) for (let j = i + 1; j < points.length; j += 1) {
        const dx = points[j][0] - points[i][0], dz = points[j][1] - points[i][1], d = Math.hypot(dx, dz) || 0.01;
        if (d < 4.4) { const push = (4.4 - d) / 2, ux = dx / d, uz = dz / d; points[i][0] -= ux * push; points[i][1] -= uz * push; points[j][0] += ux * push; points[j][1] += uz * push; }
      }
      for (const point of points) {
        const radius = Math.hypot(point[0], point[1] / 0.82) || 1, clamped = Math.max(7, Math.min(12.2, radius));
        point[0] *= clamped / radius; point[1] *= clamped / radius;
      }
    }
    return points;
  }

  function placeFrame(center) {
    const length = Math.hypot(center[0], center[1]) || 1;
    const u = [center[0] / length, center[1] / length];
    return { center, u, p: [-u[1], u[0]], front: [center[0] - u[0] * 2.25, center[1] - u[1] * 2.25], angle: Math.atan2(u[1], u[0]) };
  }

  // Residents' homes live in an outer residential ring. The sim's home position only supplies the
  // preferred direction (its radius ~1.1 is "edge of town"); each cottage is nudged to the nearest
  // free slot that is on land, clear of places / spoke roads / other cottages, and whose straight
  // footpath back to the plaza does not cut through a place.
  function computeHomeSlots(residents, frames) {
    const segment = (px, pz, ax, az, bx, bz) => {
      const dx = bx - ax, dz = bz - az, t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz || 1)));
      return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
    };
    const wanted = residents.filter((resident) => resident?.home && typeof resident.home === 'object').map((resident) => {
      const x = Number(resident.home?.position?.x), z = Number(resident.home?.position?.z);
      const desired = Number.isFinite(x) && Number.isFinite(z) && Math.hypot(x, z) > 0.05 ? Math.atan2(z, x) : (hash(`home:${resident.id}`) % 3600) / 3600 * TAU;
      return { id: resident.id, location: typeof resident.home.location === 'string' && isHome(resident.home.location) ? resident.home.location : `home:${resident.id}`, desired };
    }).sort((a, b) => a.desired - b.desired || (a.id < b.id ? -1 : 1));
    const slots = [];
    const valid = (x, z, ux, uz) => {
      if (islandDistance(x, z) > 0.86 || heightAt(x, z) > 1.6) return false;
      const sx = ux * PLAZA_RADIUS, sz = uz * PLAZA_RADIUS, fx = x - ux * 1.25, fz = z - uz * 1.25;
      for (const frame of frames) {
        if (Math.hypot(x - frame.center[0], z - frame.center[1]) < 3.2) return false;
        if (segment(x, z, frame.u[0] * PLAZA_RADIUS, frame.u[1] * PLAZA_RADIUS, frame.front[0], frame.front[1]) < 1.5) return false;
        if (segment(frame.center[0], frame.center[1], sx, sz, fx, fz) < 2.5) return false;
        if (segment(frame.front[0], frame.front[1], sx, sz, fx, fz) < 1.2) return false;
      }
      for (const slot of slots) {
        if (Math.hypot(x - slot.center[0], z - slot.center[1]) < 2.0) return false;
        if (segment(x, z, slot.pathStart[0], slot.pathStart[1], slot.front[0], slot.front[1]) < 1.15) return false;
        if (segment(slot.center[0], slot.center[1], sx, sz, fx, fz) < 1.15) return false;
      }
      return true;
    };
    for (const item of wanted) {
      let found = null;
      for (const ring of [13.6, 15.3, 16.8]) {
        for (let k = 0; k < 160 && !found; k += 1) {
          const angle = item.desired + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.02;
          const x = Math.cos(angle) * ring, z = Math.sin(angle) * ring * 0.82, length = Math.hypot(x, z), ux = x / length, uz = z / length;
          if (valid(x, z, ux, uz)) found = { x, z, ux, uz };
        }
        if (found) break;
      }
      if (!found) continue; // no room: the resident is drawn at the fallback spot instead of a cottage
      const { x, z, ux, uz } = found;
      slots.push({ id: item.id, location: item.location, center: [x, z], u: [ux, uz], p: [-uz, ux],
        front: [x - ux * 1.25, z - uz * 1.25], pathStart: [ux * (PLAZA_RADIUS - 0.15), uz * (PLAZA_RADIUS - 0.15)],
        angle: Math.atan2(uz, ux), y: heightAt(x, z) });
    }
    return slots;
  }

  function layout(now) {
    const scenes = data?.scenes || [], residents = data?.residents || [];
    const frames = townFrames;
    const centers = frames.map((frame) => frame.center);
    const sceneByName = new Map(scenes.map((scene, index) => [scene.name, index]));
    const groups = new Map(), destinationGroups = new Map();
    for (const resident of residents) {
      const bucket = groups.get(resident.location) || []; bucket.push(resident); groups.set(resident.location, bucket);
      if (resident.currentStatus === 'walking' && resident.targetLocation) {
        const target = destinationGroups.get(resident.targetLocation) || []; target.push(resident); destinationGroups.set(resident.targetLocation, target);
      }
    }
    for (const resident of residents) {
      if (resident.currentStatus === 'walking' || groups.has(resident.location) === false) continue;
      const target = destinationGroups.get(resident.location) || []; target.push(resident); destinationGroups.set(resident.location, target);
    }
    const frameFor = (place) => { const index = sceneByName.get(place); return index === undefined ? (homeById.get(place) || null) : frames[index]; };
    const spotFor = (resident, place, buckets, fallbackOrder) => {
      const members = buckets.get(place) || [resident];
      const order = Math.max(0, members.findIndex((item) => item.id === resident.id)), total = members.length;
      const frame = frameFor(place);
      if (!frame) {
        const angle = place === 'Exchange' ? (order / Math.max(total, 1)) * TAU + 0.4 : fallbackOrder * 2.4;
        const radius = place === 'Exchange' ? 2.45 + (order % 2) * 0.35 : 3.0;
        return { pos: [Math.cos(angle) * radius, Math.sin(angle) * radius], face: Math.atan2(Math.cos(angle), Math.sin(angle)), frame: null, angle };
      }
      const perRow = 5, row = Math.floor(order / perRow), inRow = Math.min(perRow, total - row * perRow), col = order % perRow;
      const lateral = (col - (inRow - 1) / 2) * 0.62, back = row * 0.6;
      const pos = [frame.front[0] + frame.p[0] * lateral - frame.u[0] * back, frame.front[1] + frame.p[1] * lateral - frame.u[1] * back];
      const gather = [frame.front[0] - frame.u[0] * 0.5, frame.front[1] - frame.u[1] * 0.5];
      return { pos, face: Math.atan2(gather[0] - pos[0] + frame.u[0] * 0.8, gather[1] - pos[1] + frame.u[1] * 0.8), frame, angle: frame.angle };
    };
    const routeBetween = (from, to) => {
      const points = [from.pos];
      if (from.frame) points.push([from.frame.center[0] - from.frame.u[0] * 2.9, from.frame.center[1] - from.frame.u[1] * 2.9]);
      if (from.frame || to.frame) {
        let a0 = from.angle, a1 = to.angle, delta = ((a1 - a0 + Math.PI * 3) % TAU) - Math.PI;
        const steps = Math.max(1, Math.ceil(Math.abs(delta) / 0.3));
        for (let i = 0; i <= steps; i += 1) { const a = a0 + delta * (i / steps); points.push([Math.cos(a) * PLAZA_RING, Math.sin(a) * PLAZA_RING]); }
      }
      if (to.frame) points.push([to.frame.center[0] - to.frame.u[0] * 2.9, to.frame.center[1] - to.frame.u[1] * 2.9]);
      points.push(to.pos);
      const lengths = [0];
      for (let i = 1; i < points.length; i += 1) lengths.push(lengths[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
      return { points, lengths, total: lengths.at(-1) || 1 };
    };
    const sample = (route, progress) => {
      const distance = route.total * progress;
      let i = 1; while (i < route.points.length - 1 && route.lengths[i] < distance) i += 1;
      const a = route.points[i - 1], b = route.points[i], span = route.lengths[i] - route.lengths[i - 1] || 1;
      const k = Math.max(0, Math.min(1, (distance - route.lengths[i - 1]) / span));
      return { pos: [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k], face: Math.atan2(b[0] - a[0], b[1] - a[1]) };
    };
    const placed = residents.map((resident, index) => {
      const from = spotFor(resident, resident.location, groups, index);
      if (resident.currentStatus !== 'walking' || !resident.targetLocation) return { resident, position: from.pos, facing: from.face, movement: null };
      const to = spotFor(resident, resident.targetLocation, destinationGroups, index);
      const started = Date.parse(resident.movementStartedAt || ''), ends = Date.parse(resident.movementEndsAt || '');
      const progress = !Number.isFinite(started) || !Number.isFinite(ends) || ends <= started ? 1 : Math.max(0, Math.min(1, (now - started) / (ends - started)));
      const eased = progress < 1 ? progress * progress * (3 - 2 * progress) * 0.35 + progress * 0.65 : 1;
      const point = sample(routeBetween(from, to), eased);
      return { resident, position: point.pos, facing: progress < 1 ? point.face : to.face, movement: { progress } };
    });
    return { centers, frames, placed };
  }

  // ---- town construction (rebuilt only when the set of places changes) ---------------------------
  function buildTown(scenes, frames, homes = []) {
    if (townGroup) {
      scene.remove(townGroup);
      townGroup.traverse((object) => { if (object.isMesh || object.isInstancedMesh) object.geometry?.dispose(); if (object.isSprite) object.material.dispose(); });
      for (const light of lampLights) scene.remove(light);
    }
    for (const material of [...placeWindowMats, ...homeWindowMats.values()]) material.dispose();
    dynamicParts = []; lampLights = []; glowSprites = []; placeWindowMats.length = 0; placeGlows.length = 0; homeWindowMats.clear();
    const glowAt = (x, y, z, size) => {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowMap, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
      sprite.position.set(x, y, z); sprite.scale.set(size, size, 1); sprite.userData.dynamic = true; return sprite;
    };
    const raw = new THREE.Group();
    const b = new Builder(raw, materials);
    // plaza
    b.cyl(PLAZA_RADIUS, PLAZA_RADIUS + 0.1, 0.06, 40, '#d9ccab', 0, -0.03, 0, { cast: false });
    b.add(new THREE.RingGeometry(PLAZA_RING - 0.35, PLAZA_RING + 0.35, 48).rotateX(-Math.PI / 2), '#cbbd98', 0, 0.035, 0, { cast: false });
    const exchange = new THREE.Group(); raw.add(exchange);
    buildExchange(new Builder(exchange, materials), boardTexture);
    // plaza lamps with real point lights
    for (let i = 0; i < 4; i += 1) {
      const a = (i / 4) * TAU + Math.PI / 4, x = Math.cos(a) * (PLAZA_RADIUS - 0.25), z = Math.sin(a) * (PLAZA_RADIUS - 0.25);
      lampPost(b, x, z);
      const light = new THREE.PointLight('#ffcf86', 0, 7, 1.6); light.position.set(x, 1.6, z); scene.add(light); lampLights.push(light);
    }
    // roads, places, lamps
    frames.forEach((frame, index) => {
      const type = scenes[index].sceneType;
      const start = [frame.u[0] * (PLAZA_RADIUS - 0.2), frame.u[1] * (PLAZA_RADIUS - 0.2)];
      const end = [frame.center[0] - frame.u[0] * 1.6, frame.center[1] - frame.u[1] * 1.6];
      const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
      if (length > 0.2) {
        const mx = (start[0] + end[0]) / 2, mz = (start[1] + end[1]) / 2, ry = -Math.atan2(end[1] - start[1], end[0] - start[0]);
        b.box(length, 0.03, 0.95, '#d6c49a', mx, 0, mz, { ry, cast: false });
        b.box(length, 0.025, 1.15, '#b7a47c', mx, -0.005, mz, { ry, cast: false });
        for (let s = 1.2; s < length - 0.6; s += 2.6) {
          const side = (Math.round(s) % 2 ? 1 : -1) * 0.85;
          lampPost(b, start[0] + frame.u[0] * s + frame.p[0] * side, start[1] + frame.u[1] * s + frame.p[1] * side);
        }
      }
      b.cyl(1.0, 1.0, 0.03, 16, '#d6c49a', frame.front[0], 0, frame.front[1], { cast: false });
      const place = new THREE.Group();
      place.position.set(frame.center[0], 0, frame.center[1]);
      place.rotation.y = Math.atan2(-frame.center[0], -frame.center[1]);
      raw.add(place);
      const windowMaterial = materials.window.clone(); placeWindowMats.push(windowMaterial);
      buildPlace(new Builder(place, { ...materials, window: windowMaterial }), type, scenes[index].name);
      const glow = glowAt(frame.front[0] + frame.u[0] * 0.6, 0.9, frame.front[1] + frame.u[1] * 0.6, 2.6); raw.add(glow); placeGlows.push(glow);
    });
    // residents' cottages, each with its own footpath back to the plaza
    for (const slot of homes) {
      const [x, z] = slot.center;
      const corners = [[0.8, 0.7], [-0.8, 0.7], [0.8, -0.7], [-0.8, -0.7]].map(([a, c]) => heightAt(x + slot.p[0] * a + slot.u[0] * c, z + slot.p[1] * a + slot.u[1] * c));
      const groundDrop = Math.max(0, slot.y - Math.min(...corners)) + 0.04;
      const cottage = new THREE.Group(); cottage.position.set(x, slot.y, z); cottage.rotation.y = Math.atan2(-x, -z); raw.add(cottage);
      const windowMaterial = materials.window.clone(); homeWindowMats.set(slot.id, windowMaterial);
      buildCottage(new Builder(cottage, { ...materials, window: windowMaterial }), slot.location, windowMaterial, groundDrop);
      const glow = glowAt(x - slot.u[0] * 0.75 + slot.p[0] * 0.28, slot.y + 0.55, z - slot.u[1] * 0.75 + slot.p[1] * 0.28, 1.3);
      glow.userData.homeId = slot.id; raw.add(glow);
      const [sx, sz] = slot.pathStart, [ex, ez] = [slot.front[0] + slot.u[0] * 0.55, slot.front[1] + slot.u[1] * 0.55];
      const length = Math.hypot(ex - sx, ez - sz), pieces = Math.max(1, Math.ceil(length / 1.1)), ry = -Math.atan2(ez - sz, ex - sx);
      for (let i = 0; i < pieces; i += 1) {
        const a = i / pieces, c = (i + 1) / pieces;
        const ax = sx + (ex - sx) * a, az = sz + (ez - sz) * a, cx = sx + (ex - sx) * c, cz = sz + (ez - sz) * c;
        const ha = Math.max(0, heightAt(ax, az)), hc = Math.max(0, heightAt(cx, cz)), span = length / pieces;
        b.box(span + 0.06, 0.03, 0.5, '#cdbb92', (ax + cx) / 2, (ha + hc) / 2 - 0.01, (az + cz) / 2, { ry, rz: Math.atan2(hc - ha, span), cast: false });
      }
    }
    // footpaths between neighbouring places
    const order = frames.map((frame, index) => [frame.angle, index]).sort((x, y) => x[0] - y[0]);
    for (let i = 0; i < order.length && order.length > 2; i += 1) {
      const a = frames[order[i][1]], c = frames[order[(i + 1) % order.length][1]];
      const s = [a.center[0] + a.p[0] * 1.9, a.center[1] + a.p[1] * 1.9], e = [c.center[0] - c.p[0] * 1.9, c.center[1] - c.p[1] * 1.9];
      const length = Math.hypot(e[0] - s[0], e[1] - s[1]);
      if (length > 0.5 && length < 9) b.box(length, 0.02, 0.45, '#cdbb92', (s[0] + e[0]) / 2, 0, (s[1] + e[1]) / 2, { ry: -Math.atan2(e[1] - s[1], e[0] - s[0]), cast: false });
    }
    const merged = mergeStatic(raw);
    merged.traverse((object) => {
      if (object.userData.dynamic) dynamicParts.push(object);
      if (object.userData.glow) glowSprites.push(object);
      if (object.userData.homeId) homeWindowMats.get(object.userData.homeId).userData.glow = object;
    });
    // soft contact shadows under buildings (fake ambient occlusion)
    for (const frame of frames) {
      const blob = new THREE.Mesh(blobGeometry, blobMaterial); blob.scale.set(5.2, 1, 5.2); blob.position.set(frame.center[0], 0.045, frame.center[1]); blob.renderOrder = 1; merged.add(blob);
    }
    const hub = new THREE.Mesh(blobGeometry, blobMaterial); hub.scale.set(5, 1, 5); hub.position.y = 0.05; hub.renderOrder = 1; merged.add(hub);
    for (const slot of homes) {
      const blob = new THREE.Mesh(blobGeometry, blobMaterial); blob.scale.set(2.6, 1, 2.6); blob.position.set(slot.center[0], slot.y + 0.05, slot.center[1]); blob.renderOrder = 1; merged.add(blob);
    }
    merged.add(scatterNature(frames, homes));
    townGroup = merged; scene.add(townGroup);
    groundApplied = null; // re-apply seasonal colours to the fresh tree instances
  }

  function lampPost(b, x, z) {
    b.cyl(0.03, 0.045, 1.15, 6, '#34463d', x, 0, z);
    b.box(0.15, 0.05, 0.15, '#34463d', x, 1.15, z);
    b.sphere(0.09, materials.lamp, x, 1.3, z, { cast: false });
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowMap, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
    sprite.position.set(x, 1.3, z); sprite.scale.set(1.3, 1.3, 1); sprite.userData.dynamic = true; sprite.userData.glow = true;
    b.group.add(sprite);
  }

  function scatterNature(frames, homes = []) {
    const group = new THREE.Group(), r = rng('synterra-nature');
    const blocked = (x, z, clearance) => {
      if (Math.hypot(x, z) < PLAZA_RADIUS + 1.2 + clearance) return true;
      for (const slot of homes) {
        if (Math.hypot(x - slot.center[0], z - slot.center[1]) < 1.5 + clearance) return true;
        const [ax, az] = slot.pathStart, [bx, bz] = slot.front;
        const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / ((bx - ax) ** 2 + (bz - az) ** 2 || 1)));
        if (Math.hypot(x - (ax + (bx - ax) * t), z - (az + (bz - az) * t)) < 0.45 + clearance) return true;
      }
      for (const frame of frames) {
        if (Math.hypot(x - frame.center[0], z - frame.center[1]) < 2.4 + clearance) return true;
        if (Math.hypot(x - frame.front[0], z - frame.front[1]) < 1.5 + clearance) return true;
        // distance to the spoke road
        const ax = frame.u[0] * PLAZA_RADIUS, az = frame.u[1] * PLAZA_RADIUS, bx = frame.front[0], bz = frame.front[1];
        const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / ((bx - ax) ** 2 + (bz - az) ** 2 || 1)));
        if (Math.hypot(x - (ax + (bx - ax) * t), z - (az + (bz - az) * t)) < 1.0 + clearance) return true;
      }
      return false;
    };
    const trees = [];
    for (let attempt = 0; attempt < 1600 && trees.length < 135; attempt += 1) {
      const angle = r() * TAU, d = Math.sqrt(r()) * 0.93;
      const x = Math.cos(angle) * coastRadius(angle) * d, z = Math.sin(angle) * coastRadius(angle) * d * ISLAND_Z;
      const density = d < FLAT_ZONE ? 0.07 : 0.9;
      if (r() > density || blocked(x, z, 0.6) || heightAt(x, z) < WATER_LEVEL + 0.25 || islandDistance(x, z) > 0.9) continue;
      if (trees.some((tree) => Math.hypot(tree.x - x, tree.z - z) < 0.9)) continue;
      trees.push({ x, z, y: heightAt(x, z), s: 0.75 + r() * 0.65, pine: r() < (d > 0.8 ? 0.65 : 0.35), hue: r() });
    }
    const dummy = new THREE.Object3D(), color = new THREE.Color();
    const pines = trees.filter((tree) => tree.pine), rounds = trees.filter((tree) => !tree.pine);
    const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.07, 0.11, 0.7, 6).translate(0, 0.35, 0), materials.std('#7a5233'), trees.length);
    trees.forEach((tree, i) => { dummy.position.set(tree.x, tree.y, tree.z); dummy.scale.setScalar(tree.s); dummy.rotation.set(0, 0, 0); dummy.updateMatrix(); trunk.setMatrixAt(i, dummy.matrix); });
    const pineGeo = new THREE.ConeGeometry(0.55, 1.5, 7).translate(0, 1.3, 0);
    const pine = new THREE.InstancedMesh(pineGeo, materials.std('#ffffff'), pines.length * 2);
    pines.forEach((tree, i) => {
      for (let k = 0; k < 2; k += 1) {
        dummy.position.set(tree.x, tree.y + k * 0.55 * tree.s, tree.z); dummy.scale.setScalar(tree.s * (1 - k * 0.3)); dummy.rotation.y = tree.hue * 3; dummy.updateMatrix();
        pine.setMatrixAt(i * 2 + k, dummy.matrix);
        pine.setColorAt(i * 2 + k, color.setHSL(0.33 + tree.hue * 0.06, 0.42, 0.28 + k * 0.06));
      }
    });
    const roundGeo = new THREE.IcosahedronGeometry(0.62, 0).translate(0, 1.15, 0);
    const round = new THREE.InstancedMesh(roundGeo, materials.std('#ffffff'), rounds.length);
    rounds.forEach((tree, i) => {
      dummy.position.set(tree.x, tree.y, tree.z); dummy.scale.set(tree.s, tree.s * 1.05, tree.s); dummy.rotation.y = tree.hue * 5; dummy.updateMatrix();
      round.setMatrixAt(i, dummy.matrix);
      const autumn = tree.hue > 0.93;
      round.setColorAt(i, autumn ? color.setHSL(0.08 + tree.hue * 0.04, 0.62, 0.5) : color.setHSL(0.27 + tree.hue * 0.08, 0.45, 0.36 + tree.hue * 0.07));
    });
    for (const mesh of [trunk, pine, round]) { mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh); }
    const baseOf = (mesh) => mesh.instanceColor ? Float32Array.from(mesh.instanceColor.array) : null;
    natureTrees = { pine, round, pineBase: baseOf(pine), roundBase: baseOf(round), roundHue: rounds.map((tree) => tree.hue), flowers: null };
    // rocks, bushes and flowers
    const smalls = [];
    for (let attempt = 0; attempt < 1400 && smalls.length < 420; attempt += 1) {
      const angle = r() * TAU, d = Math.sqrt(r()) * 0.97;
      const x = Math.cos(angle) * coastRadius(angle) * d, z = Math.sin(angle) * coastRadius(angle) * d * ISLAND_Z;
      if (blocked(x, z, -0.2)) continue;
      const kind = d > 0.88 ? 'rock' : r() < 0.55 ? 'flower' : r() < 0.6 ? 'bush' : 'rock';
      smalls.push({ x, z, y: heightAt(x, z), kind, s: 0.6 + r() * 0.8, hue: r() });
    }
    const make = (geometry, list, colorFor, cast) => {
      const mesh = new THREE.InstancedMesh(geometry, materials.std('#ffffff'), Math.max(1, list.length));
      mesh.count = list.length;
      list.forEach((item, i) => {
        dummy.position.set(item.x, item.y, item.z); dummy.scale.setScalar(item.s); dummy.rotation.set(item.hue, item.hue * 7, 0); dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix); mesh.setColorAt(i, colorFor(item));
      });
      mesh.castShadow = cast; mesh.receiveShadow = true; group.add(mesh);
      return mesh;
    };
    make(new THREE.DodecahedronGeometry(0.22, 0), smalls.filter((s) => s.kind === 'rock'), (s) => color.setHSL(0.1, 0.06, 0.45 + s.hue * 0.15), true);
    make(new THREE.IcosahedronGeometry(0.25, 0).translate(0, 0.15, 0), smalls.filter((s) => s.kind === 'bush'), (s) => color.setHSL(0.28 + s.hue * 0.06, 0.45, 0.33), true);
    natureTrees.flowers = make(new THREE.IcosahedronGeometry(0.06, 0).translate(0, 0.08, 0), smalls.filter((s) => s.kind === 'flower'),
      (s) => color.set(['#f2a1c1', '#f5d34f', '#ffffff', '#c58df0', '#ff8a5c'][Math.floor(s.hue * 5)]), false);
    return group;
  }

  // ---- residents -------------------------------------------------------------------------------
  const residentLayer = new THREE.Group(); scene.add(residentLayer);
  function syncFigures(residents) {
    const wanted = new Set();
    for (const resident of residents) {
      wanted.add(resident.id);
      const key = `${resident.archetype || ''}|${resident.gender || ''}`;
      const existing = figures.get(resident.id);
      if (existing && existing.key === key) continue;
      if (existing) residentLayer.remove(existing.root);
      const figure = buildResidentFigure(resident, materials); figure.key = key;
      const blob = new THREE.Mesh(blobGeometry, blobMaterial); blob.scale.set(0.9, 1, 0.9); blob.position.y = 0.06; blob.renderOrder = 1; figure.root.add(blob);
      figures.set(resident.id, figure); residentLayer.add(figure.root);
    }
    for (const [id, figure] of figures) if (!wanted.has(id)) {
      residentLayer.remove(figure.root);
      figure.root.traverse((object) => { if (object.isMesh && object.geometry !== blobGeometry) object.geometry.dispose(); });
      figures.delete(id);
    }
  }

  function activityFor(resident, now) {
    if (resident.currentStatus === 'walking') {
      const target = resident.targetLocationLabel || resident.targetLocation;
      const shortTarget = isHome(resident.targetLocation) ? '家' : String(target || '目标地点').replace(/^.+?'s\s+/, '');
      return { label: `前往 ${shortTarget}`, kind: 'travel' };
    }
    if (resident.asleep) return { label: '睡觉', kind: 'care' };
    if (resident.currentStatus === 'performing' && VARIANT_LABEL[resident.activityVariant]) {
      const kinds = { rest: 'care', eat: 'care', learn: 'learn', socialize: 'socialize', work: 'work', cooperate: 'work', trade: 'trade' };
      return { label: VARIANT_LABEL[resident.activityVariant], kind: kinds[resident.currentAction] || 'care' };
    }
    if (resident.currentStatus === 'performing') {
      const actions = { work: ['工作', 'work'], learn: ['学习', 'learn'], rest: ['休息', 'care'],
        eat: ['进食', 'care'], socialize: ['社交', 'socialize'], trade: ['交易', 'trade'] };
      const [label, kind] = actions[resident.currentAction] || ['行动中', 'work'];
      return { label, kind };
    }
    const trade = (data?.trading?.recentTrades || []).find((item) => item.agentName === resident.name &&
      Number.isFinite(Date.parse(item.createdAt)) && now - Date.parse(item.createdAt) >= 0 && now - Date.parse(item.createdAt) < 90_000);
    if (trade) return { label: trade.side === 'buy' ? '买入' : '卖出', kind: 'trade' };
    const age = resident.lastEventAt ? now - Date.parse(resident.lastEventAt) : Infinity;
    if (age < 90_000) {
      const actions = { 'action.travel': ['移动', 'travel'], 'action.work': ['工作', 'work'],
        'action.socialize': ['社交', 'socialize'], 'action.eat': ['进食', 'care'], 'action.rest': ['休息', 'care'],
        'action.build_scene': ['建造', 'build'] };
      const [label, kind] = actions[resident.lastEventType] || [];
      if (label) return { label, kind };
    }
    return null;
  }

  // ---- DOM labels (same structure / classes as before) ------------------------------------------
  function ensureLabels(scenes, residents) {
    const wanted = new Set(['market']);
    if (!labelNodes.has('market')) {
      const node = document.createElement('div');
      node.className = 'world3d-market-label';
      node.setAttribute('aria-label', 'Synterra 模拟交易大厅行情');
      const title = document.createElement('strong'); title.className = 'world3d-market-title';
      const line = document.createElement('span'); line.className = 'world3d-market-ticker';
      const footer = document.createElement('span'); footer.className = 'world3d-market-status';
      node.append(title, line, footer);
      labelsElement.append(node); labelNodes.set('market', node);
    }
    for (const sceneItem of scenes) {
      const key = `scene:${sceneItem.name}`; wanted.add(key);
      if (!labelNodes.has(key)) {
        const node = document.createElement('span'); node.className = 'world3d-scene-label';
        node.textContent = sceneItem.name.replace(/^.+?'s\s+/, '');
        node.title = sceneItem.name; node.setAttribute('aria-label', `场景 ${sceneItem.name}`);
        labelsElement.append(node); labelNodes.set(key, node);
      }
      const node = labelNodes.get(key);
      node.dataset.type = sceneItem.sceneType || 'commons';
      const closed = sceneItem.openNow === false;
      node.classList.toggle('is-closed', closed);
      const shortName = sceneItem.name.replace(/^.+?'s\s+/, '');
      node.textContent = closed ? `${shortName} · ${CLOSED_REASON[sceneItem.closedReason] || '关闭'}` : shortName;
      const hours = sceneItem.opensAt && closed ? ` · ${sceneItem.opensAt} 开门` : sceneItem.closesAt && !closed ? ` · 营业至 ${sceneItem.closesAt}` : '';
      node.title = `${sceneItem.name}${closed ? ` · ${CLOSED_REASON[sceneItem.closedReason] || '关闭'}` : ''}${hours}`;
      node.style.setProperty('--place-color', (TYPE_STYLE[sceneItem.sceneType] || TYPE_STYLE.commons).label);
    }
    for (const resident of residents) {
      const key = `resident:${resident.id}`; wanted.add(key);
      if (!labelNodes.has(key)) {
        const node = document.createElement('button'); node.type = 'button'; node.className = 'world3d-agent-label';
        const initials = document.createElement('span'); initials.className = 'world3d-agent-initials';
        const action = document.createElement('span'); action.className = 'world3d-agent-action';
        node.append(initials, action);
        node.addEventListener('click', () => onSelect(node.dataset.residentId));
        labelNodes.set(key, node); labelsElement.append(node);
      }
      const node = labelNodes.get(key); node.dataset.residentId = resident.id;
      const figure = figures.get(resident.id);
      if (figure) node.style.setProperty('--agent-color', figure.color);
      node.querySelector('.world3d-agent-initials').textContent = resident.name.split(/[-\s]/).filter(Boolean).at(-1)?.slice(-2) || '•';
      const activity = activityFor(resident, Date.now());
      const actionNode = node.querySelector('.world3d-agent-action');
      actionNode.textContent = activity?.label || '';
      actionNode.dataset.kind = activity?.kind || 'idle';
      actionNode.hidden = !activity;
      node.title = activity ? `${resident.name} · ${activity.label}` : resident.name;
      node.setAttribute('aria-label', activity ? `查看 ${resident.name}，${activity.label}` : `查看 ${resident.name}`);
      node.classList.toggle('is-selected', resident.id === selectedId);
    }
    for (const slot of homeSlots) {
      const key = `home:${slot.id}`; wanted.add(key);
      if (!labelNodes.has(key)) {
        const node = document.createElement('button'); node.type = 'button'; node.className = 'world3d-home-label';
        node.textContent = 'Zz'; node.hidden = true;
        node.addEventListener('click', () => onSelect(node.dataset.residentId));
        labelNodes.set(key, node); labelsElement.append(node);
      }
      const owner = residents.find((resident) => resident.id === slot.id);
      const node = labelNodes.get(key); node.dataset.residentId = slot.id;
      const label = owner?.home?.label || `${owner?.name || ''} home`;
      node.title = `${label} · 睡觉中`; node.setAttribute('aria-label', `${label}，${owner?.name || ''} 正在睡觉`);
    }
    const trading = data?.trading || {};
    const eth = trading.quotes?.find((quote) => quote.symbol === 'ETH');
    const robinhood = trading.robinhood || {};
    const scanner = robinhood.scanner || {};
    const tradableCount = (robinhood.tokens || []).filter((token) => token.tradable).length;
    const market = labelNodes.get('market');
    if (market) {
      market.querySelector('.world3d-market-title').textContent = 'SYN TERRA EXCHANGE';
      market.querySelector('.world3d-market-ticker').textContent = eth?.priceUsd
        ? `ETH  $${Number(eth.priceUsd).toLocaleString('en-US', { maximumFractionDigits: 2 })}   ·   USDC` : 'INTERNAL SIMULATED MARKET';
      market.querySelector('.world3d-market-status').textContent = scanner.healthy
        ? `ROBINHOOD · PONS V2   ${tradableCount} 可模拟` : 'ROBINHOOD SCAN CONNECTING';
      market.dataset.live = scanner.healthy && scanner.fresh ? 'true' : 'false';
    }
    if (eth?.priceUsd && Number(eth.priceUsd) !== priceHistory.at(-1)) {
      priceHistory.push(Number(eth.priceUsd)); if (priceHistory.length > 40) priceHistory.shift();
      drawBoard(eth.priceUsd);
    }
    for (const [key, node] of labelNodes) if (!wanted.has(key)) { node.remove(); labelNodes.delete(key); }
  }

  function placeLabel(node, x, y, z, rect) {
    if (!node) return null;
    projected.set(x, y, z).project(camera);
    if (projected.z > 1 || projected.z < -1) { node.hidden = true; return null; }
    const sx = (projected.x * 0.5 + 0.5) * rect.width, sy = (0.5 - projected.y * 0.5) * rect.height;
    node.style.left = `${sx}px`; node.style.top = `${sy}px`; node.hidden = false;
    return [sx, sy];
  }

  // ---- world clock (day/night) ------------------------------------------------------------------
  function syncClock(engine) {
    const now = performance.now();
    let minutes = Number(engine?.worldMinutes);
    if (!Number.isFinite(minutes) && Number.isFinite(Number(engine?.hour))) minutes = Number(engine.hour) * 60 + Number(engine.minute || 0);
    if (!Number.isFinite(minutes)) minutes = Number(data?.world?.environment?.calendar?.worldMinutes);
    if (!Number.isFinite(minutes)) return;
    if (clock.sampleMinutes !== null && minutes > clock.sampleMinutes && now - clock.sampleAt > 500) {
      clock.rate = Math.min(0.01, (minutes - clock.sampleMinutes) / (now - clock.sampleAt));
    }
    if (engine?.running === false) clock.rate = 0;
    if (clock.sampleMinutes === null || minutes !== clock.sampleMinutes) { clock.sampleMinutes = minutes; clock.sampleAt = now; }
  }
  function currentHour(now) {
    if (clock.sampleMinutes === null) return 10.5;
    const target = clock.sampleMinutes + clock.rate * Math.min(now - clock.sampleAt, 120_000);
    if (clock.display === null || Math.abs(target - clock.display) > 90) clock.display = target;
    else clock.display += (target - clock.display) * 0.08;
    return ((clock.display % 1440) + 1440) % 1440 / 60;
  }

  const sunDir = new THREE.Vector3(), skyColor = new THREE.Color(), waterDay = new THREE.Color('#4fb0cf'), waterNight = new THREE.Color('#14304a');
  const overcastTop = new THREE.Color(), overcastHorizon = new THREE.Color(), warmTint = new THREE.Color('#ffcf8a'), hazeColor = new THREE.Color('#f1d6a6');
  const fogGrey = new THREE.Color('#c3cad1'), cloudWhite = new THREE.Color('#ffffff'), cloudGrey = new THREE.Color('#8f979f'), cloudStorm = new THREE.Color('#4f565e');
  const flashColor = new THREE.Color('#e8eeff');
  function applyTimeOfDay(rawHour) {
    const hour = paletteHour(rawHour);
    const palette = skyAt(hour);
    const w = weatherNow, night = palette.night, daylight = 1 - night;
    const dayAngle = ((hour - 6) / 12) * Math.PI;
    const isDay = hour >= 6 && hour <= 18;
    const elevation = isDay ? Math.sin(dayAngle) : Math.sin(((hour - 18 + 24) % 24) / 12 * Math.PI);
    const azimuth = (hour / 24) * TAU + 0.9;
    const el = Math.max(0.22, elevation);
    sunDir.set(Math.cos(azimuth) * Math.cos(el), Math.sin(el), Math.sin(azimuth) * Math.cos(el)).normalize();
    sun.position.copy(view.target).addScaledVector(sunDir, 60); sun.target.position.copy(view.target);
    const overcast = Math.min(1, w.overcast + w.storm * 0.1);
    sun.color.copy(palette.light).lerp(warmTint, w.heat * 0.55);
    sun.intensity = palette.lightIntensity * (1 - overcast * 0.78) * (1 + w.heat * 0.08);
    hemi.intensity = palette.hemi * (1 - overcast * 0.22 - w.storm * 0.15) + w.flash * 0.9;
    hemi.color.copy(palette.top).lerp(skyColor.set('#ffffff'), 0.55).lerp(fogGrey, overcast * 0.5).lerp(warmTint, w.heat * 0.5);
    hemi.groundColor.set(night > 0.5 ? '#1d2433' : '#5b6b3a');
    // overcast sky: flat grey that follows the light level; storms are darker
    const brightness = 0.07 + daylight * (0.92 - w.storm * 0.42);
    overcastTop.set('#9aa3ad').multiplyScalar(brightness);
    overcastHorizon.set('#b8bfc6').multiplyScalar(brightness * 1.02);
    const greyMix = Math.min(1, overcast * 0.95 + w.fog * 0.5);
    sky.uniforms.top.value.copy(palette.top).lerp(overcastTop, greyMix).lerp(hazeColor, w.heat * 0.3 * daylight);
    sky.uniforms.horizon.value.copy(palette.horizon).lerp(overcastHorizon, greyMix).lerp(hazeColor, w.heat * 0.7 * daylight);
    if (w.flash) { sky.uniforms.top.value.lerp(flashColor, w.flash * 0.55); sky.uniforms.horizon.value.lerp(flashColor, w.flash * 0.4); }
    sky.uniforms.sunDir.value.set(Math.cos(azimuth) * Math.cos(Math.max(-0.2, elevation)), isDay ? elevation : -0.3, Math.sin(azimuth) * Math.cos(elevation));
    sky.uniforms.sunColor.value.copy(palette.light); sky.uniforms.day.value = daylight * (1 - overcast * 0.9);
    // fog: thin sea haze normally; dense for fog, heavier in rain / snow / storm, warm haze in heat
    scene.fog.color.copy(sky.uniforms.horizon.value);
    if (w.fog > 0.01) scene.fog.color.lerp(overcastHorizon.set('#c9cfd4').multiplyScalar(0.12 + daylight * 0.85), w.fog * 0.7);
    const precip = Math.max(w.rain * (0.6 + w.storm * 0.4), w.snow * 0.8);
    scene.fog.near = Math.max(4, 55 - w.fog * 44 - precip * 28 - w.heat * 26);
    scene.fog.far = Math.max(scene.fog.near + 12, 165 - w.fog * 112 - precip * 70 - w.heat * 62);
    stars.material.opacity = Math.max(0, night - 0.15) * (1 - Math.min(1, overcast * 1.1 + w.fog));
    materials.window.emissiveIntensity = 0.05 + night * 2.6;
    materials.lamp.emissiveIntensity = 0.2 + night * 3;
    materials.screen.emissiveIntensity = 0.9 + night * 0.8;
    // lamps also switch on under heavy cloud / fog during the day
    const gloom = Math.max(night, Math.min(0.7, overcast * 0.55 + w.fog * 0.5) * daylight);
    for (const light of lampLights) light.intensity = gloom * 3.2;
    for (const sprite of glowSprites) sprite.material.opacity = gloom * 0.85;
    lightning.intensity = w.flash * 1.5;
    water.material.color.copy(waterDay).lerp(waterNight, Math.min(1, night + overcast * 0.35));
    renderer.toneMappingExposure = 1.05 + night * 0.25 + w.heat * 0.08;
    cloudMat.color.copy(cloudWhite).lerp(cloudGrey, Math.min(1, overcast * 1.1)).lerp(cloudStorm, w.storm);
    cloudMat.opacity = 0.9 + overcast * 0.08;
    applyPlaceAndHomeLights(night, gloom);
  }

  // place windows follow openNow; cottage windows follow whether the owner is home (and awake)
  function applyPlaceAndHomeLights(night, gloom) {
    const scenes = data?.scenes || [];
    placeWindowMats.forEach((material, index) => {
      const open = scenes[index]?.openNow !== false;
      material.emissiveIntensity = open ? 0.05 + gloom * 2.6 : 0.01;
      material.color.set(open ? '#3d4f62' : '#252d36');
      const glow = placeGlows[index];
      if (glow) glow.material.opacity = open ? gloom * 0.75 : 0;
    });
    if (!homeWindowMats.size) return;
    const residents = new Map((data?.residents || []).map((resident) => [resident.id, resident]));
    for (const [id, material] of homeWindowMats) {
      const owner = residents.get(id);
      const homeKey = owner?.home?.location || `home:${id}`;
      const home = Boolean(owner) && (owner.location === homeKey || (owner.location === undefined && owner.atHome === true));
      const level = !home ? 0 : owner.asleep ? 0.12 : 1;
      material.emissiveIntensity = 0.02 + gloom * 2.8 * level;
      material.color.set(level ? '#3d4f62' : '#2b333c');
      if (material.userData.glow) material.userData.glow.material.opacity = gloom * 0.8 * level;
    }
  }

  // ---- weather & season ---------------------------------------------------------------------------
  const autumnLeaf = new THREE.Color(), winterLeaf = new THREE.Color('#7d7a62'), snowWhite = new THREE.Color('#f4f7fb'), leaf = new THREE.Color();
  function applyGroundTint() {
    const t = groundTint;
    if (groundApplied && ['autumn', 'winter', 'summer', 'snow'].every((key) => Math.abs(groundApplied[key] - t[key]) < 0.015)) return;
    groundApplied = { ...t };
    tintTerrain(terrain, t);
    if (!natureTrees) return;
    const { round, pine, roundBase, pineBase, roundHue, flowers } = natureTrees;
    if (roundBase) {
      for (let i = 0; i < round.count; i += 1) {
        leaf.fromArray(roundBase, i * 3);
        const hue = roundHue[i] ?? 0.5;
        autumnLeaf.setHSL(0.02 + hue * 0.1, 0.68, 0.46);
        if (t.summer) leaf.offsetHSL(0, 0.04 * t.summer, -0.02 * t.summer);
        if (t.autumn) leaf.lerp(autumnLeaf, t.autumn * (0.45 + hue * 0.5));
        if (t.winter) leaf.lerp(winterLeaf, t.winter * 0.55);
        if (t.snow) leaf.lerp(snowWhite, t.snow * 0.55);
        round.setColorAt(i, leaf);
      }
      round.instanceColor.needsUpdate = true;
    }
    if (pineBase) {
      for (let i = 0; i < pine.count; i += 1) {
        leaf.fromArray(pineBase, i * 3);
        if (t.winter) leaf.offsetHSL(0, -0.08 * t.winter, -0.02 * t.winter);
        if (t.snow) leaf.lerp(snowWhite, t.snow * (i % 2 ? 0.62 : 0.4));
        pine.setColorAt(i, leaf);
      }
      pine.instanceColor.needsUpdate = true;
    }
    if (flowers) flowers.visible = t.winter < 0.5 && t.snow < 0.3;
  }

  function weatherTargets() {
    const env = data?.world?.environment, weather = env?.weather, calendar = env?.calendar;
    const look = { ...(WEATHER_LOOK[weather?.condition] || WEATHER_LOOK.clear) };
    if (weather) {
      const precipitation = Number(weather.precipitation), cover = Number(weather.cloudCover);
      if (Number.isFinite(precipitation) && precipitation > 0) {
        if (look.rain) look.rain = Math.min(1, look.rain * 0.55 + precipitation * 0.6 + (weather.condition === 'storm' ? 0.4 : 0));
        if (look.snow) look.snow = Math.min(1, 0.45 + precipitation * 0.55);
      }
      if (Number.isFinite(cover)) look.cloud = Math.max(look.cloud, weather.condition === 'heatwave' ? 0 : cover * 0.9);
    }
    const wind = Number(weather?.windKph);
    look.wind = Number.isFinite(wind) ? wind : 10;
    look.windAngle = Number.isFinite(Number(weather?.block)) ? (hash(`wind:${weather.block}`) % 628) / 100 : 0.7;
    const season = calendar?.season;
    groundTarget.autumn = season === 'autumn' ? 1 : 0; groundTarget.winter = season === 'winter' ? 1 : 0; groundTarget.summer = season === 'summer' ? 1 : 0;
    const temperature = Number(weather?.temperatureC);
    groundTarget.snow = weather?.condition === 'snow' ? 0.55 + look.snow * 0.45 : season === 'winter' && Number.isFinite(temperature) && temperature <= 0 ? 0.3 : 0;
    return look;
  }

  function stepWeather(dt, time, motion) {
    const target = weatherTargets();
    const snap = !weatherNow.initialised || !motion;
    const k = snap ? 1 : 1 - Math.exp(-dt * 0.9), kGround = snap ? 1 : 1 - Math.exp(-dt * 0.35);
    for (const key of ['cloud', 'overcast', 'rain', 'snow', 'storm', 'fog', 'heat', 'wind']) weatherNow[key] += (target[key] - weatherNow[key]) * k;
    let angleDelta = ((target.windAngle - weatherNow.windAngle + Math.PI * 3) % TAU) - Math.PI;
    weatherNow.windAngle += angleDelta * k;
    for (const key of Object.keys(groundTint)) groundTint[key] += (groundTarget[key] - groundTint[key]) * kGround;
    weatherNow.initialised = Boolean(data);
    applyGroundTint();
    // lightning: short double flicker every few seconds while stormy
    const t = time / 1000;
    if (weatherNow.storm > 0.5 && motion) {
      if (!weatherNow.nextFlash || t > weatherNow.nextFlash + 30) weatherNow.nextFlash = t + 1.5 + Math.random() * 3;
      if (t >= weatherNow.nextFlash) { weatherNow.flashStart = t; weatherNow.nextFlash = t + 3.5 + Math.random() * 6; }
      const since = t - (weatherNow.flashStart ?? -10);
      weatherNow.flash = since < 0.09 ? 1 : since < 0.16 ? 0.25 : since < 0.26 ? 0.85 : Math.max(0, 0.85 - (since - 0.26) * 4);
    } else weatherNow.flash = 0;
    animatePrecipitation(dt, motion);
  }

  function animatePrecipitation(dt, motion) {
    const wind = weatherNow.wind, wx = Math.cos(weatherNow.windAngle), wz = Math.sin(weatherNow.windAngle);
    const cx = view.target.x, cz = view.target.z;
    const rainCount = Math.round(RAIN_MAX * Math.min(1, weatherNow.rain));
    rain.mesh.visible = rainCount > 8;
    if (rain.mesh.visible) {
      const fall = 24 + weatherNow.storm * 8, drift = wind * 0.09, step = motion ? dt : 0;
      const slantX = wx * drift / fall, slantZ = wz * drift / fall, streak = 0.55 + weatherNow.storm * 0.25;
      const { seeds, positions } = rain;
      for (let i = 0; i < rainCount; i += 1) {
        let y = seeds[i * 3 + 1] - fall * step;
        if (y < 0) y += PRECIP_BOX.top;
        seeds[i * 3 + 1] = y;
        seeds[i * 3] += wx * drift * step; seeds[i * 3 + 2] += wz * drift * step;
        if (seeds[i * 3] > PRECIP_BOX.x) seeds[i * 3] -= PRECIP_BOX.x * 2; else if (seeds[i * 3] < -PRECIP_BOX.x) seeds[i * 3] += PRECIP_BOX.x * 2;
        if (seeds[i * 3 + 2] > PRECIP_BOX.z) seeds[i * 3 + 2] -= PRECIP_BOX.z * 2; else if (seeds[i * 3 + 2] < -PRECIP_BOX.z) seeds[i * 3 + 2] += PRECIP_BOX.z * 2;
        const x = cx + seeds[i * 3], z = cz + seeds[i * 3 + 2], o = i * 6;
        positions[o] = x; positions[o + 1] = y; positions[o + 2] = z;
        positions[o + 3] = x - slantX * streak; positions[o + 4] = y + streak; positions[o + 5] = z - slantZ * streak;
      }
      rain.mesh.geometry.setDrawRange(0, rainCount * 2);
      rain.mesh.geometry.attributes.position.needsUpdate = true;
      rain.material.opacity = 0.38 + weatherNow.rain * 0.3;
    }
    const snowCount = Math.round(SNOW_MAX * Math.min(1, weatherNow.snow));
    snow.mesh.visible = snowCount > 8;
    if (snow.mesh.visible) {
      const step = motion ? dt : 0, drift = wind * 0.05, t = performance.now() / 1000;
      const { seeds, positions } = snow;
      for (let i = 0; i < snowCount; i += 1) {
        let y = seeds[i * 4 + 1] - (1.3 + (i % 5) * 0.18) * step;
        if (y < 0) y += PRECIP_BOX.top;
        seeds[i * 4 + 1] = y;
        seeds[i * 4] += wx * drift * step; seeds[i * 4 + 2] += wz * drift * step;
        if (seeds[i * 4] > PRECIP_BOX.x) seeds[i * 4] -= PRECIP_BOX.x * 2; else if (seeds[i * 4] < -PRECIP_BOX.x) seeds[i * 4] += PRECIP_BOX.x * 2;
        if (seeds[i * 4 + 2] > PRECIP_BOX.z) seeds[i * 4 + 2] -= PRECIP_BOX.z * 2; else if (seeds[i * 4 + 2] < -PRECIP_BOX.z) seeds[i * 4 + 2] += PRECIP_BOX.z * 2;
        const phase = seeds[i * 4 + 3];
        positions[i * 3] = cx + seeds[i * 4] + Math.sin(t * 0.9 + phase) * 0.35;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = cz + seeds[i * 4 + 2] + Math.cos(t * 0.7 + phase) * 0.35;
      }
      snow.mesh.geometry.setDrawRange(0, snowCount);
      snow.mesh.geometry.attributes.position.needsUpdate = true;
    }
  }

  // ---- HUD: world day, time, season, weather, short forecast ---------------------------------------
  const pad = (value) => String(value).padStart(2, '0');
  function updateHud(hour) {
    const env = data?.world?.environment, calendar = env?.calendar, weather = env?.weather;
    if (!calendar && !weather) { if (!hud.hidden) { hud.hidden = true; hudSignature = ''; } return; }
    const engine = data?.world?.engine;
    const time = clock.sampleMinutes === null ? (calendar?.time || '--:--') : `${pad(Math.floor(hour))}:${pad(Math.floor((hour % 1) * 60))}`;
    const day = calendar?.day ?? engine?.day;
    const night = calendar?.isNight === true;
    const condition = weather?.condition;
    const icon = condition === 'clear' && night ? '☾' : WEATHER_ICON[condition] || '·';
    const temperature = Number(weather?.temperatureC);
    const forecast = (env?.forecast || []).slice(0, 4);
    const signature = [time, day, calendar?.weekday, calendar?.season, condition, temperature, weather?.windKph, ...forecast.map((item) => `${item.time}${item.condition}${item.temperatureC}`)].join('|');
    if (signature === hudSignature) return;
    hudSignature = signature; hud.hidden = false;
    hud.replaceChildren();
    const row = (className, ...children) => { const node = document.createElement('div'); node.className = className; node.append(...children); hud.append(node); return node; };
    const span = (className, text) => { const node = document.createElement('span'); node.className = className; node.textContent = text; return node; };
    const weekday = calendar?.weekday ? `${String(calendar.weekday).slice(0, 3).toUpperCase()} ${WEEKDAY_ZH[calendar.weekday] || ''}`.trim() : '';
    const top = row('world3d-hud-day', span('world3d-hud-eyebrow', [day ? `DAY ${day}` : null, weekday || null].filter(Boolean).join(' · ')));
    if (calendar?.isWeekend) top.append(span('world3d-hud-chip', '周末'));
    const season = SEASON_LABEL[calendar?.season];
    row('world3d-hud-clock', span('world3d-hud-time', time), span('world3d-hud-season', season ? `${season[0]} ${season[1]}` : ''));
    if (weather) {
      const parts = [weather.label || condition || '', Number.isFinite(temperature) ? `${Math.round(temperature)}°C` : ''].filter(Boolean).join(' · ');
      const line = row('world3d-hud-weather', span('world3d-hud-icon', icon), span('world3d-hud-weather-text', parts));
      line.dataset.condition = condition || 'clear';
      const wind = Number(weather.windKph);
      if (Number.isFinite(wind)) line.append(span('world3d-hud-wind', `风 ${Math.round(wind)} km/h`));
    }
    if (forecast.length) {
      const list = row('world3d-hud-forecast');
      for (const item of forecast) {
        const cell = document.createElement('span'); cell.className = 'world3d-hud-slot';
        cell.title = `${item.time} ${item.label || item.condition || ''} ${Number.isFinite(Number(item.temperatureC)) ? `${Math.round(item.temperatureC)}°C` : ''}`.trim();
        const slotHour = parseClock(item.time), rise = parseClock(calendar?.sunrise) ?? 6, set = parseClock(calendar?.sunset) ?? 18.5;
        const slotNight = slotHour !== null && (slotHour < rise || slotHour >= set);
        cell.append(span('world3d-hud-slot-time', item.time || ''), span('world3d-hud-slot-icon', item.condition === 'clear' && slotNight ? '☾' : WEATHER_ICON[item.condition] || '·'),
          span('world3d-hud-slot-temp', Number.isFinite(Number(item.temperatureC)) ? `${Math.round(item.temperatureC)}°` : ''));
        list.append(cell);
      }
    }
    hud.setAttribute('aria-label', `第 ${day ?? '?'} 天 ${calendar?.weekday || ''} ${time} ${season?.[1] || ''} ${weather?.label || ''} ${Number.isFinite(temperature) ? `${Math.round(temperature)}°C` : ''}`.trim());
  }

  // hour-of-day remapped so the season's sunrise / sunset line up with the sky palette's dawn / dusk
  const parseClock = (value) => { const match = /^(\d{1,2}):(\d{2})/.exec(String(value || '')); return match ? Number(match[1]) + Number(match[2]) / 60 : null; };
  function paletteHour(hour) {
    const calendar = data?.world?.environment?.calendar;
    const rise = parseClock(calendar?.sunrise), set = parseClock(calendar?.sunset);
    if (rise === null || set === null || !(rise > 1 && set > rise + 4 && set < 23)) return hour;
    if (hour < rise) return hour * (6.4 / rise);
    if (hour < set) return 6.4 + (hour - rise) * ((18.4 - 6.4) / (set - rise));
    return 18.4 + (hour - set) * ((24 - 18.4) / (24 - set));
  }

  // ---- per-frame --------------------------------------------------------------------------------
  function animateWorld(time) {
    const t = time / 1000;
    const positions = water.mesh.geometry.attributes.position, base = water.base;
    for (let i = 0; i < positions.count; i += 1) {
      const x = base[i * 3], z = base[i * 3 + 2];
      positions.array[i * 3 + 1] = Math.sin(x * 0.45 + t * 0.9) * 0.07 + Math.cos(z * 0.38 + t * 0.7) * 0.07;
    }
    positions.needsUpdate = true;
    for (const part of dynamicParts) {
      const u = part.userData;
      if (u.spin) part.rotation.y += u.spin * 0.016;
      if (u.smoke) {
        const k = (t * 0.22 + u.smoke.offset) % 1;
        part.position.set(u.smoke.x + Math.sin(k * 5 + u.smoke.offset * 9) * 0.12, u.smoke.y + k * 1.3, u.smoke.z);
        part.scale.setScalar(0.6 + k * 1.6);
      }
      if (u.blink !== undefined) part.visible = Math.sin(t * 3 + u.blink) > -0.4;
      if (u.beacon) part.visible = (t % 1.6) < 0.6;
      if (u.bob) part.position.y = 0.86 + Math.sin(t * 4) * 0.05;
      if (u.flag !== undefined) part.rotation.y = Math.sin(t * 2 + u.flag) * 0.25;
    }
    const visibleClouds = Math.round(4 + weatherNow.cloud * (clouds.children.length - 4));
    const windBoost = 1 + weatherNow.wind / 9;
    clouds.children.forEach((cloud, index) => {
      cloud.visible = index < visibleClouds;
      cloud.userData.angle += cloud.userData.speed * 0.016 * windBoost;
      cloud.position.x = Math.cos(cloud.userData.angle) * cloud.userData.radius;
      cloud.position.z = Math.sin(cloud.userData.angle) * cloud.userData.radius * 0.8;
      cloud.position.y = cloud.userData.baseY;
      // never let a cloud drift in front of the lens
      if (cloud.visible && cloud.position.distanceTo(camera.position) < 16) cloud.visible = false;
      cloud.scale.set(1 + weatherNow.overcast * 0.6, 1 + weatherNow.storm * 0.4, 1 + weatherNow.overcast * 0.6);
    });
  }

  function updateCamera(dt) {
    const k = 1 - Math.exp(-dt * 9);
    view.yaw += (goal.yaw - view.yaw) * k; view.pitch += (goal.pitch - view.pitch) * k;
    view.distance += (goal.distance - view.distance) * k; view.target.lerp(goal.target, k);
    const cp = Math.cos(view.pitch);
    camera.position.set(view.target.x + Math.sin(view.yaw) * cp * view.distance, view.target.y + Math.sin(view.pitch) * view.distance, view.target.z + Math.cos(view.yaw) * cp * view.distance);
    camera.lookAt(view.target);
    return Math.abs(goal.yaw - view.yaw) + Math.abs(goal.pitch - view.pitch) + Math.abs(goal.distance - view.distance) * 0.05 + goal.target.distanceTo(view.target) > 0.002;
  }

  let lastTime = 0;
  function frameWorld(time = performance.now()) {
    if (disposed) return false;
    const rect = canvas.getBoundingClientRect(), ratio = Math.min(window.devicePixelRatio || 1, 1.75);
    const width = Math.max(1, Math.round(rect.width)), height = Math.max(1, Math.round(rect.height));
    if (renderer.getPixelRatio() !== ratio) renderer.setPixelRatio(ratio);
    const size = renderer.getSize(new THREE.Vector2());
    if (size.x !== width || size.y !== height) { renderer.setSize(width, height, false); }
    camera.aspect = width / height; camera.updateProjectionMatrix();
    const dt = Math.min(0.1, lastTime ? (time - lastTime) / 1000 : 0.016); lastTime = time;
    const moving = updateCamera(reducedMotion?.matches ? 1 : dt);
    const motion = !reducedMotion?.matches;
    const hour = currentHour(time);
    stepWeather(dt, time, motion);
    applyTimeOfDay(hour);
    updateHud(hour);
    canvas.dataset.worldHour = hour.toFixed(2);
    canvas.dataset.weather = data?.world?.environment?.weather?.condition || '';
    canvas.dataset.lightning = weatherNow.flash > 0.01 ? 'flash' : '';
    if (motion) animateWorld(time);
    const now = Date.now();
    projectedResidents = [];
    if (data) {
      const { frames, placed } = layout(now);
      frames.forEach((frame, index) => {
        placeLabel(labelNodes.get(`scene:${data.scenes[index].name}`), frame.center[0], 3.2, frame.center[1], rect);
      });
      placeLabel(labelNodes.get('market'), 0, 4.7, 0, rect);
      for (const slot of homeSlots) {
        const owner = data.residents.find((resident) => resident.id === slot.id);
        const node = labelNodes.get(`home:${slot.id}`);
        if (!node) continue;
        if (owner?.asleep && owner.location === slot.location) placeLabel(node, slot.center[0], slot.y + 2.3, slot.center[1], rect);
        else node.hidden = true;
      }
      for (const item of placed) {
        const figure = figures.get(item.resident.id); if (!figure) continue;
        // asleep at home: the resident is indoors; the cottage shows "Zz" instead
        const indoors = Boolean(item.resident.asleep && homeById.has(item.resident.location));
        figure.root.visible = !indoors;
        if (indoors) { const node = labelNodes.get(`resident:${item.resident.id}`); if (node) node.hidden = true; continue; }
        figure.root.position.set(item.position[0], Math.max(0, heightAt(item.position[0], item.position[1])), item.position[1]);
        if (figure.heading === null) figure.heading = item.facing;
        let delta = ((item.facing - figure.heading + Math.PI * 3) % TAU) - Math.PI;
        figure.heading += motion ? delta * Math.min(1, dt * 8) : delta;
        figure.root.rotation.y = figure.heading;
        const walking = Boolean(item.movement && item.movement.progress < 1);
        const activity = activityFor(item.resident, now);
        poseResident(figure, activity, walking, motion ? time : 0, !motion);
        const selected = item.resident.id === selectedId;
        figure.ring.visible = selected;
        if (selected) { const pulse = 1 + Math.sin(time / 260) * 0.08; figure.ring.scale.set(pulse, pulse, pulse); }
        const point = placeLabel(labelNodes.get(`resident:${item.resident.id}`), item.position[0], 2.05 + figure.root.position.y, item.position[1], rect);
        if (point) projectedResidents.push({ id: item.resident.id, x: point[0], y: point[1] });
      }
    }
    renderer.render(scene, camera);
    return moving;
  }

  const invalidate = () => {
    if (disposed || frame) return;
    frame = window.requestAnimationFrame((time) => {
      frame = 0;
      if (document.visibilityState !== 'visible' || !inViewport) return;
      if (time - lastDrawAt < 32) { invalidate(); return; }
      lastDrawAt = time;
      const moving = frameWorld(time);
      if ((data && !reducedMotion?.matches) || moving) invalidate();
    });
  };
  const visibilityChanged = () => {
    if (document.visibilityState !== 'visible') { window.cancelAnimationFrame(frame); frame = 0; }
    else invalidate();
  };
  const intersectionObserver = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
      inViewport = Boolean(entries[0]?.isIntersecting);
      if (!inViewport) { window.cancelAnimationFrame(frame); frame = 0; }
      else invalidate();
    }, { threshold: 0.01 }) : null;
  const motionPreferenceChanged = () => invalidate();
  ensureLabels([], []);
  buildTown([], []);
  intersectionObserver?.observe(canvas);
  invalidate();

  // ---- input: orbit (left drag), pan (right / shift drag), zoom (wheel / pinch), pick (click) ---
  function pickResident(clientX, clientY) {
    const rect = canvas.getBoundingClientRect(), x = clientX - rect.left, y = clientY - rect.top;
    ndc.set((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects([...figures.values()].map((figure) => figure.hit), false);
    if (hits.length) return hits[0].object.userData.residentId;
    let nearest = null, distance = 30;
    for (const item of projectedResidents) { const current = Math.hypot(item.x - x, item.y - y); if (current < distance) { nearest = item; distance = current; } }
    return nearest?.id || null;
  }
  function pan(dx, dy) {
    const scale = view.distance * 0.0016;
    const right = new THREE.Vector3(Math.cos(view.yaw), 0, -Math.sin(view.yaw)), forward = new THREE.Vector3(-Math.sin(view.yaw), 0, -Math.cos(view.yaw));
    goal.target.addScaledVector(right, -dx * scale).addScaledVector(forward, dy * scale);
    const length = Math.hypot(goal.target.x, goal.target.z);
    if (length > 14) goal.target.multiplyScalar(14 / length);
    goal.target.y = 0.4;
  }
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  canvas.addEventListener('pointerdown', (event) => {
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()]; pinchDistance = Math.hypot(a.x - b.x, a.y - b.y); drag = { ...drag, moved: true, pinch: true };
    } else drag = { x: event.clientX, y: event.clientY, moved: false, pan: event.button === 2 || event.shiftKey };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (!drag) return;
    if (drag.pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()], current = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDistance) goal.distance = Math.max(14, Math.min(72, goal.distance * (pinchDistance / current)));
      pinchDistance = current; invalidate(); return;
    }
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (drag.pan) pan(dx, dy);
    else { goal.yaw -= dx * 0.008; goal.pitch = Math.max(0.28, Math.min(1.35, goal.pitch + dy * 0.006)); }
    drag.x = event.clientX; drag.y = event.clientY;
    invalidate();
  });
  const endPointer = (event) => {
    pointers.delete(event.pointerId);
    if (!drag) return;
    if (event.type === 'pointerup' && !drag.moved && !drag.pinch) {
      const id = pickResident(event.clientX, event.clientY);
      if (id) onSelect(id);
    }
    if (pointers.size === 0) drag = null;
    invalidate();
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('dblclick', (event) => {
    const id = pickResident(event.clientX, event.clientY);
    const figure = id && figures.get(id);
    if (figure) { goal.target.set(figure.root.position.x, 0.4, figure.root.position.z); goal.distance = Math.min(goal.distance, 22); }
    else { goal.target.set(0, 0.4, 0); goal.distance = 33; goal.pitch = 0.7; }
    invalidate();
  });
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    goal.distance = Math.max(14, Math.min(72, goal.distance * Math.exp(Math.sign(event.deltaY) * 0.12)));
    invalidate();
  }, { passive: false });
  canvas.addEventListener('keydown', (event) => {
    const residents = data?.residents || [];
    if (!residents.length || !['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Enter'].includes(event.key)) return;
    event.preventDefault();
    const index = residents.findIndex((resident) => resident.id === selectedId);
    const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === 'Enter' ? index + 1 : index - 1;
    onSelect(residents[(next + residents.length) % residents.length].id);
    invalidate();
  });
  window.addEventListener('resize', invalidate);
  document.addEventListener('visibilitychange', visibilityChanged);
  reducedMotion?.addEventListener?.('change', motionPreferenceChanged);

  return {
    update(nextData, nextSelectedId) {
      data = nextData;
      selectedId = nextSelectedId;
      const scenes = data?.scenes || [];
      const residents = data?.residents || [];
      const signature = scenes.map((item) => `${item.name}|${item.sceneType}|${item.position?.x}|${item.position?.z}`).join(';')
        + '#' + residents.map((item) => `${item.id}@${item.home?.position?.x ?? ''},${item.home?.position?.z ?? ''}`).sort().join(';');
      if (signature !== townSignature) {
        townSignature = signature; townFrames = placeCenters(scenes).map(placeFrame);
        homeSlots = computeHomeSlots(residents, townFrames);
        homeById = new Map(homeSlots.map((slot) => [slot.location, slot]));
        buildTown(scenes, townFrames, homeSlots);
      }
      syncFigures(data?.residents || []);
      syncClock(data?.world?.engine);
      ensureLabels(scenes, data?.residents || []);
      invalidate();
    },
    select(id) {
      selectedId = id;
      for (const resident of data?.residents || []) labelNodes.get(`resident:${resident.id}`)?.classList.toggle('is-selected', resident.id === selectedId);
      invalidate();
    },
    dispose() {
      disposed = true; window.cancelAnimationFrame(frame);
      intersectionObserver?.disconnect();
      window.removeEventListener('resize', invalidate);
      document.removeEventListener('visibilitychange', visibilityChanged);
      reducedMotion?.removeEventListener?.('change', motionPreferenceChanged);
      hud.remove();
      renderer.dispose();
    }
  };
}

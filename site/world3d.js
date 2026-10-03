const vertexShader = `
  attribute vec3 aPosition;
  attribute vec3 aNormal;
  uniform mat4 uViewProjection;
  uniform mat4 uModel;
  varying vec3 vNormal;
  varying vec3 vPosition;
  void main() {
    vec4 worldPosition = uModel * vec4(aPosition, 1.0);
    vPosition = worldPosition.xyz;
    vNormal = normalize(mat3(uModel) * aNormal);
    gl_Position = uViewProjection * worldPosition;
  }
`;

const fragmentShader = `
  precision mediump float;
  uniform vec3 uColor;
  varying vec3 vNormal;
  varying vec3 vPosition;
  void main() {
    vec3 normal = normalize(vNormal);
    vec3 light = normalize(vec3(-0.45, 0.85, 0.35));
    float diffuse = max(dot(normal, light), 0.0);
    float heightTint = clamp((vPosition.y + 1.0) * 0.018, -0.025, 0.055);
    vec3 color = uColor * (0.56 + diffuse * 0.48 + heightTint);
    gl_FragColor = vec4(color, 1.0);
  }
`;

const SCENE_COLORS = {
  garden: [0.25, 0.48, 0.30], studio: [0.43, 0.39, 0.59], library: [0.62, 0.52, 0.33],
  cafe: [0.70, 0.40, 0.27], workshop: [0.43, 0.51, 0.48], observatory: [0.31, 0.49, 0.65],
  commons: [0.54, 0.60, 0.38], data_center: [0.24, 0.57, 0.69]
};

function shader(gl, type, source) {
  const item = gl.createShader(type);
  gl.shaderSource(item, source);
  gl.compileShader(item);
  if (!gl.getShaderParameter(item, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(item));
  return item;
}

function makeProgram(gl) {
  const program = gl.createProgram();
  gl.attachShader(program, shader(gl, gl.VERTEX_SHADER, vertexShader));
  gl.attachShader(program, shader(gl, gl.FRAGMENT_SHADER, fragmentShader));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  return program;
}

function mesh(gl, positions, normals) {
  const positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
  const normalBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(normals), gl.STATIC_DRAW);
  return { positionBuffer, normalBuffer, count: positions.length / 3 };
}

function boxMesh(gl) {
  const positions = [], normals = [];
  const faces = [
    [[0, 0.5, 0], [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]],
    [[0, 0, 0.5], [0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]],
    [[0.5, 0, 0], [0.5, -0.5, 0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5]],
    [[-0.5, 0, 0], [-0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5]],
    [[0, 0.5, 0], [-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]],
    [[0, -0.5, 0], [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5]]
  ];
  for (const [normal, a, b, c, d] of faces) {
    for (const point of [a, b, c, a, c, d]) { positions.push(...point); normals.push(...normal); }
  }
  return mesh(gl, positions, normals);
}

function sphereMesh(gl, rings = 12, sectors = 16) {
  const positions = [], normals = [];
  for (let ring = 0; ring < rings; ring += 1) {
    const a0 = Math.PI * ring / rings, a1 = Math.PI * (ring + 1) / rings;
    for (let sector = 0; sector < sectors; sector += 1) {
      const b0 = 2 * Math.PI * sector / sectors, b1 = 2 * Math.PI * (sector + 1) / sectors;
      const p = (a, b) => [Math.sin(a) * Math.cos(b), Math.cos(a), Math.sin(a) * Math.sin(b)];
      const quad = [p(a0, b0), p(a1, b0), p(a1, b1), p(a0, b0), p(a1, b1), p(a0, b1)];
      for (const point of quad) { positions.push(...point); normals.push(...point); }
    }
  }
  return mesh(gl, positions, normals);
}

function cylinderMesh(gl, sectors = 18, topRadius = 1, bottomRadius = 1) {
  const positions = [], normals = [];
  const push = (point, normal) => { positions.push(...point); normals.push(...normal); };
  for (let index = 0; index < sectors; index += 1) {
    const a = 2 * Math.PI * index / sectors, b = 2 * Math.PI * (index + 1) / sectors;
    const p0 = [bottomRadius * Math.cos(a), -0.5, bottomRadius * Math.sin(a)];
    const p1 = [bottomRadius * Math.cos(b), -0.5, bottomRadius * Math.sin(b)];
    const p2 = [topRadius * Math.cos(b), 0.5, topRadius * Math.sin(b)];
    const p3 = [topRadius * Math.cos(a), 0.5, topRadius * Math.sin(a)];
    const n = angle => [Math.cos(angle), bottomRadius - topRadius, Math.sin(angle)];
    for (const point of [p0, p1, p2, p0, p2, p3]) push(point, n(Math.atan2(point[2], point[0])));
    for (const [point, normal] of [
      [[0, 0.5, 0], [0, 1, 0]], [p3, [0, 1, 0]], [p2, [0, 1, 0]],
      [[0, -0.5, 0], [0, -1, 0]], [p1, [0, -1, 0]], [p0, [0, -1, 0]]
    ]) push(point, normal);
  }
  return mesh(gl, positions, normals);
}

function identity() { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
function multiply(a, b) {
  const out = new Array(16);
  for (let column = 0; column < 4; column += 1) for (let row = 0; row < 4; row += 1) {
    out[column * 4 + row] = a[row] * b[column * 4] + a[4 + row] * b[column * 4 + 1] + a[8 + row] * b[column * 4 + 2] + a[12 + row] * b[column * 4 + 3];
  }
  return out;
}
function translate(x, y, z) { const out = identity(); out[12] = x; out[13] = y; out[14] = z; return out; }
function scale(x, y, z) { const out = identity(); out[0] = x; out[5] = y; out[10] = z; return out; }
function rotateY(angle) { const c = Math.cos(angle), s = Math.sin(angle); return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]; }
function rotateX(angle) { const c = Math.cos(angle), s = Math.sin(angle); return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]; }
function rotateZ(angle) { const c = Math.cos(angle), s = Math.sin(angle); return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
function perspective(fov, aspect, near, far) {
  const f = 1 / Math.tan(fov / 2), range = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (near + far) * range, -1, 0, 0, 2 * near * far * range, 0];
}
function lookAt(eye, target) {
  const normalize = v => { const length = Math.hypot(...v) || 1; return v.map(value => value / length); };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const subtract = (a, b) => a.map((value, index) => value - b[index]);
  const z = normalize(subtract(eye, target)), x = normalize(cross([0, 1, 0], z)), y = cross(z, x);
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -x.reduce((s, v, i) => s + v * eye[i], 0), -y.reduce((s, v, i) => s + v * eye[i], 0), -z.reduce((s, v, i) => s + v * eye[i], 0), 1];
}

function hash(value) {
  let result = 2166136261;
  for (const char of String(value)) result = Math.imul(result ^ char.charCodeAt(0), 16777619);
  return result >>> 0;
}
function colorFromHash(value) {
  const h = hash(value);
  return [0.45 + (h & 255) / 850, 0.45 + ((h >>> 8) & 255) / 850, 0.43 + ((h >>> 16) & 255) / 900];
}

export function createWorld3D(canvas, labelsElement, onSelect) {
  let gl;
  try { gl = canvas.getContext('webgl', { antialias: true, alpha: false }); } catch { return null; }
  if (!gl) return null;

  let program, meshes;
  try {
    program = makeProgram(gl);
    meshes = { box: boxMesh(gl), sphere: sphereMesh(gl), cylinder: cylinderMesh(gl), cone: cylinderMesh(gl, 18, 0, 1) };
  } catch { return null; }

  const locations = {
    position: gl.getAttribLocation(program, 'aPosition'), normal: gl.getAttribLocation(program, 'aNormal'),
    viewProjection: gl.getUniformLocation(program, 'uViewProjection'), model: gl.getUniformLocation(program, 'uModel'), color: gl.getUniformLocation(program, 'uColor')
  };
  const camera = { yaw: -0.55, pitch: 0.63, distance: 26 };
  let data = null, selectedId = null, frame = 0, disposed = false, drag = null, projectedResidents = [];
  let lastDrawAt = 0;
  let inViewport = typeof IntersectionObserver !== 'function';
  const labelNodes = new Map();
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(0.055, 0.09, 0.064, 1);

  function draw(item, color, model) {
    gl.bindBuffer(gl.ARRAY_BUFFER, item.positionBuffer);
    gl.enableVertexAttribArray(locations.position);
    gl.vertexAttribPointer(locations.position, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, item.normalBuffer);
    gl.enableVertexAttribArray(locations.normal);
    gl.vertexAttribPointer(locations.normal, 3, gl.FLOAT, false, 0, 0);
    gl.uniformMatrix4fv(locations.model, false, model);
    gl.uniform3fv(locations.color, color);
    gl.drawArrays(gl.TRIANGLES, 0, item.count);
  }

  function object(kind, color, x, y, z, sx, sy, sz, ry = 0, rx = 0, rz = 0) {
    let model = multiply(translate(x, y, z), rotateY(ry));
    if (rx) model = multiply(model, rotateX(rx));
    if (rz) model = multiply(model, rotateZ(rz));
    model = multiply(model, scale(sx, sy, sz));
    draw(meshes[kind], color, model);
  }

  function buildTradingHall(time) {
    const pulse = 0.36 + (Math.sin(time * 0.0014) + 1) * 0.035;
    object('cylinder', [0.11, 0.18, 0.17], 0, -0.02, 0, 4.7, 0.2, 3.8);
    object('box', [0.17, 0.24, 0.22], 0, 0.16, 0, 3.9, 0.18, 3.05);
    object('box', [0.10, 0.16, 0.16], 0, 0.27, 0, 3.55, 0.08, 2.74);
    for (const [x, z] of [[-1.48, -0.95], [1.48, -0.95], [-1.48, 0.95], [1.48, 0.95]]) {
      object('cylinder', [0.33, 0.47, 0.38], x, 0.73, z, 0.13, 0.95, 0.13);
      object('sphere', [0.49, 0.68, 0.52], x, 1.24, z, 0.19, 0.12, 0.19);
    }
    object('box', [0.20, 0.32, 0.34], 0, 1.14, -1.13, 2.35, 1.08, 0.22);
    object('box', [0.10, 0.19, 0.21], 0, 1.16, -0.995, 2.05, 0.76, 0.055);
    object('box', [pulse, 0.75, 0.55], 0, 1.58, -0.95, 1.65, 0.035, 0.018);
    object('box', [0.33, 0.70, 0.73], 0, 1.12, -0.95, 0.05, 0.36, 0.022);
    object('box', [0.66, 0.48, 0.30], -1.12, 0.60, 0.42, 0.62, 0.09, 0.42);
    object('box', [0.66, 0.48, 0.30], 1.12, 0.60, 0.42, 0.62, 0.09, 0.42);
    object('box', [0.31, 0.62, 0.60], -1.12, 0.83, 0.34, 0.45, 0.36, 0.035, 0.08);
    object('box', [0.31, 0.62, 0.60], 1.12, 0.83, 0.34, 0.45, 0.36, 0.035, -0.08);
    object('cylinder', [0.63, 0.78, 0.50], 0, 0.39, 1.13, 0.34, 0.18, 0.34);
    object('sphere', [pulse, 0.83, 0.63], 0, 0.58, 1.13, 0.08, 0.08, 0.08);
  }

  function buildScene(scene, center, index) {
    const [x, z] = center, base = SCENE_COLORS[scene.sceneType] || SCENE_COLORS.commons;
    object('cylinder', [0.15, 0.22, 0.16], x, 0.05, z, 1.65, 0.22, 1.38);
    object('box', [0.31, 0.37, 0.29], x, 0.19, z, 1.28, 0.08, 1.05);
    const type = scene.sceneType;
    if (type === 'garden') {
      for (const [dx, dz, size] of [[-0.45, -0.2, 0.48], [0.36, -0.27, 0.56], [-0.25, 0.37, 0.42], [0.48, 0.35, 0.38]]) {
        object('cylinder', [0.31, 0.24, 0.14], x + dx, 0.42, z + dz, 0.13, 0.43, 0.13);
        object('sphere', [0.24, 0.52, 0.27], x + dx, 0.83 * size + 0.18, z + dz, size, size * 0.92, size);
      }
      object('box', base, x, 0.31, z, 0.63, 0.13, 0.53);
    } else if (type === 'observatory') {
      object('cylinder', base, x, 0.54, z, 0.92, 0.76, 0.92);
      object('sphere', [0.66, 0.77, 0.78], x, 1.0, z, 0.55, 0.48, 0.55);
      object('cylinder', [0.72, 0.82, 0.78], x, 1.12, z, 0.12, 0.76, 0.12, 0, 0.75);
    } else if (type === 'data_center') {
      object('box', base, x, 0.61, z, 0.93, 0.91, 0.83);
      for (let row = 0; row < 3; row += 1) for (let col = 0; col < 2; col += 1) {
        const color = (row + col) % 2 ? [0.36, 0.81, 0.88] : [0.31, 0.69, 0.79];
        object('box', color, x - 0.24 + col * 0.48, 0.34 + row * 0.25, z + 0.43, 0.25, 0.14, 0.035);
      }
      object('cone', [0.48, 0.78, 0.83], x, 1.14, z, 0.24, 0.27, 0.24);
    } else if (type === 'library') {
      object('box', base, x, 0.55, z, 0.9, 0.8, 0.78);
      object('cone', [0.38, 0.31, 0.23], x, 1.08, z, 0.72, 0.43, 0.66);
      for (let row = 0; row < 2; row += 1) object('box', [0.83, 0.73, 0.51], x - 0.08, 0.44 + row * 0.22, z + 0.41, 0.48, 0.035, 0.025);
    } else if (type === 'cafe') {
      object('box', [0.78, 0.68, 0.49], x, 0.48, z, 0.77, 0.61, 0.69);
      object('cone', base, x, 0.96, z, 1.0, 0.39, 0.9);
      object('cylinder', [0.84, 0.73, 0.47], x, 0.58, z + 0.39, 0.12, 0.36, 0.12);
    } else if (type === 'workshop') {
      object('box', base, x, 0.48, z, 0.88, 0.58, 0.75);
      object('cone', [0.35, 0.4, 0.37], x, 0.92, z, 0.75, 0.34, 0.68);
      object('cylinder', [0.6, 0.63, 0.53], x + 0.38, 0.92, z - 0.28, 0.13, 0.68, 0.13);
    } else if (type === 'studio') {
      object('box', base, x, 0.49, z, 0.8, 0.64, 0.72);
      object('box', [0.73, 0.83, 0.7], x, 0.53, z + 0.38, 0.44, 0.34, 0.035);
      object('cone', [0.78, 0.64, 0.43], x + 0.36, 0.93, z - 0.3, 0.33, 0.48, 0.32);
    } else {
      object('cylinder', base, x, 0.45, z, 0.91, 0.52, 0.91);
      object('sphere', [0.75, 0.84, 0.62], x, 0.88, z, 0.52, 0.35, 0.52);
      object('cone', [0.75, 0.84, 0.62], x, 1.1, z, 0.19, 0.34, 0.19);
    }
    object('sphere', [0.75, 0.88, 0.59], x - 0.58, 0.35, z + 0.37, 0.11, 0.11, 0.11);
    object('sphere', [0.75, 0.88, 0.59], x + 0.55, 0.35, z - 0.32, 0.09, 0.09, 0.09);
    return index;
  }

  function residentPosition(resident, center, order, total) {
    const [x, z] = center;
    const angle = (order / Math.max(total, 1)) * Math.PI * 2 - Math.PI / 2;
    const radius = total > 1 ? 1.35 : 0.9;
    return [x + Math.cos(angle) * radius, z + Math.sin(angle) * radius];
  }

  function buildResident(resident, position, selected, time, movement = null) {
    const [x, z] = position, main = colorFromHash(resident.id), accent = selected ? [0.82, 0.98, 0.42] : [0.82, 0.85, 0.68];
    const phase = (hash(resident.id) % 1000) / 1000 * Math.PI * 2;
    const walking = Boolean(movement && movement.progress < 1);
    const step = walking ? Math.sin(time * 0.012 + phase) * 0.32 : Math.sin(time * 0.0018 + phase) * 0.025;
    const bob = walking ? Math.abs(Math.sin(time * 0.012 + phase)) * 0.075 : Math.sin(time * 0.0022 + phase) * 0.025;
    const facing = movement?.facing || 0;
    object('cylinder', [0.22, 0.27, 0.21], x, 0.25, z, 0.36, 0.12, 0.36);
    object('cylinder', main, x, 0.55 + bob, z, 0.28, 0.48, 0.23, facing, walking ? -0.08 : 0);
    object('sphere', accent, x, 0.94 + bob, z, 0.27, 0.28, 0.27);
    object('sphere', [0.12, 0.16, 0.13], x + Math.sin(facing) * 0.23, 0.97 + bob, z + Math.cos(facing) * 0.23, 0.035, 0.035, 0.025);
    object('cylinder', main, x - 0.19, 0.53 + bob, z, 0.09, 0.34, 0.09, facing, -0.27 + step * 0.8);
    object('cylinder', main, x + 0.19, 0.53 + bob, z, 0.09, 0.34, 0.09, facing, 0.27 - step * 0.8);
    object('cylinder', [0.29, 0.34, 0.29], x - 0.08, 0.32 + bob * 0.35, z + (walking ? step * 0.22 : 0), 0.1, 0.32, 0.1, facing, walking ? step * 0.65 : 0);
    object('cylinder', [0.29, 0.34, 0.29], x + 0.08, 0.32 + bob * 0.35, z - (walking ? step * 0.22 : 0), 0.1, 0.32, 0.1, facing, walking ? -step * 0.65 : 0);
    const accessory = resident.archetype === 'naturalist' ? [0.36, 0.78, 0.42] : resident.archetype === 'scholar' ? [0.77, 0.67, 0.4] : resident.archetype === 'maker' ? [0.4, 0.72, 0.82] : [0.7, 0.65, 0.9];
    object('cone', accessory, x, 1.22, z, 0.22, 0.18, 0.22);
  }

  function layout(now = Date.now()) {
    const scenes = data?.scenes || [], residents = data?.residents || [];
    const centers = scenes.map((_, index) => {
      const angle = -Math.PI / 2 + (index / Math.max(scenes.length, 1)) * Math.PI * 2;
      const radius = scenes.length <= 1 ? 0 : 5.7;
      return [Math.cos(angle) * radius, Math.sin(angle) * radius * 0.77];
    });
    const sceneByName = new Map(scenes.map((scene, index) => [scene.name, index]));
    const groups = new Map(), destinationGroups = new Map();
    for (const resident of residents) {
      const bucket = groups.get(resident.location) || [];
      bucket.push(resident);
      groups.set(resident.location, bucket);
      if (resident.currentStatus === 'walking' && resident.targetLocation) {
        const target = destinationGroups.get(resident.targetLocation) || [];
        target.push(resident);
        destinationGroups.set(resident.targetLocation, target);
      }
    }
    for (const resident of residents) {
      if (resident.currentStatus === 'walking' || groups.has(resident.location) === false) continue;
      const target = destinationGroups.get(resident.location) || [];
      target.push(resident);
      destinationGroups.set(resident.location, target);
    }
    const centerFor = (place, order = 0) => {
      if (place === 'Exchange') return [0, 0];
      const index = sceneByName.get(place);
      if (index !== undefined && centers[index]) return centers[index];
      return [Math.cos(order * 2.4) * 1.5, Math.sin(order * 2.4) * 1.5];
    };
    const positionFor = (resident, place, buckets, fallbackOrder) => {
      const members = buckets.get(place) || [resident];
      const order = Math.max(0, members.findIndex((item) => item.id === resident.id));
      return residentPosition(resident, centerFor(place, fallbackOrder), order, members.length);
    };
    const placed = [];
    residents.forEach((resident, index) => {
      const from = positionFor(resident, resident.location, groups, index);
      if (resident.currentStatus !== 'walking' || !resident.targetLocation) {
        placed.push({ resident, position: from, movement: null });
        return;
      }
      const to = positionFor(resident, resident.targetLocation, destinationGroups, index);
      const started = Date.parse(resident.movementStartedAt || '');
      const ends = Date.parse(resident.movementEndsAt || '');
      const progress = !Number.isFinite(started) || !Number.isFinite(ends) || ends <= started
        ? 1 : Math.max(0, Math.min(1, (now - started) / (ends - started)));
      const eased = progress * progress * (3 - 2 * progress);
      const position = [from[0] + (to[0] - from[0]) * eased, from[1] + (to[1] - from[1]) * eased];
      placed.push({ resident, position, movement: { progress, facing: Math.atan2(to[0] - from[0], to[1] - from[1]) } });
    });
    return { centers, placed };
  }

  function activityFor(resident, now) {
    if (resident.currentStatus === 'walking') {
      const shortTarget = String(resident.targetLocation || '目标地点').replace(/^.+?'s\s+/, '');
      return { label: `前往 ${shortTarget}`, kind: 'travel' };
    }
    if (resident.currentStatus === 'performing') {
      const actions = { work: ['工作','work'], learn: ['学习','learn'], rest: ['休息','care'],
        eat: ['进食','care'], socialize: ['社交','socialize'], trade: ['交易','trade'] };
      const [label, kind] = actions[resident.currentAction] || ['行动中','work'];
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
    for (const scene of scenes) {
      const key = `scene:${scene.name}`; wanted.add(key);
      if (!labelNodes.has(key)) {
        const node = document.createElement('span'); node.className = 'world3d-scene-label';
        node.textContent = scene.name.replace(/^.+?'s\s+/, '');
        node.title = scene.name; node.setAttribute('aria-label', `场景 ${scene.name}`);
        labelsElement.append(node); labelNodes.set(key, node);
      }
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
    for (const [key, node] of labelNodes) if (!wanted.has(key)) { node.remove(); labelNodes.delete(key); }
  }

  function project(point, viewProjection, width, height) {
    const [x, y, z] = point;
    const clip = [
      viewProjection[0] * x + viewProjection[4] * y + viewProjection[8] * z + viewProjection[12],
      viewProjection[1] * x + viewProjection[5] * y + viewProjection[9] * z + viewProjection[13],
      viewProjection[2] * x + viewProjection[6] * y + viewProjection[10] * z + viewProjection[14],
      viewProjection[3] * x + viewProjection[7] * y + viewProjection[11] * z + viewProjection[15]
    ];
    if (clip[3] <= 0) return null;
    return [(clip[0] / clip[3] * 0.5 + 0.5) * width, (0.5 - clip[1] / clip[3] * 0.5) * height];
  }

  function frameWorld(time = performance.now()) {
    if (disposed) return;
    const rect = canvas.getBoundingClientRect(), ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * ratio)), height = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    gl.viewport(0, 0, width, height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(program);
    const target = [0, 0.3, 0], eye = [Math.sin(camera.yaw) * Math.cos(camera.pitch) * camera.distance, Math.sin(camera.pitch) * camera.distance, Math.cos(camera.yaw) * Math.cos(camera.pitch) * camera.distance];
    const viewProjection = multiply(perspective(0.72, width / height, 0.1, 80), lookAt(eye, target));
    gl.uniformMatrix4fv(locations.viewProjection, false, viewProjection);
    object('cylinder', [0.17, 0.28, 0.19], 0, -0.35, 0, 9.3, 0.72, 7.4);
    object('cylinder', [0.29, 0.37, 0.25], 0, 0.02, 0, 8.95, 0.12, 7.0);
    for (let index = 0; index < 12; index += 1) {
      const angle = index * Math.PI / 6, radius = 8.5;
      object('sphere', index % 2 ? [0.31, 0.48, 0.29] : [0.37, 0.52, 0.3], Math.cos(angle) * radius, 0.12, Math.sin(angle) * radius * 0.78, 0.38, 0.48, 0.34);
    }
    const { centers, placed } = layout(Date.now());
    for (let index = 0; index < centers.length; index += 1) {
      const center = centers[index], scene = data.scenes[index];
      if (index > 0 && centers.length > 1) {
        const previous = centers[index - 1];
        const midX = (center[0] + previous[0]) / 2, midZ = (center[1] + previous[1]) / 2;
        const length = Math.hypot(center[0] - previous[0], center[1] - previous[1]);
        object('box', [0.42, 0.48, 0.36], midX, 0.13, midZ, length + 0.2, 0.04, 0.26, Math.atan2(center[1] - previous[1], center[0] - previous[0]));
      }
      buildScene(scene, center, index);
      const label = labelNodes.get(`scene:${scene.name}`), projected = project([center[0], 1.7, center[1]], viewProjection, rect.width, rect.height);
      if (label && projected) { label.style.left = `${projected[0]}px`; label.style.top = `${projected[1]}px`; label.hidden = false; }
      else if (label) label.hidden = true;
    }
    buildTradingHall(time);
    const marketLabel = labelNodes.get('market');
    const marketPoint = project([0, 2.06, -0.91], viewProjection, rect.width, rect.height);
    if (marketLabel && marketPoint) { marketLabel.style.left = `${marketPoint[0]}px`; marketLabel.style.top = `${marketPoint[1]}px`; marketLabel.hidden = false; }
    else if (marketLabel) marketLabel.hidden = true;
    projectedResidents = [];
    for (const item of placed) {
      const selected = item.resident.id === selectedId;
      const position = item.position;
      buildResident(item.resident, position, selected, time, item.movement);
      const point = project([position[0], 1.68, position[1]], viewProjection, rect.width, rect.height);
      const node = labelNodes.get(`resident:${item.resident.id}`);
      if (node && point) { node.style.left = `${point[0]}px`; node.style.top = `${point[1]}px`; node.hidden = false; }
      else if (node) node.hidden = true;
      if (point) projectedResidents.push({ id: item.resident.id, x: point[0], y: point[1] });
    }
  }

  const invalidate = () => {
    if (disposed || frame) return;
    frame = window.requestAnimationFrame((time) => {
      frame = 0;
      if (document.visibilityState !== 'visible' || !inViewport) return;
      if (time - lastDrawAt < 32) { invalidate(); return; }
      lastDrawAt = time;
      frameWorld(time);
      if (data && !reducedMotion?.matches) invalidate();
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
  intersectionObserver?.observe(canvas);
  invalidate();
  canvas.addEventListener('pointerdown', event => {
    drag = { x: event.clientX, y: event.clientY, moved: false };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', event => {
    if (!drag) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
    camera.yaw += dx * 0.009; camera.pitch = Math.max(0.3, Math.min(1.23, camera.pitch + dy * 0.006));
    drag.x = event.clientX; drag.y = event.clientY;
    invalidate();
  });
  canvas.addEventListener('pointerup', event => {
    if (!drag) return;
    if (!drag.moved) {
      const rect = canvas.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
      let nearest = null, distance = 38;
      for (const item of projectedResidents) { const current = Math.hypot(item.x - x, item.y - y); if (current < distance) { nearest = item; distance = current; } }
      if (nearest) onSelect(nearest.id);
    }
    drag = null;
    invalidate();
  });
  canvas.addEventListener('pointercancel', () => { drag = null; });
  canvas.addEventListener('wheel', event => { event.preventDefault(); camera.distance = Math.max(15, Math.min(38, camera.distance + Math.sign(event.deltaY) * 1.4)); invalidate(); }, { passive: false });
  canvas.addEventListener('keydown', event => {
    const residents = data?.residents || [];
    if (!residents.length || !['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Enter'].includes(event.key)) return;
    event.preventDefault();
    const index = residents.findIndex(resident => resident.id === selectedId);
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
      ensureLabels(data.scenes || [], data.residents || []);
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
    }
  };
}

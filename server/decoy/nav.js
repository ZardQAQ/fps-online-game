// 假人导航：带碰撞余量的网格 A* + 视线拉直，避免贴墙夹缝卡死
'use strict';
const { MAP } = require('../config');

const HALF = MAP.half - 1.5;
const CELL = 1.25;
const AGENT_R = 0.7;           // 假人水平半径余量（略大于真实体）
const EDGE_PAD = AGENT_R + 0.35;
const MIN_BLOCK_H = 1.0;
const RAMP_PAD = AGENT_R + 0.9;
const BARREL_PAD = (MAP.barrelR || 0.85) + AGENT_R + 0.55;
const WALL_COST = 0.55;        // 贴障碍格子额外代价，逼路径走开阔地
const MAX_NODES = 6000;

// 中央/中场易卡死区域整片禁走
const FORBIDDEN_ZONES = [
  { minx: -11, maxx: 16, minz: -11, maxz: 24 },
  { minx: -20, maxx: -8, minz: -14, maxz: 12 },
  { minx: 12, maxx: 28, minz: -28, maxz: -11 },
  { minx: -28, maxx: -11, minz: 6, maxz: 22 },
];

const boxes = MAP.obstacles.map(o => ({
  minx: o.x - o.w / 2 - AGENT_R,
  maxx: o.x + o.w / 2 + AGENT_R,
  minz: o.z - o.d / 2 - AGENT_R,
  maxz: o.z + o.d / 2 + AGENT_R,
  h: o.h,
  kind: o.kind || '',
}));

const rampZones = (MAP.ramps || []).map(r => {
  if (r.axis === 'x') {
    return {
      minx: r.x - r.len / 2 - RAMP_PAD,
      maxx: r.x + r.len / 2 + RAMP_PAD,
      minz: r.z - r.w / 2 - RAMP_PAD,
      maxz: r.z + r.w / 2 + RAMP_PAD,
    };
  }
  return {
    minx: r.x - r.w / 2 - RAMP_PAD,
    maxx: r.x + r.w / 2 + RAMP_PAD,
    minz: r.z - r.len / 2 - RAMP_PAD,
    maxz: r.z + r.len / 2 + RAMP_PAD,
  };
});

const barrelZones = (MAP.barrels || []).map(b => ({
  x: b.x, z: b.z, r2: BARREL_PAD * BARREL_PAD,
}));

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

function isGroundBlocker(b) {
  if (b.kind === 'platform' || b.kind === 'rampslice') return true;
  return b.h >= MIN_BLOCK_H;
}

function inZone(x, z, zr) {
  return x > zr.minx && x < zr.maxx && z > zr.minz && z < zr.maxz;
}

function solidAt(x, z) {
  if (x < -HALF + EDGE_PAD || x > HALF - EDGE_PAD || z < -HALF + EDGE_PAD || z > HALF - EDGE_PAD) return true;
  for (const zr of FORBIDDEN_ZONES) {
    if (inZone(x, z, zr)) return true;
  }
  for (const b of barrelZones) {
    const dx = x - b.x, dz = z - b.z;
    if (dx * dx + dz * dz < b.r2) return true;
  }
  for (const zr of rampZones) {
    if (inZone(x, z, zr)) return true;
  }
  for (const b of boxes) {
    if (!isGroundBlocker(b)) continue;
    if (x > b.minx && x < b.maxx && z > b.minz && z < b.maxz) return true;
  }
  return false;
}

/** 世界坐标是否不可走（含禁区/障碍余量） */
function blockedAt(x, z) {
  return solidAt(x, z);
}

const COLS = Math.floor((HALF * 2) / CELL);
const ROWS = COLS;
const ORIGIN = -HALF;

function inBounds(gx, gz) {
  return gx >= 0 && gx < COLS && gz >= 0 && gz < ROWS;
}

function toGrid(x, z) {
  return {
    gx: clamp(Math.floor((x - ORIGIN) / CELL), 0, COLS - 1),
    gz: clamp(Math.floor((z - ORIGIN) / CELL), 0, ROWS - 1),
  };
}

function toWorld(gx, gz) {
  return {
    x: ORIGIN + (gx + 0.5) * CELL,
    z: ORIGIN + (gz + 0.5) * CELL,
  };
}

// 格心 + 四角采样，避免「格心能走、边缘贴墙」的假可走
function cellBlocked(gx, gz) {
  const { x, z } = toWorld(gx, gz);
  const o = CELL * 0.32;
  return solidAt(x, z)
    || solidAt(x + o, z + o) || solidAt(x + o, z - o)
    || solidAt(x - o, z + o) || solidAt(x - o, z - o);
}

const blockedCache = new Uint8Array(COLS * ROWS);
const nearWall = new Uint8Array(COLS * ROWS);

for (let gz = 0; gz < ROWS; gz++) {
  for (let gx = 0; gx < COLS; gx++) {
    blockedCache[gz * COLS + gx] = cellBlocked(gx, gz) ? 1 : 0;
  }
}
for (let gz = 0; gz < ROWS; gz++) {
  for (let gx = 0; gx < COLS; gx++) {
    if (blockedCache[gz * COLS + gx]) continue;
    let near = 0;
    for (let dz = -1; dz <= 1 && !near; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const nx = gx + dx, nz = gz + dz;
        if (!inBounds(nx, nz) || blockedCache[nz * COLS + nx]) { near = 1; break; }
      }
    }
    nearWall[gz * COLS + gx] = near;
  }
}

function isBlocked(gx, gz) {
  if (!inBounds(gx, gz)) return true;
  return blockedCache[gz * COLS + gx] === 1;
}

/** 两点之间直线是否畅通（逐步采样） */
function clearLos(x0, z0, x1, z1) {
  const dx = x1 - x0, dz = z1 - z0;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-4) return !solidAt(x0, z0);
  const steps = Math.max(2, Math.ceil(dist / (CELL * 0.4)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (solidAt(x0 + dx * t, z0 + dz * t)) return false;
  }
  return true;
}

function nearestWalkable(gx, gz, maxR = 24) {
  if (inBounds(gx, gz) && !isBlocked(gx, gz)) return { gx, gz };
  for (let r = 1; r <= maxR; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
        const nx = gx + dx, nz = gz + dz;
        if (inBounds(nx, nz) && !isBlocked(nx, nz)) return { gx: nx, gz: nz };
      }
    }
  }
  return null;
}

function nearestWalkableWorld(x, z) {
  const g = toGrid(x, z);
  if (!isBlocked(g.gx, g.gz) && !solidAt(x, z)) return { x, z };
  const near = nearestWalkable(g.gx, g.gz);
  if (!near) return null;
  return toWorld(near.gx, near.gz);
}

/** 把目标钳到可走点；优先开阔格 */
function clampGoal(x, z) {
  const g = toGrid(x, z);
  let best = null;
  let bestScore = Infinity;
  const maxR = 20;
  for (let r = 0; r <= maxR; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (r > 0 && Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
        const nx = g.gx + dx, nz = g.gz + dz;
        if (!inBounds(nx, nz) || isBlocked(nx, nz)) continue;
        const w = toWorld(nx, nz);
        const d = Math.hypot(w.x - x, w.z - z) + (nearWall[nz * COLS + nx] ? 2.5 : 0);
        if (d < bestScore) {
          bestScore = d;
          best = w;
        }
      }
    }
    if (best && r >= 2) break;
  }
  return best;
}

// ---------- 二叉堆 A* ----------
function heapPush(h, node) {
  h.push(node);
  let i = h.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (h[p].f <= h[i].f) break;
    const t = h[p]; h[p] = h[i]; h[i] = t;
    i = p;
  }
}

function heapPop(h) {
  const top = h[0];
  const last = h.pop();
  if (!h.length) return top;
  h[0] = last;
  let i = 0;
  for (;;) {
    let s = i;
    const l = i * 2 + 1, r = l + 1;
    if (l < h.length && h[l].f < h[s].f) s = l;
    if (r < h.length && h[r].f < h[s].f) s = r;
    if (s === i) break;
    const t = h[i]; h[i] = h[s]; h[s] = t;
    i = s;
  }
  return top;
}

const NEIGH = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414],
];

function heuristic(gx, gz, tx, tz) {
  const dx = Math.abs(gx - tx);
  const dz = Math.abs(gz - tz);
  return Math.max(dx, dz) + 0.414 * Math.min(dx, dz);
}

function reconstruct(cameFrom, cur) {
  const nodes = [];
  while (cur >= 0) {
    nodes.push({ gx: cur % COLS, gz: (cur / COLS) | 0 });
    cur = cameFrom[cur];
  }
  nodes.reverse();
  const raw = [];
  for (let i = 1; i < nodes.length; i++) raw.push(toWorld(nodes[i].gx, nodes[i].gz));
  return smoothPath(raw);
}

/** 视线拉直：能直达的中间点全部丢掉 */
function smoothPath(pts) {
  if (!pts || pts.length <= 1) return pts && pts.length ? pts : null;
  const out = [pts[0]];
  let anchor = 0;
  while (anchor < pts.length - 1) {
    let farthest = anchor + 1;
    for (let j = pts.length - 1; j > anchor + 1; j--) {
      if (clearLos(pts[anchor].x, pts[anchor].z, pts[j].x, pts[j].z)) {
        farthest = j;
        break;
      }
    }
    out.push(pts[farthest]);
    anchor = farthest;
  }
  return out;
}

function findPath(x0, z0, x1, z1, maxNodes = MAX_NODES) {
  const startW = nearestWalkableWorld(x0, z0) || { x: x0, z: z0 };
  const goalW = clampGoal(x1, z1);
  if (!goalW) return null;

  // 近距离且视线通：直接走
  if (clearLos(startW.x, startW.z, goalW.x, goalW.z)) {
    return [{ x: goalW.x, z: goalW.z }];
  }

  const start = toGrid(startW.x, startW.z);
  const goal = toGrid(goalW.x, goalW.z);
  const sn = nearestWalkable(start.gx, start.gz);
  const gn = nearestWalkable(goal.gx, goal.gz);
  if (!sn || !gn) return null;
  start.gx = sn.gx; start.gz = sn.gz;
  goal.gx = gn.gx; goal.gz = gn.gz;

  const startK = start.gz * COLS + start.gx;
  const goalK = goal.gz * COLS + goal.gx;
  if (startK === goalK) return [{ x: goalW.x, z: goalW.z }];

  const gScore = new Float32Array(COLS * ROWS);
  gScore.fill(Infinity);
  const cameFrom = new Int32Array(COLS * ROWS);
  cameFrom.fill(-1);
  const closed = new Uint8Array(COLS * ROWS);
  const open = [];
  gScore[startK] = 0;
  heapPush(open, { k: startK, f: heuristic(start.gx, start.gz, goal.gx, goal.gz) });

  let nodes = 0;
  while (open.length && nodes++ < maxNodes) {
    const curN = heapPop(open);
    const cur = curN.k;
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (cur === goalK) {
      const path = reconstruct(cameFrom, cur);
      if (path && path.length) {
        // 终点用精确钳制坐标
        path[path.length - 1] = { x: goalW.x, z: goalW.z };
      }
      return path;
    }

    const cgx = cur % COLS;
    const cgz = (cur / COLS) | 0;

    for (const [dx, dz, step] of NEIGH) {
      const ngx = cgx + dx;
      const ngz = cgz + dz;
      if (!inBounds(ngx, ngz) || isBlocked(ngx, ngz)) continue;
      // 禁止贴角穿墙
      if (dx !== 0 && dz !== 0) {
        if (isBlocked(cgx + dx, cgz) || isBlocked(cgx, cgz + dz)) continue;
      }
      const nk = ngz * COLS + ngx;
      if (closed[nk]) continue;
      const extra = nearWall[nk] ? WALL_COST : 0;
      const tg = gScore[cur] + step + extra;
      if (tg >= gScore[nk]) continue;
      cameFrom[nk] = cur;
      gScore[nk] = tg;
      heapPush(open, { k: nk, f: tg + heuristic(ngx, ngz, goal.gx, goal.gz) });
    }
  }
  return null;
}

/**
 * 朝目标迈一步：若直线下一步撞障碍，尝试左右滑行
 * 返回下一步世界坐标
 */
function steerStep(x, z, tx, tz, stepLen) {
  const dx = tx - x, dz = tz - z;
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len, uz = dz / len;
  const candidates = [
    { x: x + ux * stepLen, z: z + uz * stepLen },
    { x: x + (-uz) * stepLen * 0.9 + ux * stepLen * 0.35, z: z + ux * stepLen * 0.9 + uz * stepLen * 0.35 },
    { x: x + uz * stepLen * 0.9 + ux * stepLen * 0.35, z: z + (-ux) * stepLen * 0.9 + uz * stepLen * 0.35 },
    { x: x + (-uz) * stepLen, z: z + ux * stepLen },
    { x: x + uz * stepLen, z: z + (-ux) * stepLen },
  ];
  for (const c of candidates) {
    const nx = clamp(c.x, -HALF + EDGE_PAD, HALF - EDGE_PAD);
    const nz = clamp(c.z, -HALF + EDGE_PAD, HALF - EDGE_PAD);
    if (!solidAt(nx, nz) && clearLos(x, z, nx, nz)) return { x: nx, z: nz };
  }
  const esc = nearestWalkableWorld(x, z);
  return esc || { x, z };
}

module.exports = {
  findPath, toWorld, isBlocked, blockedAt, nearestWalkableWorld,
  clampGoal, clearLos, steerStep, solidAt,
  CELL, HALF, FORBIDDEN_ZONES, AGENT_R,
};

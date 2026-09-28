// ---------- Diggame Server v2.0 ----------
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---------- Configuration ----------
const CONFIG = {
  WORLD_WIDTH: 50,
  DIG_TIME_MS: 900,
  SHOVEL_DIG_TIME: 200,
  SHOVEL_DURATION: 60000,
  STUCK_DURATION: 60000,
  SHARE_DISCOVERIES: false,
  RESET_SECRET: 'changeme123', // Change this in production!
};

// ---------- World Generation ----------
let worldSeed = Math.floor(Math.random() * 1000000);

function hashCoord(x, y) {
  let h = worldSeed ^ (x * 374761393) ^ ((y + 100000) * 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

function getBaseBlock(x, y) {
  if (x < 0 || x >= CONFIG.WORLD_WIDTH) return null;
  if (y < 0) return { type: 'air' };
  if (y === 0) return { type: 'dirt' };
  const r = (hashCoord(x, y) % 10000) / 10000;
  const stoneChance = Math.min(0.35, 0.02 + y * 0.003);
  const spikeChance = Math.min(0.09, 0.005 + y * 0.0008);
  if (r < stoneChance) return { type: 'stone' };
  if (r < stoneChance + spikeChance) return { type: 'spikes' };
  return { type: 'dirt' };
}

// ---------- Game State ----------
const players = new Map();
const accounts = new Map();
const playerStats = new Map(); // Persistent stats across resets
const traps = new Map();
const digging = new Map();
let nextId = 1;
let globalMaxDepth = 0;
const dugBlocks = new Set();
const dugItems = {};

function genCode() {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

function key(x, y) { return x + ',' + y; }

function neighbors4(x, y) {
  return [[x-1,y],[x+1,y],[x,y-1],[x,y+1]];
}

function neighbors8(x, y) {
  const out = [];
  for (let dx=-1; dx<=1; dx++) for (let dy=-1; dy<=1; dy++)
    if (dx||dy) out.push([x+dx, y+dy]);
  return out;
}

function updateMaxDepth() {
  let m = 0;
  for (const p of players.values()) m = Math.max(m, p.maxDepth || 0);
  globalMaxDepth = m;
}

function rollItemFor(diggerDepth) {
  const deficit = Math.max(0, globalMaxDepth - diggerDepth);
  const baseChance = 0.06 + Math.min(0.25, deficit * 0.015);
  if (Math.random() >= baseChance) return null;
  const r = Math.random();
  if (r < 0.30) return 'armor';
  if (r < 0.60) return 'shovel';
  if (r < 0.80) return 'dynamite';
  return 'trap';
}

// ---------- Player Management ----------
function createPlayer(code, name, modelIndex) {
  const id = nextId++;
  let x = Math.floor(Math.random() * CONFIG.WORLD_WIDTH);
  for (let tries = 0; tries < CONFIG.WORLD_WIDTH; tries++) {
    const cx = (x + tries) % CONFIG.WORLD_WIDTH;
    if (!playerAt(cx, 0)) { x = cx; break; }
  }
  
  const stats = playerStats.get(code) || { maxDepth: 0, deaths: 0, itemsCollected: 0 };
  
  const p = {
    id, code, name, modelIndex: modelIndex ?? 0,
    x, y: 0,
    maxDepth: 0,
    discovered: new Set(),
    inventory: { armor: 0, shovelUntil: 0, dynamite: 0, trap: 0 },
    stuckUntil: 0,
    alive: true,
    stats,
  };
  
  for (let xx = 0; xx < CONFIG.WORLD_WIDTH; xx++) {
    p.discovered.add(key(xx, 0));
    p.discovered.add(key(xx, -1));
  }
  
  players.set(id, p);
  updateMaxDepth();
  return p;
}

function playerAt(x, y) {
  for (const p of players.values())
    if (p.alive && p.x === x && p.y === y) return p;
  return null;
}

function revealAround(player, x, y) {
  const newlyDiscovered = [];
  for (const [nx, ny] of neighbors4(x, y)) {
    const k = key(nx, ny);
    if (!player.discovered.has(k)) {
      player.discovered.add(k);
      newlyDiscovered.push(k);
    }
  }
  const here = key(x, y);
  if (!player.discovered.has(here)) {
    player.discovered.add(here);
    newlyDiscovered.push(here);
  }
  return newlyDiscovered;
}

// ---------- State Hashing ----------
function computeStateHash(player) {
  const stateObj = {
    x: player.x,
    y: player.y,
    alive: player.alive,
    armor: player.inventory.armor,
    dynamite: player.inventory.dynamite,
    trap: player.inventory.trap,
    shovelUntil: player.inventory.shovelUntil,
    stuckUntil: player.stuckUntil,
    blocks: [...player.discovered].sort().join('|'),
  };
  const json = JSON.stringify(stateObj);
  return crypto.createHash('md5').update(json).digest('hex');
}

function getFullState(player) {
  const blocks = {};
  for (const k of player.discovered) {
    const [x, y] = k.split(',').map(Number);
    const b = getBaseBlock(x, y);
    if (!b) continue;
    const isDug = dugBlocks.has(k);
    blocks[k] = {
      type: isDug ? 'air' : b.type,
      item: isDug ? (dugItems[k] || null) : null,
    };
  }
  
  return {
    you: {
      x: player.x, y: player.y, alive: player.alive,
      stuck: Date.now() < player.stuckUntil,
      stuckUntil: player.stuckUntil,
      shovelUntil: player.inventory.shovelUntil,
      armor: player.inventory.armor,
      dynamite: player.inventory.dynamite,
      trap: player.inventory.trap,
      stats: player.stats,
    },
    blocks,
    players: [...players.values()].map(serializePlayer),
    digging: digging.has(player.id) ? {
      x: digging.get(player.id).x,
      y: digging.get(player.id).y,
      progress: Math.min(1, (Date.now() - digging.get(player.id).startedAt) / digging.get(player.id).duration),
    } : null,
  };
}

function serializePlayer(p) {
  return {
    id: p.id, name: p.name, model: p.modelIndex,
    x: p.x, y: p.y, alive: p.alive,
    stuck: Date.now() < p.stuckUntil,
  };
}

// ---------- Actions ----------
function tryMove(player, dx, dy) {
  if (!player.alive) return { success: false, error: 'dead' };
  if (Date.now() < player.stuckUntil) return { success: false, error: 'stuck' };
  
  const nx = player.x + dx, ny = player.y + dy;
  const target = getBaseBlock(nx, ny);
  if (!target) return { success: false, error: 'wall' };
  
  const trapKey = key(nx, ny);
  const trap = traps.get(trapKey);
  if (trap && trap.ownerId !== player.id) {
    traps.delete(trapKey);
    player.stuckUntil = Date.now() + CONFIG.STUCK_DURATION;
    io.to(player.id).emit('msg', { text: 'You stepped in a bear trap! Stuck 60s.', kind: 'bad' });
    io.emit('trapTriggered', { x: nx, y: ny });
    return { success: false, error: 'trapped' };
  }
  
  if (target.type === 'air') {
    if (playerAt(nx, ny)) return { success: false, error: 'occupied' };
    player.x = nx; player.y = ny;
    if (ny > player.maxDepth) {
      player.maxDepth = ny;
      player.stats.maxDepth = Math.max(player.stats.maxDepth, ny);
    }
    updateMaxDepth();
    const newlyDiscovered = revealAround(player, nx, ny);
    return { success: true, changes: { moved: true, newlyDiscovered } };
  }
  else if (target.type === 'stone') {
    return { success: false, error: 'stone' };
  }
  else if (target.type === 'spikes') {
    killPlayer(player, 'spikes');
    return { success: false, error: 'died' };
  }
  else if (target.type === 'dirt') {
    if (digging.has(player.id)) return { success: false, error: 'already_digging' };
    const duration = (Date.now() < player.inventory.shovelUntil) ? CONFIG.SHOVEL_DIG_TIME : CONFIG.DIG_TIME_MS;
    digging.set(player.id, { x: nx, y: ny, startedAt: Date.now(), duration });
    return { success: true, changes: { digging: { x: nx, y: ny, duration } } };
  }
  
  return { success: false, error: 'unknown' };
}

function finishDig(player) {
  const d = digging.get(player.id);
  if (!d) return;
  digging.delete(player.id);
  const b = getBaseBlock(d.x, d.y);
  if (!b || b.type !== 'dirt') return;
  
  const item = rollItemFor(player.maxDepth);
  dugBlocks.add(key(d.x, d.y));
  dugItems[key(d.x, d.y)] = item;
  
  if (playerAt(d.x, d.y)) {
    killPlayer(player, 'occupied');
    return;
  }
  
  player.x = d.x; player.y = d.y;
  if (d.y > player.maxDepth) {
    player.maxDepth = d.y;
    player.stats.maxDepth = Math.max(player.stats.maxDepth, d.y);
  }
  updateMaxDepth();
  
  const newlyDiscovered = revealAround(player, d.x, d.y);
  
  if (item) {
    if (item === 'shovel') player.inventory.shovelUntil = Date.now() + CONFIG.SHOVEL_DURATION;
    else if (item === 'armor') player.inventory.armor += 1;
    else if (item === 'dynamite') player.inventory.dynamite += 1;
    else if (item === 'trap') player.inventory.trap += 1;
    player.stats.itemsCollected += 1;
    player.socket.emit('item', { item });
  }
  
  io.emit('blockDug', { x: d.x, y: d.y, item });
  
  return { moved: true, newlyDiscovered, dug: { x: d.x, y: d.y, item } };
}

function killPlayer(player, reason) {
  player.alive = false;
  player.stats.deaths += 1;
  player.socket.emit('died', { reason });
  
  setTimeout(() => {
    let x = Math.floor(Math.random() * CONFIG.WORLD_WIDTH);
    for (let t = 0; t < CONFIG.WORLD_WIDTH; t++) {
      const cx = (x + t) % CONFIG.WORLD_WIDTH;
      if (!playerAt(cx, 0)) { x = cx; break; }
    }
    player.x = x; player.y = 0;
    player.alive = true;
    player.stuckUntil = 0;
    revealAround(player, x, 0);
    player.socket.emit('respawned', { x, y: 0 });
  }, 1500);
}

function useDynamite(player) {
  if (player.inventory.dynamite <= 0) return { success: false, error: 'no_dynamite' };
  player.inventory.dynamite--;
  
  const destroyed = [];
  for (const [dx, dy] of neighbors8(player.x, player.y)) {
    const b = getBaseBlock(dx, dy);
    if (!b || b.type === 'air') continue;
    const k = key(dx, dy);
    if (dugBlocks.has(k)) continue;
    dugBlocks.add(k);
    dugItems[k] = null;
    traps.delete(k);
    destroyed.push({ x: dx, y: dy });
    io.emit('blockDug', { x: dx, y: dy, item: null });
  }
  
  io.emit('boom', { x: player.x, y: player.y });
  return { success: true, changes: { destroyed } };
}

function placeTrap(player) {
  if (player.inventory.trap <= 0) return { success: false, error: 'no_trap' };
  player.inventory.trap--;
  traps.set(key(player.x, player.y), { ownerId: player.id });
  return { success: true, changes: { trapPlaced: true } };
}

// ---------- Game Reset ----------
function resetGame() {
  dugBlocks.clear();
  for (const k in dugItems) delete dugItems[k];
  traps.clear();
  digging.clear();
  globalMaxDepth = 0;
  worldSeed = Math.floor(Math.random() * 1000000);
  
  for (const p of players.values()) {
    let x = Math.floor(Math.random() * CONFIG.WORLD_WIDTH);
    for (let t = 0; t < CONFIG.WORLD_WIDTH; t++) {
      const cx = (x + t) % CONFIG.WORLD_WIDTH;
      if (!playerAt(cx, 0)) { x = cx; break; }
    }
    p.x = x; p.y = 0;
    p.maxDepth = 0;
    p.discovered.clear();
    for (let xx = 0; xx < CONFIG.WORLD_WIDTH; xx++) {
      p.discovered.add(key(xx, 0));
      p.discovered.add(key(xx, -1));
    }
    p.inventory = { armor: 0, shovelUntil: 0, dynamite: 0, trap: 0 };
    p.stuckUntil = 0;
    p.alive = true;
  }
  
  io.emit('gameReset', { seed: worldSeed });
}

// ---------- Socket Handling ----------
io.on('connection', (socket) => {
  socket.playerId = null;
  
  socket.on('login', (data, ack) => {
    let code = (data && data.code) || null;
    let name = (data && data.name) || null;
    let modelIndex = (data && data.modelIndex) || 0;
    
    if (code && accounts.has(code)) {
      const acc = accounts.get(code);
      name = name || acc.name;
      modelIndex = acc.modelIndex;
    } else {
      if (!name || name.length === 0) { ack({ error: 'Name required' }); return; }
      if (!code) code = genCode();
      accounts.set(code, { name, modelIndex });
    }
    
    for (const p of players.values()) {
      if (p.code === code) {
        p.socket.emit('kicked', { reason: 'Logged in elsewhere' });
        players.delete(p.id);
      }
    }
    
    const p = createPlayer(code, name, modelIndex);
    p.socket = socket;
    socket.playerId = p.id;
    
    const fullState = getFullState(p);
    const hash = computeStateHash(p);
    ack({ ok: true, code, name, modelIndex, state: fullState, hash });
  });
  
  socket.on('action', (data, ack) => {
    const player = players.get(socket.playerId);
    if (!player) { ack({ error: 'not_logged_in' }); return; }
    
    const clientHash = data.hash;
    const serverHash = computeStateHash(player);
    
    if (clientHash !== serverHash) {
      const fullState = getFullState(player);
      ack({ sync: true, state: fullState, hash: serverHash });
      return;
    }
    
    let result;
    if (data.action === 'move') {
      const dirs = { up:[0,-1], down:[0,1], left:[-1,0], right:[1,0] };
      const d = dirs[data.dir];
      if (!d) { ack({ error: 'invalid_dir' }); return; }
      digging.delete(player.id);
      result = tryMove(player, d[0], d[1]);
    }
    else if (data.action === 'useDynamite') {
      result = useDynamite(player);
    }
    else if (data.action === 'placeTrap') {
      result = placeTrap(player);
    }
    else {
      ack({ error: 'unknown_action' });
      return;
    }
    
    if (!result.success) {
      ack({ success: false, error: result.error });
      return;
    }
    
    const newHash = computeStateHash(player);
    ack({ success: true, changes: result.changes, hash: newHash });
  });
  
  socket.on('setModel', (modelIndex) => {
    const p = players.get(socket.playerId);
    if (!p) return;
    p.modelIndex = modelIndex | 0;
    accounts.get(p.code).modelIndex = p.modelIndex;
  });
  
  socket.on('spectate', () => {
    socket.isSpectator = true;
    socket.emit('spectatorMode', { width: CONFIG.WORLD_WIDTH });
    sendSpectatorFrame(socket);
  });
  
  socket.on('disconnect', () => {
    const p = players.get(socket.playerId);
    if (p) players.delete(p.id);
  });
});

function sendSpectatorFrame(socket) {
  const blocks = {};
  const seen = new Set();
  for (const p of players.values()) {
    for (const k of p.discovered) seen.add(k);
  }
  for (const k of dugBlocks) seen.add(k);
  for (const k of seen) {
    const [x, y] = k.split(',').map(Number);
    const b = getBaseBlock(x, y);
    if (!b) continue;
    const isDug = dugBlocks.has(k);
    blocks[k] = { type: isDug ? 'air' : b.type, item: isDug ? (dugItems[k] || null) : null };
  }
  socket.emit('spectatorFrame', {
    blocks,
    players: [...players.values()].map(serializePlayer),
    traps: [...traps.entries()].map(([k, v]) => ({ k, ownerId: v.ownerId })),
  });
}

setInterval(() => {
  for (const s of io.sockets.sockets.values()) {
    if (s.isSpectator) sendSpectatorFrame(s);
  }
}, 250);

setInterval(() => {
  for (const [pid, d] of digging.entries()) {
    if (Date.now() - d.startedAt >= d.duration) {
      const p = players.get(pid);
      if (p) finishDig(p);
    }
  }
}, 100);

// ---------- Admin Endpoints ----------
app.post('/api/reset', (req, res) => {
  const secret = req.query.secret;
  if (secret !== CONFIG.RESET_SECRET) {
    res.status(403).json({ error: 'Invalid secret' });
    return;
  }
  resetGame();
  res.json({ success: true, message: 'Game reset' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Diggame v2.0 running on http://localhost:${PORT}`));

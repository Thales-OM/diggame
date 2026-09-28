const socket = io();
const TILE = 32;

const state = {
  me: null,
  blocks: {},
  players: [],
  digging: null,
  code: null,
  name: null,
  model: 0,
  spectator: false,
  specBlocks: {},
  specPlayers: [],
  specTraps: [],
  specWidth: 50,
  camera: { x: 0, y: 0 },
  hash: null,
};

const MODELS = [
  { body:'#e55', hat:null },
  { body:'#59f', hat:'#fc0' },
  { body:'#6c6', hat:'#fff' },
  { body:'#c6f', hat:'#000' },
  { body:'#fa0', hat:'#333' },
];

const loginEl = document.getElementById('login');
const gameEl  = document.getElementById('game');
const specEl  = document.getElementById('spectator');

(function prefill() {
  const m = document.cookie.match(/digcode=([A-Z0-9]+)/);
  if (m) document.getElementById('codeInput').value = m[1];
})();

document.getElementById('loginBtn').onclick = () => {
  const name = document.getElementById('nameInput').value.trim();
  const code = document.getElementById('codeInput').value.trim().toUpperCase();
  if (!name && !code) {
    document.getElementById('loginErr').textContent = 'Enter a name or your code.';
    return;
  }
  socket.emit('login', { name, code, modelIndex: state.model }, (res) => {
    if (res.error) { document.getElementById('loginErr').textContent = res.error; return; }
    state.code = res.code;
    state.name = res.name;
    state.model = res.modelIndex;
    state.hash = res.hash;
    applyState(res.state);
    document.cookie = `digcode=${res.code}; max-age=${60*60*24*180}; path=/`;
    loginEl.classList.add('hidden');
    gameEl.classList.remove('hidden');
    document.getElementById('pName').textContent = res.name;
    document.getElementById('pCode').textContent = res.code;
    buildModelPicker();
    resizeCanvas();
  });
};

function applyState(s) {
  state.me = s.you;
  state.blocks = s.blocks;
  state.players = s.players;
  state.digging = s.digging;
  updateHud();
  updateProfile();
}

function buildModelPicker() {
  const mp = document.getElementById('modelPicker');
  mp.innerHTML = '';
  MODELS.forEach((m, i) => {
    const d = document.createElement('div');
    d.className = 'm' + (i === state.model ? ' sel' : '');
    d.style.background = m.body;
    if (m.hat) d.style.boxShadow = `inset 0 8px 0 ${m.hat}`;
    d.onclick = () => {
      state.model = i;
      socket.emit('setModel', i);
      buildModelPicker();
    };
    mp.appendChild(d);
  });
}

document.getElementById('menuBtn').onclick = () => {
  document.getElementById('profile').classList.toggle('hidden');
};
document.getElementById('closeProfile').onclick = () => {
  document.getElementById('profile').classList.add('hidden');
};

document.getElementById('spectateBtn').onclick = () => {
  socket.emit('spectate');
};
document.getElementById('backBtn').onclick = () => {
  state.spectator = false;
  specEl.classList.add('hidden');
  gameEl.classList.remove('hidden');
};

document.querySelectorAll('#actions button').forEach(b => {
  b.onclick = () => sendAction(b.dataset.act);
});

window.addEventListener('keydown', (e) => {
  if (state.spectator) return;
  const map = {
    ArrowUp:'up', ArrowDown:'down', ArrowLeft:'left', ArrowRight:'right',
    w:'up', s:'down', a:'left', d:'right',
    W:'up', S:'down', A:'left', D:'right',
  };
  if (map[e.key]) { sendAction('move', map[e.key]); e.preventDefault(); }
  if (e.key === 'q') sendAction('useDynamite');
  if (e.key === 'e') sendAction('placeTrap');
});

function sendAction(action, dir) {
  socket.emit('action', { action, dir, hash: state.hash }, (res) => {
    if (res.sync) {
      console.log('State out of sync, full sync received');
      applyState(res.state);
      state.hash = res.hash;
      return;
    }
    if (!res.success) {
      if (res.error === 'stone') toast('Stone — cannot dig.', 'bad');
      else if (res.error === 'occupied') toast('Blocked by another player.', 'bad');
      else if (res.error === 'stuck') toast('You are stuck in a bear trap!', 'bad');
      else if (res.error === 'wall') toast('Wall.', 'bad');
      return;
    }
    
    state.hash = res.hash;
    const changes = res.changes;
    
    if (changes.moved) {
      if (changes.dug) {
        const k = changes.dug.x + ',' + changes.dug.y;
        state.blocks[k] = { type: 'air', item: changes.dug.item };
        state.me.x = changes.dug.x;
        state.me.y = changes.dug.y;
      } else {
        state.me.x += (dir === 'left' ? -1 : dir === 'right' ? 1 : 0);
        state.me.y += (dir === 'up' ? -1 : dir === 'down' ? 1 : 0);
      }
      
      if (changes.newlyDiscovered) {
        for (const k of changes.newlyDiscovered) {
          if (!state.blocks[k]) {
            const [x, y] = k.split(',').map(Number);
            state.blocks[k] = { type: 'unknown', item: null };
          }
        }
      }
    }
    
    if (changes.digging) {
      state.digging = { x: changes.digging.x, y: changes.digging.y, duration: changes.digging.duration, startedAt: Date.now() };
    }
    
    updateHud();
  });
}

socket.on('blockDug', ({ x, y, item }) => {
  const k = x+','+y;
  state.blocks[k] = { type:'air', item };
});

socket.on('item', ({ item }) => {
  toast(`Got ${itemLabel(item)}!`, 'good');
  if (item === 'armor') state.me.armor += 1;
  else if (item === 'dynamite') state.me.dynamite += 1;
  else if (item === 'trap') state.me.trap += 1;
  else if (item === 'shovel') state.me.shovelUntil = Date.now() + 60000;
  updateHud();
});

socket.on('msg', ({ text, kind }) => toast(text, kind));
socket.on('died', ({ reason }) => toast('You died! Respawning…', 'bad'));
socket.on('respawned', ({ x, y }) => {
  toast('Respawned at surface.', 'good');
  state.me.x = x;
  state.me.y = y;
  state.me.alive = true;
});
socket.on('kicked', ({ reason }) => { alert(reason); location.reload(); });
socket.on('boom', () => toast('BOOM!', 'good'));
socket.on('trapTriggered', () => {});

socket.on('gameReset', () => {
  toast('New game started!', 'good');
  state.blocks = {};
  state.me.x = 0;
  state.me.y = 0;
  state.me.armor = 0;
  state.me.dynamite = 0;
  state.me.trap = 0;
  state.me.shovelUntil = 0;
});

socket.on('spectatorMode', ({ width }) => {
  state.spectator = true;
  state.specWidth = width;
  gameEl.classList.add('hidden');
  specEl.classList.remove('hidden');
  resizeCanvas();
});
socket.on('spectatorFrame', (f) => {
  state.specBlocks = f.blocks;
  state.specPlayers = f.players;
  state.specTraps = f.traps;
});

function itemLabel(it) {
  return { armor:'🛡 armor', shovel:'⛏ golden shovel', dynamite:'💣 dynamite', trap:'🪤 bear trap' }[it] || it;
}

function updateHud() {
  if (!state.me) return;
  const m = state.me;
  const inv = [];
  inv.push(`🛡 ${m.armor}`);
  inv.push(`💣 ${m.dynamite}`);
  inv.push(`🪤 ${m.trap}`);
  const shovelLeft = Math.max(0, Math.ceil((m.shovelUntil - Date.now())/1000));
  if (shovelLeft > 0) inv.push(`⛏ ${shovelLeft}s`);
  document.getElementById('inventory').textContent = inv.join('   ');
  const stuckLeft = Math.max(0, Math.ceil((m.stuckUntil - Date.now())/1000));
  document.getElementById('status').textContent =
    (!m.alive ? 'DEAD' : stuckLeft > 0 ? `STUCK ${stuckLeft}s` : '');
}

function updateProfile() {
  if (!state.me || !state.me.stats) return;
  document.getElementById('pMaxDepth').textContent = state.me.stats.maxDepth;
  document.getElementById('pDeaths').textContent = state.me.stats.deaths;
  document.getElementById('pItems').textContent = state.me.stats.itemsCollected;
}

function toast(text, kind='') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = text;
  document.getElementById('toasts').appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
const cvSpec = document.getElementById('cvSpec');
const ctxS = cvSpec.getContext('2d');

function resizeCanvas() {
  cv.width = window.innerWidth;  cv.height = window.innerHeight;
  cvSpec.width = window.innerWidth; cvSpec.height = window.innerHeight;
}
window.addEventListener('resize', resizeCanvas);

const COLORS = {
  dirt:    '#8b5a2b',
  stone:   '#888',
  spikes:  '#bbb',
  air:     null,
  unknown: '#222',
};

function drawBlock(c, x, y, type, item) {
  if (type === 'air') return;
  if (type === 'dirt')    c.fillStyle = COLORS.dirt;
  else if (type === 'stone')  c.fillStyle = COLORS.stone;
  else if (type === 'spikes') c.fillStyle = COLORS.spikes;
  else if (type === 'unknown') c.fillStyle = COLORS.unknown;
  c.fillRect(x, y, TILE, TILE);

  if (type === 'dirt') {
    c.fillStyle = 'rgba(0,0,0,0.15)';
    for (let i=0;i<4;i++) c.fillRect(x+(i*7)%TILE, y+(i*11)%TILE, 3, 3);
  } else if (type === 'stone') {
    c.strokeStyle = 'rgba(0,0,0,0.3)';
    c.strokeRect(x+0.5, y+0.5, TILE-1, TILE-1);
  } else if (type === 'spikes') {
    c.fillStyle = '#333';
    for (let i=0;i<4;i++) {
      const sx = x + i*8 + 2;
      c.beginPath();
      c.moveTo(sx, y+TILE);
      c.lineTo(sx+4, y+6);
      c.lineTo(sx+8, y+TILE);
      c.fill();
    }
  } else if (type === 'unknown') {
    c.strokeStyle = 'rgba(255,255,255,0.05)';
    c.strokeRect(x+0.5, y+0.5, TILE-1, TILE-1);
  }

  if (item) {
    c.fillStyle = '#ff0';
    c.font = '16px sans-serif';
    c.textAlign = 'center';
    const sym = { armor:'🛡', shovel:'⛏', dynamite:'💣', trap:'🪤' }[item] || '?';
    c.fillText(sym, x+TILE/2, y+TILE/2+6);
  }
}

function drawPlayer(c, p, px, py) {
  const m = MODELS[p.model] || MODELS[0];
  c.fillStyle = p.alive ? m.body : '#555';
  c.fillRect(px+4, py+8, TILE-8, TILE-10);
  c.fillStyle = '#f2c48d';
  c.fillRect(px+8, py+2, TILE-16, 10);
  if (m.hat) {
    c.fillStyle = m.hat;
    c.fillRect(px+6, py, TILE-12, 4);
  }
  c.fillStyle = '#000';
  c.fillRect(px+11, py+6, 2, 2);
  c.fillRect(px+TILE-13, py+6, 2, 2);

  if (p.stuck) {
    c.strokeStyle = '#f44';
    c.lineWidth = 2;
    c.strokeRect(px+1, py+1, TILE-2, TILE-2);
  }

  c.fillStyle = '#fff';
  c.strokeStyle = '#000';
  c.lineWidth = 3;
  c.font = '12px sans-serif';
  c.textAlign = 'center';
  c.strokeText(p.name, px+TILE/2, py-4);
  c.fillText(p.name, px+TILE/2, py-4);
}

function renderGame() {
  if (state.spectator) return;
  const W = cv.width, H = cv.height;

  if (state.me) {
    state.camera.x = state.me.x * TILE - W/2 + TILE/2;
    state.camera.y = state.me.y * TILE - H/2 + TILE/2;
  }
  const cx = state.camera.x, cy = state.camera.y;

  const grd = ctx.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, '#87ceeb');
  grd.addColorStop(1, '#2a2a2a');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, W, H);

  const x0 = Math.floor(cx / TILE) - 1;
  const y0 = Math.floor(cy / TILE) - 1;
  const x1 = Math.ceil((cx + W) / TILE) + 1;
  const y1 = Math.ceil((cy + H) / TILE) + 1;

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const k = x+','+y;
      const sx = x*TILE - cx, sy = y*TILE - cy;
      if (x < 0 || x >= 50) {
        ctx.fillStyle = '#000';
        ctx.fillRect(sx, sy, TILE, TILE);
        continue;
      }
      const b = state.blocks[k];
      if (b) {
        drawBlock(ctx, sx, sy, b.type, b.item);
      }
    }
  }

  if (state.digging) {
    const elapsed = Date.now() - state.digging.startedAt;
    const progress = Math.min(1, elapsed / state.digging.duration);
    const sx = state.digging.x*TILE - cx;
    const sy = state.digging.y*TILE - cy;
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(sx, sy + TILE*(1-progress), TILE, TILE*progress);
  }

  for (const p of state.players) {
    const sx = p.x*TILE - cx, sy = p.y*TILE - cy;
    if (sx < -TILE || sx > W+TILE || sy < -TILE || sy > H+TILE) continue;
    drawPlayer(ctx, p, sx, sy);
  }
}

function renderSpectator() {
  if (!state.spectator) return;
  const W = cvSpec.width, H = cvSpec.height;

  let cxp = 0, cyp = 0, n = 0;
  for (const p of state.specPlayers) if (p.alive) { cxp += p.x; cyp += p.y; n++; }
  if (n === 0) { cxp = state.specWidth/2; cyp = 10; }
  else { cxp /= n; cyp /= n; }
  const cx = cxp*TILE - W/2, cy = cyp*TILE - H/2;

  const grd = ctxS.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, '#87ceeb');
  grd.addColorStop(1, '#111');
  ctxS.fillStyle = grd;
  ctxS.fillRect(0, 0, W, H);

  const x0 = Math.floor(cx/TILE)-1, y0 = Math.floor(cy/TILE)-1;
  const x1 = Math.ceil((cx+W)/TILE)+1, y1 = Math.ceil((cy+H)/TILE)+1;

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const k = x+','+y;
      const sx = x*TILE - cx, sy = y*TILE - cy;
      if (x < 0 || x >= state.specWidth) {
        ctxS.fillStyle = '#000'; ctxS.fillRect(sx, sy, TILE, TILE); continue;
      }
      const b = state.specBlocks[k];
      if (b) drawBlock(ctxS, sx, sy, b.type, b.item);
    }
  }

  ctxS.fillStyle = 'rgba(255,0,0,0.35)';
  for (const t of state.specTraps) {
    const [x, y] = t.k.split(',').map(Number);
    ctxS.fillRect(x*TILE - cx + 4, y*TILE - cy + 4, TILE-8, TILE-8);
  }

  for (const p of state.specPlayers) {
    const sx = p.x*TILE - cx, sy = p.y*TILE - cy;
    drawPlayer(ctxS, p, sx, sy);
  }
}

function loop() {
  if (state.spectator) renderSpectator();
  else renderGame();
  requestAnimationFrame(loop);
}
loop();

setInterval(() => {
  if (state.me && state.me.shovelUntil > 0) updateHud();
}, 1000);

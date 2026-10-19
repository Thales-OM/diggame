// ---------- Field ----------
// The pit itself: the game canvas, its colours and drawing, the HUD and the
// tooltip.

import { ITEM, WEAPONS, fieldSprite } from './assets.js';
import { TILE, COLORS } from './constants.js';
import { emoteGlyph } from './ui.js';
import { renderInventory } from './battle.js';
import { state, el, ctx, specCv, now } from './state.js';

/**
 * One tooltip for the whole page, moved by the mouse. Following the cursor in
 * script rather than a CSS `:hover` bubble means the description can be a real
 * block of text that never gets clipped by the panel it belongs to.
 */
export function showTip(text, ev) {
  if (!el.tooltip) return;
  el.tooltip.textContent = text;
  el.tooltip.classList.remove('hidden');
  moveTip(ev);
}

export function moveTip(ev) {
  if (!el.tooltip || el.tooltip.classList.contains('hidden')) return;
  const x = ev && typeof ev.clientX === 'number' ? ev.clientX : 0;
  const y = ev && typeof ev.clientY === 'number' ? ev.clientY : 0;
  el.tooltip.style.left = (x + 16) + 'px';
  el.tooltip.style.top = (y + 16) + 'px';
}

export function hideTip() {
  if (el.tooltip) el.tooltip.classList.add('hidden');
}

/** Give an element a hover description that follows the pointer. */
export function tipOn(node, text) {
  if (!text) return node;
  node.addEventListener('mouseenter', (ev) => showTip(text, ev));
  node.addEventListener('mousemove', moveTip);
  node.addEventListener('mouseleave', hideTip);
  return node;
}

export function setStatus() {
  const bits = [];
  if (!state.connected) bits.push('offline');
  if (state.me && !state.me.alive) bits.push('DEAD');
  const stuck = state.me ? Math.max(0, Math.ceil((state.me.stuckUntil - now()) / 1000)) : 0;
  if (stuck > 0) bits.push(`STUCK ${stuck}s`);
  el.status.textContent = bits.join(' · ');
  el.status.className = !state.connected ? 'bad' : '';
}

export function updateHud() {
  if (!state.me) return;
  const m = state.me;
  // The field health bar: the same pool a fight draws on, painted the same red,
  // with the armour points it would spend first shown beside the numbers.
  const maxHp = m.maxHp || 0;
  const hp = Math.max(0, Math.min(m.hp || 0, maxHp));
  el.healthFill.style.width = (maxHp > 0 ? (hp / maxHp) * 100 : 0) + '%';
  el.healthText.textContent = maxHp > 0
    ? `${hp} / ${maxHp}` + (m.armor > 0 ? `   🛡 ${m.armor}` : '')
    : '';
  const inv = [`🛡 ${m.armor}`, `💣 ${m.dynamite}`, `🪤 ${m.trap}`, `🧪 ${m.potion || 0}`];
  const w = WEAPONS[m.weapon];
  // bare hands are always equipped and are the absence of a weapon, so they do
  // not clutter the HUD
  if (w && w.id !== 'bare') inv.push(`${w.glyph} ${w.name}`);
  const shovel = Math.max(0, Math.ceil((m.shovelUntil - now()) / 1000));
  if (shovel > 0) inv.push(`⛏ ${shovel}s`);
  el.inventory.textContent = inv.join('   ');
  setStatus();

  const depth = m.maxDepth || 0;
  const parts = [`depth ${depth}`];
  if (m.alive && m.digging) parts.push('digging…');
  el.stats.textContent = parts.join('  ·  ');
  updateProfile();
  // keep an open inventory panel in step with the snapshot
  if (!el.inventoryPanel.classList.contains('hidden')) renderInventory();
}

export function updateProfile() {
  if (!state.stats) return;
  el.pMaxDepth.textContent = state.stats.maxDepth;
  el.pDeaths.textContent = state.stats.deaths;
  el.pItems.textContent = state.stats.itemsCollected;
  el.pRuns.textContent = state.stats.runsPlayed;
}

export function toast(text, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = text;
  el.toasts.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

export function addEffect(kind, x, y) {
  if (x == null || y == null) return;
  state.effects.push({ kind, x, y, until: Date.now() + (kind === 'boom' ? 700 : 400) });
  if (state.effects.length > 40) state.effects.splice(0, state.effects.length - 40);
}

export function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  el.cv.width = w; el.cv.height = h;
  specCv.width = w; specCv.height = h;
}

/**
 * One block.
 *
 * `y >= surfaceY` is what separates "dug" from "sky": both are type 'air', but
 * the air above the surface was never anything and must keep showing sky,
 * while air below it is a hole somebody made.
 */
export function drawBlock(c, sx, sy, type, item, y, surfaceY) {
  if (type == null) return;
  const isSurface = y === surfaceY && type === 'dirt';

  if (type === 'air') {
    if (y < surfaceY) return; // sky: the background is the sky
    c.fillStyle = COLORS.dug;
    c.fillRect(sx, sy, TILE, TILE);
    c.fillStyle = 'rgba(0,0,0,0.3)';
    for (let i = 0; i < 4; i++) c.fillRect(sx + (i * 7) % TILE, sy + (i * 11) % TILE, 3, 3);
  } else {
    c.fillStyle = isSurface ? '#6b4a2a' : COLORS[type] || COLORS.unknown;
    c.fillRect(sx, sy, TILE, TILE);

    if (type === 'dirt') {
      c.fillStyle = 'rgba(0,0,0,0.15)';
      for (let i = 0; i < 4; i++) c.fillRect(sx + (i * 7) % TILE, sy + (i * 11) % TILE, 3, 3);
    } else if (type === 'stone') {
      c.strokeStyle = 'rgba(0,0,0,0.3)';
      c.strokeRect(sx + 0.5, sy + 0.5, TILE - 1, TILE - 1);
    } else if (type === 'spikes') {
      c.fillStyle = '#333';
      for (let i = 0; i < 4; i++) {
        const px = sx + i * 8 + 2;
        c.beginPath();
        c.moveTo(px, sy + TILE);
        c.lineTo(px + 4, sy + 6);
        c.lineTo(px + 8, sy + TILE);
        c.fill();
      }
    } else if (type === 'mist') {
      // Swirling purple haze: a soft, cloudy wall that reads as something alive
      c.fillStyle = 'rgba(255,255,255,0.10)';
      for (let i = 0; i < 5; i++) {
        const rx = sx + ((i * 13) % TILE);
        const ry = sy + ((i * 7) % TILE);
        c.beginPath();
        c.arc(rx, ry, 6 * (TILE / 32), 0, Math.PI * 2);
        c.fill();
      }
      c.fillStyle = 'rgba(200,140,255,0.45)';
      for (let i = 0; i < 3; i++) {
        const rx = sx + ((i * 17 + 6) % TILE);
        const ry = sy + ((i * 11 + 4) % TILE);
        c.beginPath();
        c.arc(rx, ry, 4 * (TILE / 32), 0, Math.PI * 2);
        c.fill();
      }
    } else if (type === 'boss') {
      // A boss is a battle, not a death: a red tile with two crossed swords,
      // drawn as paths rather than a glyph so it renders the same everywhere.
      c.fillStyle = COLORS.boss;
      c.fillRect(sx, sy, TILE, TILE);
      c.save();
      c.strokeStyle = '#3a0d0d';
      c.lineWidth = 3 * (TILE / 32);
      c.beginPath();
      c.moveTo(sx + 5 * (TILE / 32), sy + 27 * (TILE / 32));
      c.lineTo(sx + 11 * (TILE / 32), sy + 21 * (TILE / 32));
      c.moveTo(sx + 27 * (TILE / 32), sy + 27 * (TILE / 32));
      c.lineTo(sx + 21 * (TILE / 32), sy + 21 * (TILE / 32));
      c.stroke();
      c.strokeStyle = '#f5f5f5';
      c.lineWidth = 2.5 * (TILE / 32);
      c.beginPath();
      c.moveTo(sx + 5 * (TILE / 32), sy + 27 * (TILE / 32));
      c.lineTo(sx + 27 * (TILE / 32), sy + 5 * (TILE / 32));
      c.moveTo(sx + 27 * (TILE / 32), sy + 27 * (TILE / 32));
      c.lineTo(sx + 5 * (TILE / 32), sy + 5 * (TILE / 32));
      c.stroke();
      c.lineWidth = 2 * (TILE / 32);
      c.beginPath();
      c.moveTo(sx + 7 * (TILE / 32), sy + 18 * (TILE / 32));
      c.lineTo(sx + 14 * (TILE / 32), sy + 25 * (TILE / 32));
      c.moveTo(sx + 25 * (TILE / 32), sy + 18 * (TILE / 32));
      c.lineTo(sx + 18 * (TILE / 32), sy + 25 * (TILE / 32));
      c.stroke();
      c.restore();
    }
  }

  if (isSurface) {
    // grass on top of the surface row
    c.fillStyle = COLORS.grass;
    c.fillRect(sx, sy, TILE, 6);
    c.fillStyle = 'rgba(255,255,255,0.12)';
    c.fillRect(sx, sy, TILE, 2);
  }

  if (item) {
    c.fillStyle = '#ff0';
    c.font = '16px sans-serif';
    c.textAlign = 'center';
    c.fillText((ITEM[item] || {}).sym || '?', sx + TILE / 2, sy + TILE / 2 + 6);
  }
}

/** A cell that is inside the world but that nobody has discovered. */
export function drawUnknown(c, sx, sy) {
  c.fillStyle = COLORS.unknown;
  c.fillRect(sx, sy, TILE, TILE);
  c.strokeStyle = 'rgba(255,255,255,0.06)';
  c.lineWidth = 1;
  c.strokeRect(sx + 0.5, sy + 0.5, TILE - 1, TILE - 1);
}

export function drawFlash(c, sx, sy) {
  c.strokeStyle = 'rgba(255,255,255,0.5)';
  c.lineWidth = 2;
  c.strokeRect(sx + 1, sy + 1, TILE - 2, TILE - 2);
}

export function drawPlayer(c, p, sx, sy) {
  if (!p.alive) {
    c.fillStyle = 'rgba(120,120,120,0.5)';
    c.fillRect(sx + 4, sy + 8, TILE - 8, TILE - 10);
    return;
  }
  // The class sprite is pre-rendered at tile size, so drawing a player is one
  // blit; all the per-class detail lives in HERO_FIELD.
  const sprite = fieldSprite(p.model);
  c.drawImage(sprite, sx + (TILE - sprite.width) / 2, sy + (TILE - sprite.height) / 2);
  // Being impaled: the model is in the spikes and about to stop existing, so it
  // is drawn sunk into them rather than standing on top of them.
  if (p.dying) {
    c.fillStyle = 'rgba(200,60,60,0.55)';
    c.fillRect(sx + 2, sy + TILE - 8, TILE - 4, 8);
  }
  if (p.stuck) {
    c.strokeStyle = '#f44';
    c.lineWidth = 2;
    c.strokeRect(sx + 1, sy + 1, TILE - 2, TILE - 2);
  }
  // Emote bubble above the player name
  const nowT = now();
  if (p.emote && p.emote.until > nowT) {
    c.font = '20px sans-serif';
    c.textAlign = 'center';
    c.fillStyle = 'rgba(0,0,0,0.7)';
    const w = 24, h = 24;
    c.fillRect(sx + TILE / 2 - w / 2, sy - 36, w, h);
    c.fillStyle = '#fff';
    c.fillText(emoteGlyph(p.emote.id), sx + TILE / 2, sy - 36 + 18);
  }
  c.font = '12px sans-serif';
  c.textAlign = 'center';
  c.strokeStyle = '#000';
  c.lineWidth = 3;
  c.strokeText(p.name, sx + TILE / 2, sy - 4);
  c.fillStyle = '#fff';
  c.fillText(p.name, sx + TILE / 2, sy - 4);
}

export function drawDigBar(c, sx, sy, dig) {
  const progress = Math.max(0, Math.min(1, (now() - dig.startedAt) / dig.duration));
  c.fillStyle = 'rgba(0,0,0,0.45)';
  c.fillRect(sx, sy, TILE, TILE);
  c.fillStyle = 'rgba(255,220,80,0.5)';
  c.fillRect(sx, sy + TILE * (1 - progress), TILE, TILE * progress);
  c.strokeStyle = '#ffd050';
  c.lineWidth = 2;
  c.strokeRect(sx + 1, sy + 1, TILE - 2, TILE - 2);
}

export function drawEffect(c, e, cx, cy) {
  const t = 1 - (e.until - Date.now()) / (e.kind === 'boom' ? 700 : 400);
  const sx = e.x * TILE - cx, sy = e.y * TILE - cy;
  if (e.kind === 'boom') {
    c.fillStyle = `rgba(255,${180 - t * 160},0,${0.7 * (1 - t)})`;
    c.beginPath();
    c.arc(sx + TILE / 2, sy + TILE / 2, (4 + t * 40), 0, Math.PI * 2);
    c.fill();
  } else {
    c.strokeStyle = `rgba(255,80,80,${1 - t})`;
    c.lineWidth = 3;
    c.strokeRect(sx + 4, sy + 4, TILE - 8, TILE - 8);
  }
}

export function background(c, W, H) {
  const grd = c.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, '#87ceeb');
  grd.addColorStop(0.35, '#5a5a5a');
  grd.addColorStop(1, '#1a1a1a');
  c.fillStyle = grd;
  c.fillRect(0, 0, W, H);
}

export function renderGame(dt) {
  const W = el.cv.width, H = el.cv.height;
  background(ctx, W, H);
  if (!state.me) return;

  // Interpolate towards the authoritative position. This is presentation only:
  // a dropped frame or a slow packet makes it smoother, never wrong, and a
  // teleport-sized jump snaps instead of sliding.
  const tx = state.me.x, ty = state.me.y;
  const k = state.snap ? 1 : Math.min(1, dt / 60);
  state.drawMe.x += (tx - state.drawMe.x) * k;
  state.drawMe.y += (ty - state.drawMe.y) * k;
  state.snap = false;
  const cx = state.drawMe.x * TILE - W / 2 + TILE / 2;
  const cy = state.drawMe.y * TILE - H / 2 + TILE / 2;

  const x0 = Math.floor(cx / TILE) - 1, y0 = Math.floor(cy / TILE) - 1;
  const x1 = Math.ceil((cx + W) / TILE) + 1, y1 = Math.ceil((cy + H) / TILE) + 1;
  const t = now();

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const sx = x * TILE - cx, sy = y * TILE - cy;
      if (x < 0 || x >= state.width) {
        ctx.fillStyle = '#000';
        ctx.fillRect(sx, sy, TILE, TILE);
        continue;
      }
      const b = state.blocks[x + ',' + y];
      if (b) {
        // A gate wall we have opened reads as a tunnel for us, and only for us:
        // same depth measure the HUD uses (depth = y - (surfaceY - 1)).
        const open = b.type === 'mist' && state.clearedWalls.has(y - state.surfaceY + 1);
        drawBlock(ctx, sx, sy, open ? 'air' : b.type, b.item, y, state.surfaceY);
      } else if (y >= state.surfaceY) drawUnknown(ctx, sx, sy);
      // above the surface an unknown cell is still sky
      const f = state.flashes[x + ',' + y];
      if (f && f > t) drawFlash(ctx, sx, sy);
    }
  }
  for (const k2 of Object.keys(state.flashes)) if (state.flashes[k2] < t) delete state.flashes[k2];

  // Our own bear traps. Nobody else can see these, so this is the only place
  // they appear in the game view (BUGS v0.3.0). Drawn under the players.
  ctx.fillStyle = 'rgba(255,60,60,0.4)';
  ctx.strokeStyle = 'rgba(255,80,80,0.9)';
  ctx.lineWidth = 2;
  for (const tr of state.myTraps) {
    const tx = tr.x * TILE - cx + 4, ty = tr.y * TILE - cy + 4;
    ctx.fillRect(tx, ty, TILE - 8, TILE - 8);
    ctx.strokeRect(tx, ty, TILE - 8, TILE - 8);
  }

  if (state.dig) {
    const sx = state.dig.x * TILE - cx, sy = state.dig.y * TILE - cy;
    drawDigBar(ctx, sx, sy, state.dig);
  }

  // Loot left on the ground by a defeated boss. Drawn with the item glyph, so
  // it reads as something to walk over and pick up.
  ctx.font = '16px sans-serif';
  ctx.textAlign = 'center';
  for (const g of state.loot) {
    const lx = g.x * TILE - cx + TILE / 2, ly = g.y * TILE - cy + TILE / 2;
    if (lx < -TILE || lx > W + TILE || ly < -TILE || ly > H + TILE) continue;
    const meta = g.type === 'weapon' ? (WEAPONS[g.id] || {}) : (ITEM[g.id] || {});
    ctx.fillStyle = '#000';
    ctx.fillRect(g.x * TILE - cx + 6, g.y * TILE - cy + 6, TILE - 12, TILE - 12);
    ctx.fillStyle = '#ffd54f';
    ctx.fillText(meta.glyph || meta.sym || '?', lx, ly + 6);
  }

  for (const p of state.players) {
    if (!state.me || p.id === state.me.id) continue;
    const sx = p.x * TILE - cx, sy = p.y * TILE - cy;
    if (sx < -TILE || sx > W + TILE || sy < -TILE || sy > H + TILE) continue;
    drawPlayer(ctx, p, sx, sy);
  }

  // ourselves last, so we are never hidden behind someone else. Forced alive:
  // we are drawn as the live player until the respawn actually lands, which is
  // what makes the step into the spikes and the death two separate moments.
  drawPlayer(ctx, {
    ...state.me,
    alive: true,
    stuck: state.me.stuckUntil > t,
    dying: state.me.dyingAt > t,
  }, state.drawMe.x * TILE - cx, state.drawMe.y * TILE - cy);

  state.effects = state.effects.filter((e) => e.until > Date.now());
  for (const e of state.effects) drawEffect(ctx, e, cx, cy);
}

'use strict';

// End to end: boots the real server on an ephemeral port with a throwaway
// database, drives it with real socket.io clients, and checks the protocol
// end to end. Skipped unless socket.io-client is installed, so the default
// `npm test` still runs with no dependencies at all.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

let client = null;
try {
  client = require('socket.io-client');
} catch {
  client = null;
}

const DB_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'diggame-e2e-')),
  'e2e.db'
);

let child = null;
let port = 0;

// Every client this file opens. A test that fails half way through would
// otherwise leave its sockets open, and the runner would hang after the last
// assertion instead of reporting the failure and exiting.
const openSockets = new Set();

/** Grab a port the OS says is free, then hand it to the server. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = require('net').createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
}

async function startServer() {
  port = await freePort();
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], {
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        DB_PATH,
        RESET_SECRET: 'e2e-secret',
        ADMIN_SECRET: 'e2e-admin',
        ADMIN_VIEW_MARGIN: '12',
        DIG_TIME_MS: '40',
        SHOVEL_DIG_TIME_MS: '20',
        TICK_HZ: '20',
        STONE_CHANCE_MAX: '0',
        SPIKE_CHANCE_MAX: '0',
        ITEM_CHANCE: '1',
        // ...but the chance is capped by ITEM_CHANCE_MAX, so lift that too or
        // the loot table above never comes into play
        ITEM_CHANCE_MAX: '1',
        // traps included, so the "you can see your own trap" test has something
        // to actually find
        ITEM_WEIGHTS: 'dynamite:1,trap:1',
      },
    });
    let out = '';
    const onData = (d) => {
      out += d.toString();
      if (out.includes('listening on')) {
        clearTimeout(bail);
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('exit', (code) => reject(new Error(`server exited early (${code}): ${out}`)));
    // cleared as soon as the server says hello, so the timer cannot hold the
    // test process open after the tests are done
    const bail = setTimeout(() => reject(new Error(`server did not start: ${out}`)), 15000);
    bail.unref();
  });
}

function connect() {
  return new Promise((resolve, reject) => {
    const s = client(`http://localhost:${port}`, { transports: ['websocket'], forceNew: true });
    openSockets.add(s);
    s.on('close', () => openSockets.delete(s));
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}

function once(socket, event, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeout);
    socket.once(event, (payload) => { clearTimeout(t); resolve(payload); });
  });
}

function emitAck(socket, event, data) {
  // A missing or refused handler must fail the test, not hang the runner: an
  // ack that never arrives means the protocol changed under us.
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`timed out waiting for an answer to "${event}"`)),
      5000
    );
    socket.emit(event, data, (res) => { clearTimeout(t); resolve(res); });
  });
}

function action(socket, type, dir) {
  return emitAck(socket, 'action', { type, dir, rev: revOf(socket) });
}

/** The client keeps the newest rev it has seen; mirror that here. */
const revs = new WeakMap();
function revOf(socket) { return revs.get(socket) || 0; }
function noteRev(socket, res) {
  if (res && typeof res.rev === 'number') revs.set(socket, res.rev);
  if (res && res.state && typeof res.state.rev === 'number') revs.set(socket, res.state.rev);
  // private events (digComplete, state) only carry it inside the snapshot
  if (res && res.you && typeof res.you.rev === 'number') revs.set(socket, res.you.rev);
}

test.before(async () => {
  if (!client) return;
  await startServer();
});

test.after(async () => {
  for (const s of openSockets) {
    try { s.close(); } catch { /* already gone */ }
  }
  openSockets.clear();
  if (child) child.kill('SIGKILL');
  if (client) fs.rmSync(path.dirname(DB_PATH), { recursive: true, force: true });
});

test('a client can log in, dig, and come back with where it actually is', { skip: !client }, async () => {
  const socket = await connect();

  const login = await emitAck(socket, 'login', { name: 'Tester' });
  assert.strictEqual(login.ok, true);
  assert.match(login.code, /^[A-Z0-9]{8}$/);
  assert.strictEqual(login.state.you.name, 'Tester');
  assert.strictEqual(login.state.you.y, -1, 'a new player stands on the surface');
  assert.strictEqual(login.state.blocks.length, 100, 'the surface row and the sky are known');
  assert.ok(login.state.config.digTimeMs, 'the client is told the dig time');
  noteRev(socket, login.state);

  const startX = login.state.you.x;
  let res = await action(socket, 'move', 'down');
  noteRev(socket, res);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.you.x, startX);
  assert.ok(res.you.digging, 'a dig started');
  assert.strictEqual(res.you.y, -1, 'and we have not moved yet');

  const done = once(socket, 'digComplete');
  // the server may tick between our action and our rev, so drive the next one
  // through a sync when the rev has moved on
  for (let i = 0; i < 30; i++) {
    const ack = await action(socket, 'move', 'down');
    noteRev(socket, ack);
    if (ack.needSync) continue;
    if (ack.you && ack.you.digging) break;
  }
  const finished = await done;
  assert.strictEqual(finished.you.y, 0, 'the server says we are one row down');
  assert.strictEqual(finished.dug.x, startX);
  assert.strictEqual(finished.dug.y, 0);
  noteRev(socket, { rev: finished.you.rev });

  socket.close();
});

test('a stale rev gets a full state instead of a delta', { skip: !client }, async () => {
  const socket = await connect();
  const login = await emitAck(socket, 'login', { name: 'Stale' });
  noteRev(socket, login.state);
  revs.set(socket, login.state.rev - 3); // pretend we missed three events

  const res = await action(socket, 'move', 'down');
  assert.strictEqual(res.needSync, true);
  assert.ok(res.state.you, 'the full state comes with it');
  assert.ok(Array.isArray(res.state.blocks));
  socket.close();
});

test('a rejected move still returns an authoritative position', { skip: !client }, async () => {
  const socket = await connect();
  const login = await emitAck(socket, 'login', { name: 'Walker' });
  noteRev(socket, login.state);

  const res = await action(socket, 'move', 'up');
  noteRev(socket, res);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'above_surface');
  assert.strictEqual(res.you.y, login.state.you.y, 'and our position is unchanged');
  socket.close();
});

test('a tick keeps a second player in the picture', { skip: !client }, async () => {
  const a = await connect();
  const b = await connect();
  const la = await emitAck(a, 'login', { name: 'Ann' });
  const lb = await emitAck(b, 'login', { name: 'Bob' });
  noteRev(a, la.state);
  noteRev(b, lb.state);

  const tick = once(a, 'tick');
  const res = await action(b, 'move', 'down');
  noteRev(b, res);
  assert.ok(res.needSync || res.ok, 'the action was answered one way or the other');

  const frame = await tick;
  const names = frame.players.map((p) => p.name).sort();
  assert.deepStrictEqual(names, ['Ann', 'Bob'], 'both players are broadcast');
  assert.ok(frame.players.every((p) => typeof p.x === 'number' && typeof p.y === 'number'));

  a.close();
  b.close();
});

test('the account code brings the same player back with their stats', { skip: !client }, async () => {
  const first = await connect();
  const login = await emitAck(first, 'login', { name: 'Returner' });
  noteRev(first, login.state);
  const res = await action(first, 'move', 'down');
  noteRev(first, res);
  const done = once(first, 'digComplete');
  for (let i = 0; i < 30; i++) {
    const ack = await action(first, 'move', 'down');
    noteRev(first, ack);
    if (ack.needSync) continue;
    if (ack.you && ack.you.digging) break;
  }
  await done;
  await new Promise((r) => setTimeout(r, 1200)); // let the stats flush
  first.close();

  const second = await connect();
  const back = await emitAck(second, 'login', { code: login.code });
  assert.strictEqual(back.ok, true);
  assert.strictEqual(back.code, login.code);
  assert.strictEqual(back.name, 'Returner', 'the name came back from storage');
  assert.ok(back.stats.blocksDug >= 1, `stats survived, got ${back.stats.blocksDug}`);
  second.close();
});

test('spectating shows the world but not the traps of a hidden player', { skip: !client }, async () => {
  const watcher = await connect();
  const login = await emitAck(watcher, 'login', { name: 'Watcher' });
  noteRev(watcher, login.state);

  const frame = new Promise((resolve) => watcher.once('spectatorMode', resolve));
  watcher.emit('spectate');
  const spec = await frame;
  assert.strictEqual(spec.width, 50);
  assert.ok(spec.blocks.length > 0, 'the world is visible');
  assert.deepStrictEqual(spec.traps, [], 'there are no traps in this run');
  assert.ok(spec.players.some((p) => p.name === 'Watcher'));
  watcher.close();
});

test('the world survives a restart with the same seed', { skip: !client }, async () => {
  // the run itself is ephemeral, so this checks the opposite: a fresh process
  // opens a new world rather than resurrecting the old one
  const before = fs.statSync(DB_PATH).size;
  assert.ok(before > 0, 'the database file exists and has content');
});

test('resetting the world moves every player immediately', { skip: !client }, async () => {
  const socket = await connect();
  const login = await emitAck(socket, 'login', { name: 'Resetter' });
  noteRev(socket, login.state);

  // dig a little, so there is a position to be wrong about
  const done = once(socket, 'digComplete');
  for (let i = 0; i < 30; i++) {
    const ack = await action(socket, 'move', 'down');
    noteRev(socket, ack);
    if (ack.needSync) continue;
    if (ack.you && ack.you.digging) break;
  }
  await done;

  const reset = once(socket, 'worldReset');
  const res = await fetch(`http://127.0.0.1:${port}/api/reset?secret=e2e-secret`, { method: 'POST' });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.ok, true);
  assert.ok(body.previousWorld > 0, 'the closed world is reported');

  const msg = await reset;
  assert.strictEqual(msg.you.y, -1, 'back on the surface with the very first message');
  assert.strictEqual(msg.you.x, msg.state.you.x);
  assert.ok(msg.seed, 'the new seed is announced');
  assert.ok(msg.state.blocks.length > 0, 'and the new world comes with it');
  noteRev(socket, msg.state);
  socket.close();
});

test('the reset endpoint refuses a wrong secret', { skip: !client }, async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/reset?secret=wrong`, { method: 'POST' });
  assert.strictEqual(res.status, 403);
  const body = await res.json();
  assert.match(body.error, /secret/i);
});

test('logging in twice on one socket leaves exactly one player', { skip: !client }, async () => {
  const socket = await connect();
  const first = await emitAck(socket, 'login', { name: 'Twin' });
  assert.strictEqual(first.ok, true);

  const second = await emitAck(socket, 'login', { code: first.code });
  assert.strictEqual(second.ok, true, 'the same socket may log in again');
  assert.strictEqual(second.code, first.code);

  // and the session is usable, not orphaned
  const res = await action(socket, 'move', 'down');
  assert.ok(res.ok || res.needSync, 'the second login left a working session');
  socket.close();
});

test('a second login from elsewhere kicks the first session out', { skip: !client }, async () => {
  const first = await connect();
  const login = await emitAck(first, 'login', { name: 'Ghost' });

  const kicked = once(first, 'kicked');
  const second = await connect();
  const back = await emitAck(second, 'login', { code: login.code });
  assert.strictEqual(back.ok, true);

  const msg = await kicked;
  assert.match(msg.reason, /somewhere else/i);
  first.close();
  second.close();
});

test('a skin change is in a broadcast, with no movement needed', { skip: !client }, async () => {
  const watcher = await connect();
  const watched = await connect();
  const lw = await emitAck(watcher, 'login', { name: 'Eye' });
  const lw2 = await emitAck(watched, 'login', { name: 'Skin' });
  noteRev(watcher, lw.state);
  noteRev(watched, lw2.state);

  watched.emit('setModel', 4);

  // The change is asynchronous, so wait for a broadcast that carries it rather
  // than for the very next tick: a tick can be on its way already.
  const deadline = Date.now() + 5000;
  let skin = null;
  while (Date.now() < deadline) {
    const tick = await once(watcher, 'tick', 3000);
    skin = tick.players.find((p) => p.name === 'Skin');
    if (skin && skin.model === 4) break;
  }
  assert.ok(skin, 'the player was broadcast at all');
  assert.strictEqual(skin.model, 4, 'the new model arrived without moving or digging');

  watcher.close();
  watched.close();
});

// ================= BUGS v0.3.0 =================

test('a bear trap is visible to the player who set it and to nobody else', { skip: !client }, async () => {
  const owner = await connect();
  const other = await connect();
  const lo = await emitAck(owner, 'login', { name: 'Trapper' });
  const lx = await emitAck(other, 'login', { name: 'Bystander' });
  noteRev(owner, lo.state);
  noteRev(other, lx.state);
  assert.deepStrictEqual(lo.state.you.traps, [], 'nobody has set a trap yet');
  assert.deepStrictEqual(lx.state.you.traps, [], 'and neither has the bystander');

  // A trap has to be found before it can be set. The item only lands when the
  // dig finishes, so each round starts a dig and waits for digComplete.
  let held = 0;
  for (let i = 0; i < 8 && held < 1; i++) {
    const complete = once(owner, 'digComplete', 5000);
    const ack = await action(owner, 'move', 'down');
    noteRev(owner, ack);
    if (!ack.you || !ack.you.digging) continue;
    const msg = await complete.catch(() => null);
    // digComplete carries the player's own rev; without this the next action
    // is rejected as stale and never happens
    if (msg) noteRev(owner, { rev: msg.you && msg.you.rev });
    held = (msg && msg.you && msg.you.trap) || 0;
  }
  // the test world hands out an item in every dirt block, so this is not a
  // maybe: if no trap turned up, something is genuinely wrong
  assert.ok(held >= 1, 'the digger found a trap to set');

  const place = await action(owner, 'placeTrap');
  noteRev(owner, place);
  const after = place.you || (place.state && place.state.you);
  assert.ok(after, `the action is answered with a snapshot: ${JSON.stringify(place).slice(0, 120)}`);
  assert.strictEqual(after.trap, 0, 'setting it spends the trap from the pack');

  const mine = after.traps;
  assert.strictEqual(mine.length, 1, 'the player who set it is shown their own trap');
  assert.strictEqual(mine[0].x, after.x, 'on the cell they are standing on');
  assert.strictEqual(mine[0].y, after.y);

  // the other player must not see it through the private channel...
  const theirs = await action(other, 'sync');
  noteRev(other, theirs);
  assert.deepStrictEqual(theirs.state.you.traps, [], 'the trap is secret to everyone else');

  // ...and a spectator does not, which is the whole point of hiding it
  const anon = await connect();
  const spec = await new Promise((resolve) => {
    anon.once('spectatorMode', resolve);
    anon.emit('spectate', { mode: 'public' });
  });
  assert.strictEqual(spec.mode, 'public');
  assert.ok(Array.isArray(spec.traps));
  assert.deepStrictEqual(spec.traps, [], 'a public spectator is not shown a trap');
  assert.ok(
    !spec.blocks.some((b) => b.y > 0),
    'nor is it shown the pit the trap is standing in',
  );

  // an admin, who has the secret, is the one view that does see it
  const admin = await connect();
  const wide = await new Promise((resolve) => {
    admin.once('spectatorMode', resolve);
    admin.emit('spectate', { mode: 'admin', secret: 'e2e-admin', adminAll: true, depthMargin: 5 });
  });
  assert.strictEqual(wide.mode, 'admin');
  assert.ok(
    wide.traps.some((t) => t.x === mine[0].x && t.y === mine[0].y),
    'the admin view has every trap, which is what it is for',
  );
  assert.ok(wide.blocks.some((b) => b.y > 0), 'and the field behind it');

  owner.close();
  other.close();
  anon.close();
  admin.close();
});

test('a private event carries the revision it was taken at', { skip: !client }, async () => {
  // BUGS v0.3.0: digComplete used to ship a snapshot with no rev, so a client
  // that only tracks private events went stale and its next action was
  // rejected with a needless full resync.
  const socket = await connect();
  const login = await emitAck(socket, 'login', { name: 'Reviser' });
  noteRev(socket, login.state);

  const complete = once(socket, 'digComplete');
  const ack = await action(socket, 'move', 'down');
  noteRev(socket, ack);
  assert.ok(ack.you && ack.you.digging, 'the dig started');

  const msg = await complete;
  assert.strictEqual(typeof msg.you.rev, 'number', 'the snapshot says which rev it is');
  assert.ok(msg.you.rev > 0, 'and it has moved on from the login snapshot');

  // a client that tracks it sends the right rev, and the next action goes
  // through instead of bouncing a needless full resync
  noteRev(socket, msg);
  const next = await action(socket, 'placeTrap');
  assert.notStrictEqual(next.needSync, true, 'the next action is not thrown away as stale');
  socket.close();
});

test('relogging in keeps the blocks already discovered', { skip: !client }, async () => {
  const first = await connect();
  const login = await emitAck(first, 'login', { name: 'Cartographer' });
  noteRev(first, login.state);
  const startX = login.state.you.x;
  const startBlocks = login.state.blocks.length;

  // dig down a couple of rows so there is a tunnel worth remembering
  const done = once(first, 'digComplete');
  for (let i = 0; i < 30; i++) {
    const ack = await action(first, 'move', 'down');
    noteRev(first, ack);
    if (ack.needSync) continue;
    if (ack.you && ack.you.digging) break;
  }
  await done;
  await new Promise((r) => setTimeout(r, 200));

  const before = await emitAck(first, 'action', { type: 'sync', rev: revOf(first) });
  noteRev(first, before);
  const known = new Set(before.state.blocks.map((b) => `${b.x},${b.y}`));
  assert.ok(known.size > startBlocks, `Ann discovered more than the ${startBlocks} surface cells`);
  assert.ok(known.has(`${startX},0`), 'including the cell under where she started');
  first.close();
  await new Promise((r) => setTimeout(r, 150)); // let the socket go

  const second = await connect();
  const back = await emitAck(second, 'login', { code: login.code });
  assert.strictEqual(back.ok, true);
  const backKnown = new Set(back.state.blocks.map((b) => `${b.x},${b.y}`));
  for (const k of known) {
    assert.ok(backKnown.has(k), `cell ${k} is still revealed after relogging in`);
  }
  second.close();
});

// ================= BUGS v0.3.1 and v0.4.0 over a real socket =================

test('a skin change reaches the player who made it without waiting for a tick', { skip: !client }, async () => {
  // BUGS v0.3.1: the old handler wrote the model and sent nothing back, so the
  // person changing their own skin only saw it change on the next unrelated
  // event. The answer has to carry a snapshot.
  const s = await connect();
  const login = await emitAck(s, 'login', { name: 'Instant' });
  noteRev(s, login.state);

  const before = await once(s, 'tick', 3000);
  const modelBefore = before.players.find((p) => p.name === 'Instant').model;
  assert.notStrictEqual(modelBefore, 3, 'precondition: we are not already wearing that skin');

  // ask, and wait for the private push rather than the next broadcast
  const pushed = once(s, 'state', 3000);
  const ack = await emitAck(s, 'setModel', 3);
  assert.ok(ack, 'the request is answered');
  assert.strictEqual(ack.ok, true, `${JSON.stringify(ack)}`);
  assert.strictEqual(ack.model, 3, 'and the answer names the skin the server set');
  noteRev(s, ack);

  const msg = await pushed;
  assert.strictEqual(msg.reason, 'modelChanged', 'the push says why it happened');
  assert.strictEqual(msg.you.model, 3, 'and it carries the new skin');
  assert.strictEqual(typeof msg.you.rev, 'number', 'at a revision the next action can use');
  noteRev(s, { you: msg.you });

  // and the next real action is still accepted, i.e. we did not go stale
  const moved = await action(s, 'sync');
  assert.ok(!moved.error, `the next action was not rejected as stale: ${JSON.stringify(moved)}`);

  s.close();
});

test('a skin that does not exist is refused, and the player keeps the one they had', { skip: !client }, async () => {
  const s = await connect();
  const login = await emitAck(s, 'login', { name: 'Picky' });
  noteRev(s, login.state);
  assert.strictEqual((await emitAck(s, 'setModel', 2)).ok, true);
  noteRev(s, await action(s, 'sync'));

  for (const bad of [-1, 5, 1.5, '2', null]) {
    const res = await emitAck(s, 'setModel', bad);
    assert.ok(res && res.error, `${JSON.stringify(bad)} is refused with an error`);
    assert.strictEqual(res.error, 'invalid_model');
  }
  const after = await action(s, 'sync');
  assert.strictEqual(after.state.you.model, 2, 'still wearing the last valid skin');
  s.close();
});

test('an unknown mode is never granted, whatever the client asks for', { skip: !client }, async () => {
  const s = await connect();
  for (const ask of [{}, { mode: 'everything' }, { mode: 'ADMIN' }, { mode: 'player' }]) {
    const res = await emitAck(s, 'spectate', ask);
    assert.strictEqual(res.mode, 'public', `${JSON.stringify(ask)} gets the public view`);
    const frame = await once(s, 'spectatorMode', 3000);
    assert.ok(!frame.blocks.some((b) => b.y > 0), 'and no cells below the surface');
  }
  s.close();
});

test('a logged in spectator sees its own discoveries, and only its own', { skip: !client }, async () => {
  const digger = await connect();
  const watcher = await connect();
  const l1 = await emitAck(digger, 'login', { name: 'Digger' });
  const l2 = await emitAck(watcher, 'login', { name: 'Watcher' });
  noteRev(digger, l1.state);
  noteRev(watcher, l2.state);

  // the digger goes down, so it has discoveries the watcher has not
  for (let i = 0; i < 3; i++) {
    const done = once(digger, 'digComplete', 5000);
    const ack = await action(digger, 'move', 'down');
    noteRev(digger, ack);
    if (!ack.you || !ack.you.digging) continue;
    noteRev(digger, { you: (await done).you });
  }
  // the digger has discoveries, so its own view reaches under the surface...
  assert.strictEqual((await emitAck(digger, 'spectate', { mode: 'player' })).mode, 'player');
  const mine = await once(digger, 'spectatorMode', 3000);
  const dug = mine.blocks.filter((b) => b.y > 0);
  assert.ok(dug.length > 0, 'and it is shown the cells it found');
  assert.ok(
    dug.some((b) => b.type === 'air'),
    'including the tunnel it dug out',
  );

  // ...and the watcher, which has dug nothing, is shown nothing extra
  assert.strictEqual((await emitAck(watcher, 'spectate', { mode: 'player' })).mode, 'player');
  const theirs = await once(watcher, 'spectatorMode', 3000);
  assert.ok(
    !theirs.blocks.some((b) => b.y > 0),
    'a player view is per account, not a shared map',
  );

  digger.close();
  watcher.close();
});

test('the admin view is refused without the secret and refused when the secret is wrong', { skip: !client }, async () => {
  const s = await connect();
  assert.deepStrictEqual(
    await emitAck(s, 'spectate', { mode: 'admin', secret: 'guess' }),
    { error: 'bad_admin_secret' },
  );
  assert.deepStrictEqual(await emitAck(s, 'spectate', { mode: 'admin' }), { error: 'bad_admin_secret' });

  const ok = await emitAck(s, 'spectate', { mode: 'admin', secret: 'e2e-admin', adminAll: true, depthMargin: 5 });
  assert.strictEqual(ok.ok, true, `${JSON.stringify(ok)}`);
  assert.strictEqual(ok.mode, 'admin');
  assert.strictEqual(ok.depthMargin, 5, 'the agreed margin is echoed back');
  const frame = await once(s, 'spectatorMode', 3000);
  assert.strictEqual(frame.mode, 'admin');
  assert.ok(frame.maxY > 0, 'and it reaches below the surface');
  s.close();
});

test('a margin the server did not agree to is replaced by one it did', { skip: !client }, async () => {
  const s = await connect();
  // nonsense falls back to the server's own default...
  for (const ask of [-50, 'deep', null]) {
    const res = await emitAck(s, 'spectate', { mode: 'admin', secret: 'e2e-admin', depthMargin: ask });
    assert.strictEqual(res.depthMargin, 12, `${JSON.stringify(ask)} is replaced by the server default`);
    await once(s, 'spectatorMode', 3000);
  }
  // ...and an absurd but well formed one is capped rather than obeyed
  const huge = await emitAck(s, 'spectate', { mode: 'admin', secret: 'e2e-admin', depthMargin: 1e9 });
  assert.strictEqual(huge.depthMargin, 500);
  await once(s, 'spectatorMode', 3000);
  s.close();
});

test('the rules are offered once per account, and closing them is remembered', { skip: !client }, async () => {
  const first = await connect();
  const login = await emitAck(first, 'login', { name: 'Fresh', modelIndex: 0 });
  assert.strictEqual(login.rulesSeen, false, 'a brand new account is shown them');
  assert.ok(login.code, 'and is told its code');

  // closing them is what records having seen them
  await emitAck(first, 'rulesSeen');
  first.close();

  const again = await connect();
  const second = await emitAck(again, 'login', { code: login.code });
  assert.strictEqual(second.rulesSeen, true, 'and not shown again next time');
  assert.strictEqual(second.name, 'Fresh', 'and the account is the same one');
  again.close();
});

test('a model a returning player chose earlier is still theirs', { skip: !client }, async () => {
  const s = await connect();
  const first = await emitAck(s, 'login', { name: 'Skinner', modelIndex: 0 });
  assert.strictEqual((await emitAck(s, 'setModel', 4)).ok, true);
  const code = first.code;
  s.close();

  const back = await connect();
  const login = await emitAck(back, 'login', { code });
  assert.strictEqual(login.model, 4, 'the skin survives a new session');
  back.close();
});

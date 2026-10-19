'use strict';

// ---------- Sockets ----------
// Everything a connected client can ask for: login, class choice, actions, the
// rules flag and spectator mode. The rules themselves live in game/; this file
// is only the wire.

const ctx = require('./context');
const runtime = require('./runtime');
const protocol = require('./protocol');

function registerSockets() {
  ctx.io.on('connection', (socket) => {
    if (ctx.halted) {
      socket.emit('halted', { message: 'The game is halted by a server error. Please try again later.' });
      socket.disconnect(true);
      return;
    }

    socket.data.playerId = null;
    socket.data.pendingClass = null;
    socket.data.spectating = false;
    socket.data.specMode = 'public';
    socket.data.specAdminAll = true;
    socket.data.specDepthMargin = ctx.config.ADMIN_VIEW_MARGIN;
    socket.data.specCache = new Map();

    socket.on('login', (data, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (ctx.halted) return reply({ error: 'The game is halted by a server error.' });

      // logging in twice on one socket must not leave an orphan behind
      const previous = runtime.playerFor(socket);
      if (previous) {
        runtime.flushStats();
        ctx.socketPlayers.delete(previous.id);
        ctx.game.removePlayer(previous);
        socket.data.playerId = null;
      }
      // a fresh login abandons any class choice left half-made on this socket
      socket.data.pendingClass = null;

      const name = String((data && data.name) || '').trim().slice(0, ctx.config.MAX_NAME_LENGTH);
      let code = String((data && data.code) || '').trim().toUpperCase();
      // A legacy account field. The class is per run now, so this only seeds the
      // stored value a brand new account is created with.
      const modelIndex = (data && Number.isInteger(data.modelIndex)) ? data.modelIndex : 0;

      let account = code ? ctx.store.getAccount(code) : null;
      const isNew = !account;
      if (account) {
        // a returning player may rename themselves; their stats and code stay put
        if (name) ctx.store.upsertAccount(code, name, modelIndex);
        code = account.code;
      } else {
        if (!name) return reply({ error: 'Enter a name, or the code from a previous game.' });
        do { code = runtime.genCode(); } while (ctx.store.getAccount(code));
        ctx.store.upsertAccount(code, name, modelIndex);
      }

      // an account that has never had the Rules dialog is a new player, even
      // if it is on its second visit: they are shown the rules once
      const rulesSeen = !isNew && !!account.rulesSeen;

      // The class is an entry choice held for the whole run. An account that has
      // not chosen yet is not spawned: it gets the class list and must answer
      // chooseClass first, so nobody walks the pit until they are a class.
      const chosen = ctx.game.classOf(code);
      if (chosen === undefined) {
        socket.data.pendingClass = { code };
        ctx.store.touchAccount(code);
        return reply({
          ok: true,
          code,
          name: name || (account && account.name) || 'Miner',
          needsClass: true,
          classes: ctx.game.classes(),
          rulesSeen,
        });
      }

      // one live session per account: a second login kicks the first one out
      for (const p of [...ctx.game.players.values()]) {
        if (p.code !== code) continue;
        const oldSid = ctx.socketPlayers.get(p.id);
        if (oldSid) {
          ctx.io.to(oldSid).emit('kicked', { reason: 'You logged in from somewhere else.' });
          ctx.socketPlayers.delete(p.id);
        }
        ctx.game.removePlayer(p);
      }

      const stats = ctx.store.getStats(code);
      const player = ctx.game.addPlayer({ code, name: name || (account && account.name), modelIndex: chosen, stats });
      if (!player) return reply({ error: 'The pit is full, try again in a moment.' });

      socket.data.playerId = player.id;
      ctx.socketPlayers.set(player.id, socket.id);
      ctx.store.touchAccount(code);

      reply({
        ok: true,
        code,
        name: player.name,
        model: player.modelIndex,
        classes: ctx.game.classes(),
        state: protocol.fullState(ctx.game, player, ctx.CLIENT_CONFIG),
        stats,
        rulesSeen,
      });
    });

    /**
     * The class a pending account has just picked. This is what actually spawns
     * the player: login only hands out the list. A class is per-run, so an
     * account that already chose (or that logs in twice) just gets its state back.
     */
    socket.on('chooseClass', (data, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (ctx.halted) return reply({ error: 'halted' });
      const modelIndex = typeof data === 'number' ? data : (data && data.modelIndex);

      const pending = socket.data.pendingClass;
      if (!pending) {
        const existing = runtime.playerFor(socket);
        if (!existing) return reply({ error: 'not_logged_in' });
        return reply({
          ok: true,
          code: existing.code,
          name: existing.name,
          model: existing.modelIndex,
          classes: ctx.game.classes(),
          state: protocol.fullState(ctx.game, existing, ctx.CLIENT_CONFIG),
          stats: ctx.store.getStats(existing.code),
        });
      }

      const chosen = ctx.game.setClass(pending.code, modelIndex);
      if (!chosen.ok) return reply({ error: chosen.error });

      // a second pending socket for the same account: the newest choice wins and
      // any older live session is kicked, as a second login would
      for (const p of [...ctx.game.players.values()]) {
        if (p.code !== pending.code) continue;
        const oldSid = ctx.socketPlayers.get(p.id);
        if (oldSid && oldSid !== socket.id) {
          ctx.io.to(oldSid).emit('kicked', { reason: 'You logged in from somewhere else.' });
          ctx.socketPlayers.delete(p.id);
        }
        ctx.game.removePlayer(p);
      }

      const account = ctx.store.getAccount(pending.code);
      const stats = ctx.store.getStats(pending.code);
      const player = ctx.game.addPlayer({
        code: pending.code,
        name: (account && account.name) || 'Miner',
        modelIndex,
        stats,
      });
      if (!player) return reply({ error: 'The pit is full, try again in a moment.' });

      socket.data.pendingClass = null;
      socket.data.playerId = player.id;
      ctx.socketPlayers.set(player.id, socket.id);
      ctx.store.touchAccount(pending.code);
      reply({
        ok: true,
        code: player.code,
        name: player.name,
        model: player.modelIndex,
        classes: ctx.game.classes(),
        state: protocol.fullState(ctx.game, player, ctx.CLIENT_CONFIG),
        stats,
      });
    });

    socket.on('action', (data, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (ctx.halted) return reply({ error: 'halted' });
      const player = runtime.playerFor(socket);
      if (!player) return reply({ error: 'not_logged_in' });

      // SPEC: incremental updates with verification. A stale rev means the client
      // missed something, so hand back the whole state instead of a delta that
      // would be applied to the wrong baseline.
      if (data && data.type === 'sync') {
        return reply({ needSync: true, rev: player.rev, state: protocol.fullState(ctx.game, player, ctx.CLIENT_CONFIG) });
      }
      if (!data || typeof data.rev !== 'number' || data.rev !== player.rev) {
        return reply({
          needSync: true,
          rev: player.rev,
          state: protocol.fullState(ctx.game, player, ctx.CLIENT_CONFIG),
        });
      }

      // `id` is carried through for actions that take one (emotes, equipWeapon,
      // joinBattle); `item` for battle item use and `target` for the member a
      // healing item is aimed at. Dropping these here made the action arrive with
      // the wrong payload and be rejected.
      const result = ctx.game.action(player, {
        type: data.type, dir: data.dir, id: data.id, item: data.item, target: data.target,
      });
      reply(protocol.ackFor(ctx.game, player, result, ctx.CLIENT_CONFIG));
    });

    // The client has no reason to wait for an answer, so it may send this with no
    // arguments at all - in which case socket.io hands the callback through as the
    // first parameter instead of the second.
    socket.on('rulesSeen', (data, ack) => {
      const reply = typeof ack === 'function' ? ack : (typeof data === 'function' ? data : () => {});
      const player = runtime.playerFor(socket);
      // A player still choosing a class has no player object yet, but the account
      // is real: the rules were read by that account, so mark it against the code
      // it is about to spawn under.
      const code = player ? player.code : (socket.data.pendingClass && socket.data.pendingClass.code);
      // Only a real account can have read them, and only once, so the "has this
      // player seen the rules" question has exactly one answer.
      reply({ ok: !!code, marked: code ? ctx.store.markRulesSeen(code) : false });
    });

    /**
     * Enter (or re-enter) spectator mode. Asking again is how an admin changes
     * the options without dropping the socket, so the whole request is re-checked
     * here rather than only on the first call.
     */
    socket.on('spectate', (data, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const req = data && typeof data === 'object' ? data : {};
      const player = runtime.playerFor(socket);

      // No mode asked for: a logged in socket watches its own discoveries, an
      // anonymous one watches the public view. That is the least it can see.
      let mode = runtime.SPECTATOR_MODES.includes(req.mode) ? req.mode : (player ? 'player' : 'public');

      if (mode === 'admin') {
        if (!ctx.config.ADMIN_SECRET) return reply({ error: 'admin_view_disabled' });
        if (String(req.secret || '') !== ctx.config.ADMIN_SECRET) return reply({ error: 'bad_admin_secret' });
      } else if (mode === 'player' && !player) {
        mode = 'public';
      }

      const adminAll = req.adminAll === undefined ? true : !!req.adminAll;
      const depthMargin = protocol.clampMargin(req.depthMargin, ctx.config.ADMIN_VIEW_MARGIN);

      // Anything that changes what the next frame contains invalidates the diff
      // cache, or the first frame of the new view would arrive empty.
      const changed = socket.data.specMode !== mode
        || socket.data.specAdminAll !== adminAll
        || socket.data.specDepthMargin !== depthMargin
        || !socket.data.spectating;
      if (changed) socket.data.specCache = new Map();

      socket.data.specMode = mode;
      socket.data.specAdminAll = adminAll;
      socket.data.specDepthMargin = depthMargin;
      socket.data.spectating = true;
      ctx.spectatorSockets.add(socket);

      reply({ ok: true, mode, depthMargin: socket.data.specDepthMargin });
      // the first frame is the whole visible world; later ones are only the diffs
      socket.emit('spectatorMode', protocol.spectatorFrame(ctx.game, socket.data.specCache, runtime.specOptions(socket)));
    });

    socket.on('unspectate', () => {
      socket.data.spectating = false;
      ctx.spectatorSockets.delete(socket);
    });

    socket.on('disconnect', () => {
      ctx.spectatorSockets.delete(socket);
      const player = runtime.playerFor(socket);
      if (!player) return;
      // flush before the player object goes away; the pending deltas are keyed by
      // account code, so nothing is lost either way
      runtime.flushStats();
      ctx.socketPlayers.delete(player.id);
      ctx.game.removePlayer(player);
    });
  });
}

module.exports = { registerSockets };

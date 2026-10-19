'use strict';

// ---------- Admin ----------
// The one HTTP route a run can be started from. It is off unless RESET_SECRET is
// set, so the endpoint simply does not exist on a public server.

const ctx = require('./context');
const runtime = require('./runtime');

function registerAdmin() {
  if (!ctx.config.RESET_SECRET) return;
  ctx.app.post('/api/reset', (req, res) => {
    if (req.query.secret !== ctx.config.RESET_SECRET) {
      res.status(403).json({ error: 'Invalid secret' });
      return;
    }
    const { finished } = runtime.resetGame();
    res.json({ ok: true, message: 'New game started', previousWorld: finished ? finished.id : null });
  });
}

module.exports = { registerAdmin };

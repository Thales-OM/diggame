'use strict';

// ---------- Emotes ----------
// The emotes a player may send, by id. The glyph and the picker live in the
// browser (public/js/constants.js); the server only has to agree on the ids, so
// it can reject anything that is not on this list.

/** The emotes a player may send, by id. */
const EMOTES = ['wave', 'smile', 'shout', 'oops', 'thumbsup'];

module.exports = { EMOTES };

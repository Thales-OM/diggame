// ---------- Net ----------
// The one socket. It lives alone so anything that needs to send can import
// it without a cycle.

export const socket = io();

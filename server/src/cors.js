// One CORS rule, shared by Express and Socket.IO so they can never disagree.
//
// Any localhost / 127.0.0.1 origin is allowed, whatever the port. Vite picks
// 5174 when 5173 is busy, and a hard-coded port turns that into a confusing
// CORS error. Anything that isn't localhost must match CLIENT_ORIGIN exactly.

const explicit = process.env.CLIENT_ORIGIN ?? 'http://localhost:5173';
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function corsOrigin(origin, callback) {
  // No origin = same-origin request or curl. Allow.
  if (!origin || LOCAL.test(origin) || origin === explicit) return callback(null, true);
  callback(new Error(`CORS: origin ${origin} not allowed`));
}

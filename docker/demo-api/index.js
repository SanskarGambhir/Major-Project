// demo-api — a crash-test dummy.
//
// This service does no useful work. It exists so we can break it in realistic
// ways and let the operating system produce REAL failures for our platform to
// detect, investigate, and fix.
//
// Nothing here fakes a failure state. We create real causes; Linux and Docker
// produce the real consequences.

import express from 'express';
import net from 'node:net';

const app = express();

const PORT       = parseInt(process.env.PORT ?? '3001', 10);
const DB_HOST    = process.env.DB_HOST ?? 'demo-db';
const DB_PORT    = parseInt(process.env.DB_PORT ?? '5432', 10);
const CACHE_HOST = process.env.CACHE_HOST ?? 'demo-cache';
const CACHE_PORT = parseInt(process.env.CACHE_PORT ?? '6379', 10);

// --- fault state -----------------------------------------------------------
let leaked = [];          // Buffers we deliberately never free
let leakTimer = null;
let cpuBurnUntil = 0;
let errorTimer = null;
let batch = 1000;

const mb = (bytes) => Math.round(bytes / 1024 / 1024);

// --- normal behaviour ------------------------------------------------------

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    rssMb: mb(process.memoryUsage().rss),
  });
});

app.get('/', (req, res) => {
  res.json({ service: 'demo-api', status: 'running' });
});

// --- FAULT: memory leak ----------------------------------------------------
//
// Buffers live OUTSIDE the JS heap, so they count directly against the
// container's memory limit. That means the LINUX KERNEL kills this process
// (exit 137, OOMKilled: true) rather than Node failing gracefully — which is
// exactly the real forensic evidence we want the AI to investigate.

app.get('/debug/leak', (req, res) => {
  const targetMb = parseInt(req.query.mb ?? '400', 10);
  if (leakTimer) return res.json({ ok: true, message: 'leak already running' });

  console.log(`[FAULT] Memory leak started — allocating up to ${targetMb} MB`);
  let allocated = 0;

  leakTimer = setInterval(() => {
    leaked.push(Buffer.alloc(10 * 1024 * 1024, 1));   // 10 MB, filled so pages commit
    allocated += 10;
    console.warn(`WARN Heap usage high — rss ${mb(process.memoryUsage().rss)} MB (leaked ${allocated} MB)`);
    if (allocated >= targetMb) {
      clearInterval(leakTimer);
      leakTimer = null;
    }
  }, 200);

  res.json({ ok: true, message: `leaking up to ${targetMb} MB` });
});

// --- FAULT: CPU spike ------------------------------------------------------

app.get('/debug/cpu', (req, res) => {
  const seconds = parseInt(req.query.seconds ?? '30', 10);
  const wasIdle = cpuBurnUntil < Date.now();
  cpuBurnUntil = Date.now() + seconds * 1000;

  console.log(`[FAULT] CPU burn started for ${seconds}s`);
  res.json({ ok: true, message: `burning CPU for ${seconds}s` });

  if (wasIdle) burnCpu();
});

function burnCpu() {
  if (Date.now() >= cpuBurnUntil) {
    console.log('[FAULT] CPU burn finished');
    return;
  }
  // Burn in 40ms slices, yielding between them, so /health still answers.
  // A fully blocked event loop would fail the healthcheck and give us a
  // "container unhealthy" incident instead of the "high CPU" one we want.
  const sliceEnd = Date.now() + 40;
  while (Date.now() < sliceEnd) Math.sqrt(Math.random());
  setImmediate(burnCpu);
}

// --- FAULT: error storm ----------------------------------------------------

const ERRORS = [
  `ERROR Database connection failed: ECONNREFUSED ${DB_HOST}:${DB_PORT}`,
  'ERROR Request timeout after 30000ms',
  'ERROR Service unavailable: upstream returned 503',
  'ERROR Failed to acquire connection from pool (0 idle, 10 waiting)',
];

app.get('/debug/error', (req, res) => {
  const seconds = parseInt(req.query.seconds ?? '60', 10);
  if (errorTimer) return res.json({ ok: true, message: 'error storm already running' });

  const stopAt = Date.now() + seconds * 1000;
  console.log(`[FAULT] Error storm started for ${seconds}s`);

  errorTimer = setInterval(() => {
    console.error(ERRORS[Math.floor(Math.random() * ERRORS.length)]);
    if (Date.now() >= stopAt) {
      clearInterval(errorTimer);
      errorTimer = null;
      console.log('[FAULT] Error storm finished');
    }
  }, 300);

  res.json({ ok: true, message: `erroring for ${seconds}s` });
});

// --- reset -----------------------------------------------------------------

app.get('/debug/reset', (req, res) => {
  if (leakTimer)  { clearInterval(leakTimer);  leakTimer = null; }
  if (errorTimer) { clearInterval(errorTimer); errorTimer = null; }
  leaked = [];
  cpuBurnUntil = 0;
  console.log('[FAULT] All faults cleared');
  res.json({ ok: true, message: 'faults cleared' });
});

// --- background work + REAL dependency checks ------------------------------
//
// This is what produces genuine error logs when you run `docker stop demo-db`.
// We are not printing fake errors — the TCP connection actually fails.

function checkPort(host, port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok, err) => { sock.destroy(); resolve({ ok, err }); };
    sock.setTimeout(2000);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false, 'ETIMEDOUT'));
    sock.once('error', (e) => done(false, e.code ?? e.message));
  });
}

setInterval(async () => {
  console.log(`INFO Processing batch ${batch++}`);

  const db = await checkPort(DB_HOST, DB_PORT);
  if (!db.ok) console.error(`ERROR Database connection failed: ${db.err} ${DB_HOST}:${DB_PORT}`);

  const cache = await checkPort(CACHE_HOST, CACHE_PORT);
  if (!cache.ok) console.error(`ERROR Cache connection failed: ${cache.err} ${CACHE_HOST}:${CACHE_PORT}`);
}, 5000);

app.listen(PORT, () => console.log(`INFO demo-api listening on port ${PORT}`));

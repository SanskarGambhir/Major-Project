// =============================================================================
// Container logs, cleaned up enough to show a person or feed to an AI.
//
// THE HIDDEN HEADER (plan §5, trap 3)
// ---------------------------------------------------------------------------
// When a container runs without a TTY (ours do), Docker prefixes EVERY log
// line with an 8-byte binary header: [stream type][0][0][0][length ×4].
// Your terminal quietly drops those bytes, so `docker logs` looks fine and
// you'd never know. But if you paste the raw buffer into an AI prompt, the
// model sees garbage bytes between lines and the analysis quality collapses.
//
// docker.modem.demuxStream() knows the format and splits it into clean
// stdout / stderr streams. We collect both.
// =============================================================================

import { PassThrough } from 'node:stream';
import { docker, withTimeout } from './client.js';

/**
 * Last `tail` lines of a container's logs, header-free, as plain strings.
 * Returns [] rather than throwing if the container is gone — logs are
 * evidence, and missing evidence shouldn't crash the investigation.
 */
export async function getCleanLogs(name, { tail = 200 } = {}) {
  let buffer;
  try {
    buffer = await withTimeout(
      docker.getContainer(name).logs({ stdout: true, stderr: true, tail, timestamps: false }),
      5000,
      `logs ${name}`
    );
  } catch (err) {
    if (err.statusCode === 404) return [];
    throw err;
  }

  // With `follow: false` dockerode returns a Buffer, but it is still in the
  // multiplexed format. Feed it through demuxStream to strip the headers.
  const out = new PassThrough();
  const err = new PassThrough();
  const chunks = [];
  out.on('data', (c) => chunks.push(c));
  err.on('data', (c) => chunks.push(c));

  const src = new PassThrough();
  docker.modem.demuxStream(src, out, err);
  src.end(buffer);

  // demuxStream writes synchronously as data flows; give the event loop one
  // turn so the last chunk lands before we read.
  await new Promise((r) => setImmediate(r));

  return Buffer.concat(chunks)
    .toString('utf8')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean);
}

/**
 * Collapse consecutive duplicate lines into "line (×N)".
 *
 * An error storm writes the same line 500 times. To a person that's noise;
 * to an LLM it's 500 lines of prompt budget spent on one fact. After
 * compacting, the same evidence costs one line: "ECONNREFUSED demo-db (×500)".
 */
export function compactLogs(lines) {
  const result = [];
  let prev = null;
  let count = 0;

  const flush = () => {
    if (prev === null) return;
    result.push(count > 1 ? `${prev}  (×${count})` : prev);
  };

  for (const line of lines) {
    // Strip a leading ISO timestamp so "same message, different second"
    // still counts as a duplicate.
    const key = line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s*/, '');
    if (key === prev) {
      count++;
    } else {
      flush();
      prev = key;
      count = 1;
    }
  }
  flush();
  return result;
}

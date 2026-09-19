// =============================================================================
// Docker client — the ONE connection to the Docker engine.
//
// Every other file that needs Docker imports from here. Nobody else creates a
// Dockerode instance, so there is exactly one place to change the socket path
// and exactly one place to put a timeout.
//
// WHY THE TIMEOUT WRAPPER EXISTS
// ---------------------------------------------------------------------------
// Dockerode has no default timeout. If the Docker daemon hangs (it does, on
// Windows, when Docker Desktop is restarting) a call like container.stats()
// simply never returns. That would freeze the poller forever with no error,
// no log line, nothing — the dashboard would just stop updating. Wrapping
// every call in withTimeout() turns a silent hang into a loud, handleable
// rejection.
// =============================================================================

import Docker from 'dockerode';

// Windows named pipe by default; Linux/macOS use /var/run/docker.sock.
const socketPath = process.env.DOCKER_SOCKET || '//./pipe/docker_engine';

export const docker = new Docker({ socketPath });

// Labels that decide what a container IS. Set in the compose files.
export const LABEL_PLATFORM = 'sre.platform';   // ours — never a target
export const LABEL_DEMO     = 'sre.demo';       // the things we're allowed to fix

/**
 * Race a promise against a timer.
 *
 * @param {Promise} promise
 * @param {number} ms
 * @param {string} what   — used in the error message so you know which call hung
 */
export function withTimeout(promise, ms, what = 'docker call') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * List every container we care about — anything carrying one of our labels.
 *
 * `all: true` matters: a container that has EXITED is exactly the one we most
 * want to see, and without `all` Docker only returns running ones.
 */
export async function listOurContainers() {
  const containers = await withTimeout(
    docker.listContainers({ all: true }),
    5000,
    'listContainers'
  );
  return containers.filter(
    (c) => c.Labels?.[LABEL_PLATFORM] === 'true' || c.Labels?.[LABEL_DEMO] === 'true'
  );
}

/**
 * Full inspect for one container. This is where ExitCode and OOMKilled live.
 * Returns null if the container doesn't exist (e.g. it was removed).
 */
export async function inspect(name) {
  try {
    return await withTimeout(docker.getContainer(name).inspect(), 5000, `inspect ${name}`);
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

/** Is the Docker daemon reachable at all? Used by /api/health and startup. */
export async function ping() {
  try {
    await withTimeout(docker.ping(), 3000, 'ping');
    return true;
  } catch {
    return false;
  }
}

/**
 * paths.ts: where the bot's runtime state lives.
 *
 * STATE_DIR (or, when it is unset, the absolute path in the untracked marker REPO_DIR/.state-dir)
 * moves the state out of the repo on the droplet. Layout rule: every folder the poller lists, reads
 * or writes in sits in a parent the turn cannot write; the turn writes only inside fixed folders
 * under shared/. Neither set (the PC, the tests, the rollback state): the repo folder, the old
 * layout. Per-store env overrides still win.
 */
import { constants, closeSync, existsSync, fchmodSync, fstatSync, openSync, readFileSync, readSync, renameSync, rmSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, isAbsolute, resolve, sep } from "node:path";

type Env = Record<string, string | undefined>;
export const REPO_DIR = import.meta.dir;
const SHARED_DIRS = new Set(["memory", "skills", "data", "cc-digest", "rchannel-proposals"]);

function marker(): string | null {
  const p = join(REPO_DIR, ".state-dir");
  if (!existsSync(p)) return null;
  const line = readFileSync(p, "utf8").split("\n")[0].trim();
  return line && (line.startsWith("/") || isAbsolute(line)) ? line : null;
}

export function stateDir(env: Env = process.env): string {
  if (env.STATE_DIR) return env.STATE_DIR;
  return marker() ?? REPO_DIR;
}
export function statePathIn(env: Env, ...parts: string[]): string {
  return join(stateDir(env), ...parts);
}
export function sharedPathIn(env: Env, ...parts: string[]): string {
  const s = stateDir(env);
  if (s === REPO_DIR) return join(REPO_DIR, ...parts);
  return SHARED_DIRS.has(parts[0]) ? join(s, "shared", ...parts) : join(s, "shared", "stores", ...parts);
}
export function statePath(...parts: string[]): string {
  return statePathIn(process.env, ...parts);
}
export function sharedPath(...parts: string[]): string {
  return sharedPathIn(process.env, ...parts);
}

/** The exact mode a state file gets, whatever the writer's umask: 0660 under shared/ (the turn's
 *  group writes there), 0640 elsewhere under the state folder (poller-only), and as created in the
 *  repo layout (the PC, the tests, the rollback state). */
function modeFor(path: string): number | null {
  const s = stateDir();
  if (s === REPO_DIR) return null;
  const p = resolve(path);
  if (p.startsWith(resolve(s, "shared") + sep)) return 0o660;
  if (p.startsWith(resolve(s) + sep)) return 0o640;
  return null;
}

/** Write every byte: a write may return short (a signal, a full pipe or disk), so loop from where
 *  the last one stopped; a write that makes no progress throws instead of spinning. */
export function writeAll(
  fd: number,
  buf: Uint8Array,
  write: (fd: number, buf: Uint8Array, offset: number, length: number) => number = writeSync,
): void {
  let off = 0;
  while (off < buf.length) {
    const n = write(fd, buf, off, buf.length - off);
    if (!(n > 0)) throw new Error(`short write: ${off} of ${buf.length} bytes, then ${n}`);
    off += n;
  }
}

/** Atomic replace that never writes through a planted link: a fresh, exclusively created temp
 *  with a random name, the exact mode set on the open handle, then a rename (which replaces a link
 *  at the target rather than following it). The temp is removed on failure; no folder is made. */
export function writeAtomic(path: string, data: string | Uint8Array): void {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(tmp, "wx");
    writeAll(fd, typeof data === "string" ? Buffer.from(data) : data);
    const m = modeFor(path);
    if (m !== null) fchmodSync(fd, m);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
  } catch (e) {
    if (fd !== null) try { closeSync(fd); } catch {}
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Read a state file without following a link at its last component and without blocking on a
 *  FIFO; anything but a regular file, or a file over maxBytes, throws. A missing file throws
 *  ENOENT exactly like readFileSync, so callers keep their missing-file handling. */
export function readNoFollow(path: string, maxBytes = 8 * 1024 * 1024): string {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`not a regular file: ${path}`);
    if (st.size > maxBytes) throw new Error(`file over cap: ${path}`);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

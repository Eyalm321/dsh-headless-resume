/**
 * The key -> sessionId map that gives a one-shot process something to resume.
 *
 * Kept deliberately dumb and separate from the runner so it can be unit-tested
 * without a harness: a JSON object written atomically, because a half-written
 * index would lose exactly the continuity this plugin exists to provide.
 *
 * @module dsh-headless-resume/sessionIndex
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Read the index, tolerating absence and corruption alike (both mean "no prior session"). */
export function readIndex(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // A corrupt index must not strand the run: the worst case is one lost thread,
    // which the next successful write repairs.
    return {};
  }
}

/** Write the index atomically. Returns the object that was written. */
export function writeIndex(path, index) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(index, null, 1)}\n`);
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* the temp file may never have been created */ }
    throw error;
  }
  return index;
}

/** The session id previously recorded for `key`, or undefined. */
export function lookup(path, key) {
  const value = readIndex(path)[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Record `sessionId` for `key`, preserving every other entry. */
export function record(path, key, sessionId) {
  const index = readIndex(path);
  index[key] = sessionId;
  return writeIndex(path, index);
}

/** Forget one key (used by --forget style callers and by tests). */
export function forget(path, key) {
  const index = readIndex(path);
  delete index[key];
  return writeIndex(path, index);
}

/**
 * The default thread key. Resuming carries the persisted session's own cwd, so
 * keying by cwd keeps a resumed thread and its working directory consistent;
 * an explicit key (a project name) is expected to be used from one directory.
 */
export function defaultKey(cwd) {
  return `cwd:${cwd}`;
}

/** Where the index lives when a deployment configures no path. */
export function defaultIndexPath(home, cwd) {
  return join(home ?? cwd, 'session-index.json');
}

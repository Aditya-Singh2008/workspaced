/**
 * Where the session record is kept.
 *
 * One tiny interface with two implementations, for one reason: the Tauri store
 * plugin is the real one and cannot run anywhere except inside the app, and
 * everything interesting about this phase — the debounce, the version gating,
 * the per-tile failure handling — is logic that has nothing to do with where
 * the bytes land. Injecting the backend is what lets the self-test drive all of
 * it against a map in memory, and it is the same move `runWorkspaceSearch`
 * makes with `instanceFor`.
 *
 * ## Why a whole file rather than one key
 *
 * `session.json` in the app's data directory, one key inside it. The store
 * plugin is a key-value store per file, so a second thing worth persisting
 * later (a recent-files list, a window size) gets its own file rather than
 * sharing a namespace with a record that is rewritten wholesale.
 *
 * ## The memory fallback is not a feature
 *
 * Outside the Tauri shell — the dev browser, a bundled self-test run — there is
 * no store plugin and no app data directory, so the backend is a variable that
 * disappears when the page does. That is the honest behaviour: nothing is
 * silently written somewhere else (a `localStorage` fallback would make the app
 * appear to persist in a context where the real path is untested), and nothing
 * crashes at startup because an IPC call went nowhere. It says so once, in the
 * dev log, so a broken IPC path in the real app is visible rather than looking
 * like a session that simply had nothing in it.
 */

import type { PersistedSession } from "./record";

/** The store file, in the OS's app-data directory for this app. */
export const SESSION_STORE_FILE = "session.json";

/** The one key inside it. */
export const SESSION_STORE_KEY = "session";

export interface SessionStorage {
  /** Diagnostic only; the self-test and the dev log both report it. */
  readonly kind: "tauri" | "memory";
  /** The raw stored value, unvalidated. `undefined` when nothing is saved. */
  read(): Promise<unknown>;
  write(session: PersistedSession): Promise<void>;
  clear(): Promise<void>;
}

/** A backend that forgets everything when the page does. */
export function createMemorySessionStorage(): SessionStorage {
  let held: unknown;
  return {
    kind: "memory",
    read: async () => held,
    // Through JSON on the way in, so a value the real backend would reject
    // fails here too rather than passing a test it would fail in the app.
    write: async (session) => {
      held = JSON.parse(JSON.stringify(session)) as unknown;
    },
    clear: async () => {
      held = undefined;
    },
  };
}

/**
 * The Tauri store plugin.
 *
 * `autoSave: false` because the debounce belongs to `session.ts`, which knows
 * what changed and can coalesce a drag; letting the plugin also debounce would
 * be two timers deciding the same thing.
 */
async function createTauriSessionStorage(): Promise<SessionStorage> {
  const { load } = await import("@tauri-apps/plugin-store");
  const store = await load(SESSION_STORE_FILE, { autoSave: false });

  return {
    kind: "tauri",
    read: () => store.get(SESSION_STORE_KEY),
    write: async (session) => {
      await store.set(SESSION_STORE_KEY, session);
      await store.save();
    },
    clear: async () => {
      await store.clear();
      await store.save();
    },
  };
}

let backend: Promise<SessionStorage> | null = null;

/**
 * The backend, resolved once.
 *
 * Falls back rather than rejecting: a session that cannot be loaded must still
 * leave a usable app, and every caller here treats "nothing saved" and "could
 * not read" identically anyway.
 */
export function sessionStorage(): Promise<SessionStorage> {
  backend ??= createTauriSessionStorage().catch((thrown) => {
    if (import.meta.env.DEV) {
      void import("../dev/log").then(({ devLog }) =>
        devLog(
          `persistence: no Tauri store (${
            thrown instanceof Error ? thrown.message : String(thrown)
          }) — this session will not be saved`,
        ),
      );
    }
    return createMemorySessionStorage();
  });
  return backend;
}

/**
 * Replaces the backend, or (with `null`) forgets the resolved one.
 *
 * The app never calls this: it is the seam an out-of-app verification harness
 * uses to point the *real* `App` at a store that survives a page reload, which
 * is the only way to drive a save and a restore across an actual restart
 * outside the Tauri shell. The self-test does not need it — `restoreSession`
 * and `createSessionWriter` both take a backend directly, which is the narrower
 * injection and cannot leave the app pointed somewhere else afterwards.
 */
export function setSessionStorage(storage: SessionStorage | null): void {
  backend = storage ? Promise.resolve(storage) : null;
}

/**
 * What the workspace shows with nothing open.
 *
 * The toolbar and sidebar are rendered by `App` and stay visible here, so this
 * is only the middle of the window.
 */

import { useOpenFiles } from "../shell/openFiles";
import { DevSelfTestPanel } from "./DevSelfTestPanel";

export function EmptyState() {
  const { open, busy, problem } = useOpenFiles();

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-6 overflow-y-auto bg-bg">
      <p className="text-muted">no files open</p>

      <button
        type="button"
        onClick={() => void open()}
        disabled={busy}
        className="border border-border px-4 py-1.5 text-fg-dim hover:bg-surface-hover hover:text-fg disabled:text-disabled disabled:hover:bg-transparent"
      >
        {busy ? "opening…" : "open file"}
      </button>

      {problem ? <p className="text-error">{problem}</p> : null}

      {import.meta.env.DEV ? <DevSelfTestPanel /> : null}
    </div>
  );
}

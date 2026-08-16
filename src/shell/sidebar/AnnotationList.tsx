/**
 * The annotation list: every mark on the focused document, newest first.
 *
 * The same shell-owns-the-UI / plugin-owns-the-data split as the subdivision
 * rail, and it contains no more file-type vocabulary than that one does. It asks
 * the focused instance for {@link AnnotationSummary} values — a word for the
 * type, a short label, a subdivision, a rect, a time — and it can do exactly two
 * things with them: jump, through the same `reveal(location)` every other
 * navigation in this app goes through, and delete, through the contract's
 * `removeAnnotation`. It never sees a stroke, a colour or an image.
 *
 * "Page 3" is not spelled anywhere here for the same reason: a subdivision is a
 * page in a PDF and a keyframe in a video, and the shell is not allowed to know
 * which. The row says `3` under a `#` heading, which is true of both.
 */

import { useCallback, useEffect, useState } from "react";

import { getViewerInstance, type AnnotationSummary } from "../../viewers";

export function AnnotationList({ clientId }: { readonly clientId: string }) {
  const [items, setItems] = useState<readonly AnnotationSummary[]>([]);

  // Subscribed rather than polled, and re-read on every notification: the
  // plugin's own tools are what change this list, and a mark drawn in the tile
  // has to appear here without anything else happening.
  useEffect(() => {
    const instance = getViewerInstance(clientId);
    const annotation = instance?.capabilities.annotation ? instance.annotation : undefined;
    if (!annotation) {
      setItems([]);
      return;
    }
    const publish = () => setItems(annotation.listAnnotations());
    publish();
    return annotation.onAnnotationsChange(publish);
  }, [clientId]);

  const reveal = useCallback(
    (item: AnnotationSummary) => {
      const instance = getViewerInstance(clientId);
      // Feature-detected, exactly as the rail does it: `reveal` is optional on
      // the contract, and a plugin without it still gets a working list.
      void instance?.reveal?.({ subdivision: item.subdivision, rect: item.rect });
    },
    [clientId],
  );

  const remove = useCallback(
    (id: string) => {
      const instance = getViewerInstance(clientId);
      instance?.annotation?.removeAnnotation(id);
    },
    [clientId],
  );

  if (items.length === 0) {
    return (
      <p className="min-h-0 grow overflow-y-auto px-2 py-1 text-muted">
        nothing annotated yet
      </p>
    );
  }

  return (
    <div className="min-h-0 grow overflow-y-auto">
      {items.map((item) => (
        <div
          key={item.id}
          className="flex items-baseline gap-1 border-l border-l-transparent pl-1 pr-1 text-muted hover:bg-surface-hover"
        >
          <button
            type="button"
            onClick={() => reveal(item)}
            title={`${item.type} — ${item.label}`}
            className="flex min-w-0 grow items-baseline gap-2 py-1 text-left"
          >
            <span className="w-6 shrink-0 text-right text-disabled">
              {item.subdivision + 1}
            </span>
            <span className="w-10 shrink-0 truncate text-fg-dim">{item.type}</span>
            <span className="min-w-0 grow truncate">{item.label}</span>
          </button>
          <button
            type="button"
            onClick={() => remove(item.id)}
            aria-label={`delete ${item.type}`}
            className="shrink-0 px-1 text-muted hover:text-error"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

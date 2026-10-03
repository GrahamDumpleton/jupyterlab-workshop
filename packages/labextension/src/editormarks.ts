import {
  Extension,
  Range,
  RangeSet,
  StateEffect,
  StateField
} from '@codemirror/state';
import {
  Decoration,
  DecorationSet,
  EditorView,
  GutterMarker,
  WidgetType,
  gutterLineClass
} from '@codemirror/view';
import { CodeEditor } from '@jupyterlab/codeeditor';
import { CodeMirrorEditor } from '@jupyterlab/codemirror';
import { IOffsetSpan } from '@jupyterlab-workshop/core';

/**
 * Marks an action leaves on text in an editor, drawn as decorations
 * rather than as the selection, so a stray key press cannot replace the
 * text they cover: `changed` is text an action has just written, or the
 * place it deleted text from, kept until the next action runs, and
 * `pointed` is text an action is pointing at, kept for a moment.
 */
type MarkKind = 'changed' | 'pointed';

/**
 * A span of text an action changed. An empty span is where text was
 * deleted, and `wholeLines` says the deletion took whole lines, so it
 * lies between two lines rather than within one.
 */
export interface IChangedSpan extends IOffsetSpan {
  wholeLines?: boolean;
}

/** The marks one editor holds. */
interface IMarks {
  changed: DecorationSet;
  pointed: DecorationSet;
  gutter: RangeSet<GutterMarker>;
}

/** The spans to mark as one kind, replacing the marks of that kind. */
interface IMarkRequest {
  kind: MarkKind;
  spans: IChangedSpan[];
}

const setMarks = StateEffect.define<IMarkRequest>();

const lineDecorations: Record<MarkKind, Decoration> = {
  changed: Decoration.line({ class: 'jp-WorkshopEditor-changedLine' }),
  pointed: Decoration.line({ class: 'jp-WorkshopEditor-pointedLine' })
};

const textDecorations: Record<MarkKind, Decoration> = {
  changed: Decoration.mark({ class: 'jp-WorkshopEditor-changedText' }),
  pointed: Decoration.mark({ class: 'jp-WorkshopEditor-pointedText' })
};

/** The bar beside the line numbers of lines an action changed. */
class ChangedGutterMarker extends GutterMarker {
  elementClass = 'jp-WorkshopEditor-changedGutter';
}

const changedGutterMarker = new ChangedGutterMarker();

/** The triangle beside a line that whole lines were deleted above. */
class DeletedAboveGutterMarker extends GutterMarker {
  elementClass = 'jp-WorkshopEditor-deletedAbove';
}

const deletedAboveGutterMarker = new DeletedAboveGutterMarker();

/** The triangle beside a line that text was deleted from. */
class DeletedWithinGutterMarker extends GutterMarker {
  elementClass = 'jp-WorkshopEditor-deletedWithin';
}

const deletedWithinGutterMarker = new DeletedWithinGutterMarker();

/** The tick in a line at the point text was deleted from it. */
class DeletedTickWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const tick = document.createElement('span');

    tick.className = 'jp-WorkshopEditor-deletedTick';
    tick.setAttribute('aria-hidden', 'true');

    return tick;
  }
}

const deletedTick = Decoration.widget({
  widget: new DeletedTickWidget(),
  side: -1
});

const marksField = StateField.define<IMarks>({
  create(): IMarks {
    return {
      changed: Decoration.none,
      pointed: Decoration.none,
      gutter: RangeSet.empty
    };
  },

  update(marks, transaction): IMarks {
    let next = marks;

    // Marks follow their text through edits made around them.
    if (transaction.docChanged) {
      next = {
        changed: marks.changed.map(transaction.changes),
        pointed: marks.pointed.map(transaction.changes),
        gutter: marks.gutter.map(transaction.changes)
      };
    }

    for (const effect of transaction.effects) {
      if (!effect.is(setMarks)) {
        continue;
      }

      const { decorations, gutter } = decorate(
        transaction.state.doc,
        effect.value
      );

      if (effect.value.kind === 'changed') {
        next = { ...next, changed: decorations, gutter };
      } else {
        next = { ...next, pointed: decorations };
      }
    }

    return next;
  },

  provide(field): Extension {
    return [
      EditorView.decorations.from(field, marks => marks.changed),
      EditorView.decorations.from(field, marks => marks.pointed),
      gutterLineClass.from(field, marks => marks.gutter)
    ];
  }
});

/**
 * The decorations for a request: a line a span covers whole is tinted
 * across its width, and one it covers in part is tinted over that part.
 * An empty span of changed text is a deletion, marked by a tick in the
 * line unless it took whole lines. Also returns the gutter markers of
 * the lines touched: a bar for new text and a triangle for a deletion.
 */
function decorate(
  doc: EditorView['state']['doc'],
  request: IMarkRequest
): { decorations: DecorationSet; gutter: RangeSet<GutterMarker> } {
  const ranges: Range<Decoration>[] = [];
  const gutter = new Map<GutterMarker, Set<number>>();

  const addGutter = (marker: GutterMarker, lineStart: number): void => {
    if (request.kind !== 'changed') {
      return;
    }

    if (!gutter.has(marker)) {
      gutter.set(marker, new Set());
    }

    gutter.get(marker)?.add(lineStart);
  };

  for (const span of request.spans) {
    const from = Math.max(0, Math.min(span.start, doc.length));
    const to = Math.max(from, Math.min(span.end, doc.length));

    if (to === from) {
      if (request.kind === 'changed') {
        const line = doc.lineAt(from);

        if (span.wholeLines) {
          addGutter(deletedAboveGutterMarker, line.from);
        } else {
          addGutter(deletedWithinGutterMarker, line.from);
          ranges.push(deletedTick.range(from));
        }
      }

      continue;
    }

    // A span that ends at the start of a line took the newline before
    // it, not anything of that line.
    for (let line = doc.lineAt(from); line.from < to;) {
      addGutter(changedGutterMarker, line.from);

      if (from <= line.from && to >= line.to) {
        ranges.push(lineDecorations[request.kind].range(line.from));
      } else {
        const start = Math.max(from, line.from);
        const end = Math.min(to, line.to);

        if (end > start) {
          ranges.push(textDecorations[request.kind].range(start, end));
        }
      }

      if (line.number >= doc.lines) {
        break;
      }

      line = doc.line(line.number + 1);
    }
  }

  const gutterRanges: Range<GutterMarker>[] = [];

  for (const [marker, lineStarts] of gutter) {
    for (const lineStart of lineStarts) {
      gutterRanges.push(marker.range(lineStart));
    }
  }

  return {
    decorations: Decoration.set(ranges, true),
    gutter: RangeSet.of(gutterRanges, true)
  };
}

/** The editors holding `changed` marks, to clear when an action runs. */
const changedViews = new Set<EditorView>();

/** The timer that takes each editor's `pointed` mark away. */
const pointedTimers = new WeakMap<EditorView, number>();

/**
 * The CodeMirror view behind an editor, or undefined for an editor of
 * another kind.
 */
export function editorView(editor: CodeEditor.IEditor): EditorView | undefined {
  return editor instanceof CodeMirrorEditor ? editor.editor : undefined;
}

/**
 * Mark spans of an editor's text, replacing its marks of that kind. The
 * marks are added to the editor the first time it is given one.
 */
function mark(view: EditorView, request: IMarkRequest): void {
  const effects: StateEffect<unknown>[] = [];

  if (view.state.field(marksField, false) === undefined) {
    effects.push(StateEffect.appendConfig.of(marksField));
  }

  effects.push(setMarks.of(request));
  view.dispatch({ effects });
}

/**
 * Mark what an action has just changed in an editor, until the next
 * action runs: text it wrote is tinted, with a bar beside its line
 * numbers, and a place it deleted text from, given as an empty span,
 * gets a triangle beside the line numbers and, within a line, a tick.
 */
export function markChanged(
  editor: CodeEditor.IEditor,
  spans: IChangedSpan[]
): void {
  const view = editorView(editor);

  if (!view) {
    return;
  }

  mark(view, { kind: 'changed', spans });
  changedViews.add(view);
}

/**
 * Take away the marks on text earlier actions wrote, in every editor.
 */
export function clearChangedMarks(): void {
  for (const view of changedViews) {
    mark(view, { kind: 'changed', spans: [] });
  }

  changedViews.clear();
}

/**
 * Mark text an action is pointing at in an editor, tinting it for the
 * given number of milliseconds. A later call replaces the mark an
 * earlier one left.
 */
export function markPointed(
  editor: CodeEditor.IEditor,
  span: IOffsetSpan,
  duration: number
): void {
  const view = editorView(editor);

  if (!view) {
    return;
  }

  window.clearTimeout(pointedTimers.get(view));
  mark(view, { kind: 'pointed', spans: [span] });

  pointedTimers.set(
    view,
    window.setTimeout(() => {
      mark(view, { kind: 'pointed', spans: [] });
    }, duration)
  );
}

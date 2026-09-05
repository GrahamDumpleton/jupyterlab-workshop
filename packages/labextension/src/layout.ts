import { ILayoutSpec } from '@educates/workshop-core';
import { ILabShell, JupyterFrontEnd } from '@jupyterlab/application';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { Widget } from '@lumino/widgets';

import { openEditor } from './actions/files';
import { TerminalSessions } from './actions/terminal';
import { IWorkshopManager } from './tokens';

/** Layouts available to every workshop. */
export const BUILTIN_LAYOUTS: Readonly<Record<string, ILayoutSpec>> = {
  default: {
    left: 'instructions',
    main: [{ area: 'bottom', widgets: ['terminal:workshop'] }]
  },
  'terminal-only': {
    left: 'instructions',
    main: [{ area: 'top', widgets: ['terminal:workshop'] }]
  },
  notebook: {
    left: 'instructions',
    main: []
  }
};

/** Services the layout manager needs. */
export interface ILayoutContext {
  app: JupyterFrontEnd;
  shell: ILabShell;
  manager: IWorkshopManager;
  terminals: TerminalSessions;
  docManager: IDocumentManager;

  /** Id of the instructions panel widget. */
  panelId: string;
}

/**
 * Arranges JupyterLab panels according to a named layout from the
 * manifest or the built-in set. The arrangement is approximate: widgets
 * are added with split and tab modes and the learner may rearrange them.
 */
export class LayoutManager {
  constructor(context: ILayoutContext) {
    this._context = context;
  }

  /**
   * Find a layout by name in the manifest, then the built-ins.
   */
  find(name: string): ILayoutSpec | undefined {
    return (
      this._context.manager.workshop?.manifest.layouts[name] ??
      BUILTIN_LAYOUTS[name]
    );
  }

  /**
   * Apply a named layout.
   */
  async apply(name: string): Promise<void> {
    const spec = this.find(name);

    if (!spec) {
      throw new Error(`Unknown layout "${name}"`);
    }

    const { shell } = this._context;
    let anchor: Widget | null = null;

    for (const area of spec.main) {
      const widgets: Widget[] = [];

      for (const reference of area.widgets) {
        const widget = await this._resolve(reference);

        if (widget) {
          widgets.push(widget);
        }
      }

      if (widgets.length === 0) {
        continue;
      }

      // The first widget of an area splits off the previous area; the rest
      // become tabs beside it.
      const [first, ...rest] = widgets;

      // Areas split the dock: the first relative to the whole main area, the
      // rest relative to the previous area's first widget.
      shell.add(first, 'main', {
        mode: `split-${area.area}`,
        ref: anchor ? anchor.id : null,
        activate: false
      });

      for (const widget of rest) {
        shell.add(widget, 'main', {
          mode: 'tab-after',
          ref: first.id,
          activate: false
        });
      }

      anchor = first;
    }

    if (spec.left === 'instructions') {
      shell.activateById(this._context.panelId);
    } else if (spec.left) {
      shell.activateById(spec.left);
    }

    if (spec.right) {
      shell.activateById(spec.right);
    }
  }

  private async _resolve(reference: string): Promise<Widget | null> {
    const { app, manager, terminals, docManager } = this._context;
    const [kind, ...rest] = reference.split(':');
    const target = rest.join(':');

    switch (kind) {
      case 'terminal':
        return terminals.get(target || 'workshop', {
          cwd: manager.workshop?.path
        });
      case 'editor':
        return this._context.app.shell.currentWidget ?? null;
      case 'file':
        return openEditor(
          { app, docManager, editorTracker: null, manager, terminals },
          manager.resolvePath(target)
        );
      case 'notebook':
        return (
          docManager.openOrReveal(manager.resolvePath(target), 'Notebook') ??
          null
        );
      case 'launcher': {
        const widget = (await app.commands.execute(
          'launcher:create'
        )) as unknown;

        return widget instanceof Widget ? widget : null;
      }
      default:
        console.warn(`Unknown layout widget "${reference}"`);

        return null;
    }
  }

  private _context: ILayoutContext;
}

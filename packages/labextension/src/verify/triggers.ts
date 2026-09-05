import {
  IDirectiveNode,
  VerifyTrigger,
  parseTriggers
} from '@educates/workshop-core';
import { JupyterFrontEnd } from '@jupyterlab/application';
import { NotebookActions } from '@jupyterlab/notebook';
import { Contents } from '@jupyterlab/services';

import { OUTPUT_WINDOW, TerminalSessions } from '../actions/terminal';
import { IWorkshopManager } from '../tokens';
import { visibleDirectives } from '../util';

/** How often at most a terminal-output trigger fires one verify. */
const TERMINAL_COOLDOWN_MS = 1000;

/**
 * Runs the verifies of the current page when the events they listen for
 * happen: file saves, cell executions, terminal output, actions
 * completing, page entry and timers.
 */
export class TriggerBus {
  constructor(options: TriggerBus.IOptions) {
    this._app = options.app;
    this._manager = options.manager;
    this._terminals = options.terminals;

    const contents = this._app.serviceManager.contents;

    contents.fileChanged.connect(this._onFileChanged, this);
    NotebookActions.executed.connect(this._onCellExecuted, this);
    this._terminals.output.connect(this._onTerminalOutput, this);
    this._manager.actionChanged.connect(this._onActionChanged, this);
    this._manager.changed.connect(this._onChanged, this);
  }

  /**
   * Stop listening and clear timers.
   */
  dispose(): void {
    this._app.serviceManager.contents.fileChanged.disconnect(
      this._onFileChanged,
      this
    );
    NotebookActions.executed.disconnect(this._onCellExecuted, this);
    this._terminals.output.disconnect(this._onTerminalOutput, this);
    this._manager.actionChanged.disconnect(this._onActionChanged, this);
    this._manager.changed.disconnect(this._onChanged, this);
    this._clearTimers();
  }

  private _onChanged(): void {
    const page = this._manager.currentPage;
    const key = `${this._manager.workshop?.path ?? ''}:${page?.id ?? ''}`;

    if (key === this._pageKey) {
      return;
    }

    // A new page: drop the old timers, then fire page-enter and start the
    // intervals of the verifies on it.
    this._pageKey = key;
    this._clearTimers();

    if (!page) {
      return;
    }

    for (const { node, triggers } of this._verifies()) {
      for (const trigger of triggers) {
        if (trigger.kind === 'page-enter') {
          this._run(node);
        } else if (trigger.kind === 'interval') {
          this._timers.push(
            window.setInterval(() => this._run(node), trigger.ms)
          );
        }
      }
    }
  }

  private _onFileChanged(
    _: Contents.IManager,
    change: Contents.IChangedArgs
  ): void {
    if (change.type !== 'save' || !change.newValue?.path) {
      return;
    }

    const saved = change.newValue.path;

    this._fire(trigger => {
      if (trigger.kind !== 'file-saved') {
        return false;
      }

      try {
        return this._manager.resolvePath(trigger.path) === saved;
      } catch {
        return false;
      }
    });
  }

  private _onCellExecuted(
    _: unknown,
    args: { cell: { model: { getMetadata(key: string): unknown } } }
  ): void {
    const tags = args.cell.model.getMetadata('tags');
    const list = Array.isArray(tags) ? tags.map(String) : [];

    this._fire(
      trigger => trigger.kind === 'cell-executed' && list.includes(trigger.tag)
    );
  }

  private _onTerminalOutput(
    _: TerminalSessions,
    args: { name: string; text: string }
  ): void {
    // Output may arrive in pieces, so patterns are matched against the
    // recent output of the terminal, which is cleared once matched so a
    // verify does not keep firing on the same text.
    const recent = (
      (this._recentOutput.get(args.name) ?? '') + args.text
    ).slice(-OUTPUT_WINDOW);
    const now = Date.now();
    let matched = false;

    for (const { node, triggers } of this._verifies()) {
      const hit = triggers.some(
        trigger =>
          trigger.kind === 'terminal-output' &&
          (trigger.regex
            ? new RegExp(trigger.pattern).test(recent)
            : recent.includes(trigger.pattern))
      );

      if (!hit) {
        continue;
      }

      matched = true;

      // Terminal output arrives in bursts; run once per burst.
      const last = this._lastTerminalRun.get(node.id) ?? 0;

      if (now - last >= TERMINAL_COOLDOWN_MS) {
        this._lastTerminalRun.set(node.id, now);
        this._run(node);
      }
    }

    this._recentOutput.set(args.name, matched ? '' : recent);
  }

  private _onActionChanged(_: IWorkshopManager, id: string): void {
    const status = this._manager.actionStatus(id);

    if (status.status !== 'ok') {
      return;
    }

    // Verifies completing must not trigger verifies, or they would loop.
    const page = this._manager.currentPage;
    const source = page
      ? visibleDirectives(page, this._manager.variables.values).find(
          node => node.id === id
        )
      : undefined;

    if (!source || source.name === 'verify') {
      return;
    }

    this._fire(
      trigger =>
        trigger.kind === 'action' &&
        (trigger.id === undefined || trigger.id === id)
    );
  }

  private _fire(matches: (trigger: VerifyTrigger) => boolean): void {
    for (const { node, triggers } of this._verifies()) {
      if (triggers.some(matches)) {
        this._run(node);
      }
    }
  }

  private _verifies(): { node: IDirectiveNode; triggers: VerifyTrigger[] }[] {
    const page = this._manager.currentPage;

    if (!page) {
      return [];
    }

    return visibleDirectives(page, this._manager.variables.values)
      .filter(node => node.name === 'verify')
      .map(node => ({
        node,
        triggers: parseTriggers(node.options.trigger).triggers
      }));
  }

  private _run(node: IDirectiveNode): void {
    // Skip a check that is still running from an earlier trigger.
    if (this._manager.actionStatus(node.id).status === 'running') {
      return;
    }

    void this._manager.runAction(node, 'trigger');
  }

  private _clearTimers(): void {
    for (const timer of this._timers) {
      window.clearInterval(timer);
    }

    this._timers = [];
  }

  private _app: JupyterFrontEnd;
  private _manager: IWorkshopManager;
  private _terminals: TerminalSessions;
  private _pageKey = '';
  private _timers: number[] = [];
  private _lastTerminalRun = new Map<string, number>();
  private _recentOutput = new Map<string, string>();
}

export namespace TriggerBus {
  export interface IOptions {
    app: JupyterFrontEnd;
    manager: IWorkshopManager;
    terminals: TerminalSessions;
  }
}

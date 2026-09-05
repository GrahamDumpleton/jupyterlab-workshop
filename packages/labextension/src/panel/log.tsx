import { ReactWidget, UseSignal, listIcon } from '@jupyterlab/ui-components';
import React from 'react';

import { IWorkshopManager } from '../tokens';

/** Id of the action log widget. */
export const LOG_ID = 'educates-workshop-log';

/**
 * Main-area widget listing every action the workshop has run.
 */
export class ActionLogWidget extends ReactWidget {
  constructor(manager: IWorkshopManager) {
    super();

    this._manager = manager;
    this.id = LOG_ID;
    this.title.label = 'Workshop log';
    this.title.icon = listIcon;
    this.title.closable = true;
    this.addClass('jp-WorkshopLog');
  }

  protected render(): JSX.Element {
    const manager = this._manager;

    return (
      <UseSignal signal={manager.actionChanged}>
        {() => (
          <UseSignal signal={manager.changed}>
            {() => <LogTable manager={manager} />}
          </UseSignal>
        )}
      </UseSignal>
    );
  }

  private _manager: IWorkshopManager;
}

function LogTable({ manager }: { manager: IWorkshopManager }): JSX.Element {
  const entries = [...manager.log].reverse();

  if (entries.length === 0) {
    return <p className="jp-WorkshopLog-empty">No actions have run yet.</p>;
  }

  return (
    <table className="jp-WorkshopLog-table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Page</th>
          <th>Action</th>
          <th>Trigger</th>
          <th>Result</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry, position) => (
          <tr key={position} className={`jp-mod-${entry.status}`}>
            <td>{new Date(entry.time).toLocaleTimeString()}</td>
            <td>{entry.page}</td>
            <td>
              <code>{entry.type}</code> {entry.text}
            </td>
            <td>{entry.trigger}</td>
            <td>
              {entry.status}
              {entry.message ? (
                <div className="jp-WorkshopLog-message">{entry.message}</div>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

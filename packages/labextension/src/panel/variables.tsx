import { Dialog, showDialog } from '@jupyterlab/apputils';
import { ReactWidget } from '@jupyterlab/ui-components';
import React from 'react';

import { IVariableEntry, IWorkshopManager } from '../tokens';

/** Edits made in the dialog: a new value, or null to reset. */
type Edits = Map<string, string | null>;

/**
 * Dialog body listing the variables with editable values.
 */
class VariablesBody extends ReactWidget implements Dialog.IBodyWidget<Edits> {
  constructor(entries: IVariableEntry[]) {
    super();

    this._entries = entries;
    this.addClass('jp-WorkshopVariables');
  }

  getValue(): Edits {
    return this._edits;
  }

  protected render(): JSX.Element {
    const editable = this._entries.filter(entry => !entry.readonly);
    const fixed = this._entries.filter(entry => entry.readonly);

    return (
      <div>
        {editable.length === 0 ? (
          <p>This workshop declares no editable variables.</p>
        ) : null}
        {editable.map(entry => this._renderEntry(entry))}
        {fixed.length > 0 ? (
          <details className="jp-WorkshopVariables-builtins">
            <summary>Read-only variables</summary>
            {fixed.map(entry => (
              <div key={entry.name} className="jp-WorkshopVariables-row">
                <code>{entry.name}</code>
                <span className="jp-WorkshopVariables-value">
                  {entry.secret ? '••••••' : entry.value}
                </span>
              </div>
            ))}
          </details>
        ) : null}
      </div>
    );
  }

  private _renderEntry(entry: IVariableEntry): JSX.Element {
    const edit = this._edits.get(entry.name);
    const value =
      edit === undefined
        ? entry.value
        : edit === null
          ? (entry.definition?.default ?? '')
          : edit;
    const definition = entry.definition;
    const onChange = (next: string): void => {
      this._edits.set(entry.name, next);
      this.update();
    };

    let input: JSX.Element;

    if (definition && definition.options.length > 0) {
      input = (
        <select value={value} onChange={event => onChange(event.target.value)}>
          <option value="">(none)</option>
          {definition.options.map(option => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    } else if (definition?.type === 'boolean') {
      input = (
        <input
          type="checkbox"
          checked={value === 'true'}
          onChange={event => onChange(event.target.checked ? 'true' : 'false')}
        />
      );
    } else {
      input = (
        <input
          type={
            entry.secret
              ? 'password'
              : definition?.type === 'number'
                ? 'number'
                : 'text'
          }
          value={value}
          onChange={event => onChange(event.target.value)}
        />
      );
    }

    return (
      <div key={entry.name} className="jp-WorkshopVariables-row">
        <label>
          <code>{entry.name}</code>
          {definition?.description ? (
            <span className="jp-WorkshopVariables-description">
              {definition.description}
            </span>
          ) : null}
        </label>
        {input}
        <button
          type="button"
          className="jp-Button jp-mod-minimal"
          title="Reset to the default"
          onClick={() => {
            this._edits.set(entry.name, null);
            this.update();
          }}
        >
          Reset
        </button>
      </div>
    );
  }

  private _entries: IVariableEntry[];
  private _edits: Edits = new Map();
}

/**
 * Show the variables dialog and apply any edits the learner makes.
 */
export async function showVariablesDialog(
  manager: IWorkshopManager
): Promise<void> {
  const body = new VariablesBody(manager.variables.entries());
  const result = await showDialog<Edits>({
    title: 'Workshop variables',
    body,
    buttons: [Dialog.cancelButton(), Dialog.okButton({ label: 'Apply' })]
  });

  if (!result.button.accept || !result.value) {
    return;
  }

  for (const [name, value] of result.value) {
    if (value === null) {
      manager.variables.reset(name);
    } else {
      manager.variables.set(name, value, 'manual');
    }
  }
}

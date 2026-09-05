import { ILintMessage } from '@educates/workshop-core';
import { ReactWidget, UseSignal, bugIcon } from '@jupyterlab/ui-components';
import { CommandRegistry } from '@lumino/commands';
import { ReadonlyJSONObject } from '@lumino/coreutils';
import React from 'react';

import { CommandIDs, IWorkshopManager } from '../tokens';

/** Id of the lint widget. */
export const LINT_ID = 'educates-workshop-lint';

/**
 * Main-area widget listing the lint findings of the open workshop, with
 * a link to the line each refers to and a button for the ones that can
 * be fixed mechanically.
 */
export class LintWidget extends ReactWidget {
  constructor(options: LintWidget.IOptions) {
    super();

    this._manager = options.manager;
    this._commands = options.commands;
    this.id = LINT_ID;
    this.title.label = 'Workshop lint';
    this.title.icon = bugIcon;
    this.title.closable = true;
    this.addClass('jp-WorkshopLint');
  }

  protected render(): JSX.Element {
    return (
      <UseSignal signal={this._manager.changed}>
        {() => <LintList manager={this._manager} commands={this._commands} />}
      </UseSignal>
    );
  }

  private _manager: IWorkshopManager;
  private _commands: CommandRegistry;
}

export namespace LintWidget {
  export interface IOptions {
    manager: IWorkshopManager;
    commands: CommandRegistry;
  }
}

function LintList({
  manager,
  commands
}: {
  manager: IWorkshopManager;
  commands: CommandRegistry;
}): JSX.Element {
  const workshop = manager.workshop;
  const messages = manager.lint;

  if (!workshop) {
    return <p className="jp-WorkshopLint-empty">No workshop is open.</p>;
  }

  const errors = messages.filter(message => message.level === 'error').length;
  const summary =
    messages.length === 0
      ? 'No problems found.'
      : `${errors} ${errors === 1 ? 'error' : 'errors'}, ${messages.length - errors} ${messages.length - errors === 1 ? 'warning' : 'warnings'}.`;

  return (
    <div className="jp-WorkshopLint-content">
      <div className="jp-WorkshopLint-summary">
        <strong>{workshop.manifest.title}</strong> {summary}
        {manager.error ? (
          <div className="jp-WorkshopLint-error">{manager.error}</div>
        ) : null}
      </div>
      {messages.length > 0 ? (
        <table className="jp-WorkshopLint-table">
          <thead>
            <tr>
              <th className="jp-WorkshopLint-cell">Level</th>
              <th className="jp-WorkshopLint-cell">Where</th>
              <th className="jp-WorkshopLint-cell">Rule</th>
              <th className="jp-WorkshopLint-cell">Message</th>
              <th className="jp-WorkshopLint-cell"></th>
            </tr>
          </thead>
          <tbody>
            {messages.map((message, index) => (
              <LintRow
                key={index}
                message={message}
                onOpen={() =>
                  void commands.execute(CommandIDs.openSource, {
                    path: message.path ?? 'workshop.yaml',
                    line: message.line ?? 1
                  })
                }
                onFix={() =>
                  void commands.execute(CommandIDs.applyFix, {
                    message: message as unknown as ReadonlyJSONObject
                  })
                }
              />
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

function LintRow({
  message,
  onOpen,
  onFix
}: {
  message: ILintMessage;
  onOpen: () => void;
  onFix: () => void;
}): JSX.Element {
  const where = message.path
    ? `${message.path}${message.line ? `:${message.line}` : ''}`
    : '';

  return (
    <tr>
      <td
        className={`jp-WorkshopLint-cell jp-WorkshopLint-level jp-mod-${message.level}`}
      >
        {message.level}
      </td>
      <td className="jp-WorkshopLint-cell">
        {where ? (
          <a
            href="#"
            onClick={event => {
              event.preventDefault();
              onOpen();
            }}
          >
            {where}
          </a>
        ) : null}
      </td>
      <td className="jp-WorkshopLint-cell">
        <code>{message.rule}</code>
      </td>
      <td className="jp-WorkshopLint-cell">{message.message}</td>
      <td className="jp-WorkshopLint-cell">
        {message.fix ? (
          <button
            type="button"
            className="jp-Button jp-mod-styled jp-mod-minimal"
            onClick={onFix}
          >
            Fix
          </button>
        ) : null}
      </td>
    </tr>
  );
}

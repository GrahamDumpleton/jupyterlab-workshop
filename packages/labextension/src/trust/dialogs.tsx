import {
  CAPABILITY_DESCRIPTIONS,
  TRUST_LEVEL_DESCRIPTIONS,
  TrustLevel,
  formatLintMessage
} from '@educates/workshop-core';
import { Dialog, showDialog } from '@jupyterlab/apputils';
import { ReactWidget } from '@jupyterlab/ui-components';
import React from 'react';

import {
  ConfirmAnswer,
  IConfirmRequest,
  ITrustChoice,
  ITrustPrompts,
  ITrustSummary
} from '../tokens';
import { describeSource } from './summary';

/**
 * Dialog body summarising what a workshop asks to be trusted with.
 */
class TrustBody extends ReactWidget implements Dialog.IBodyWidget<boolean> {
  constructor(summary: ITrustSummary) {
    super();

    this._summary = summary;
    this.addClass('jp-WorkshopTrust');
  }

  /** Whether the learner ticked the analytics opt-in. */
  getValue(): boolean {
    return this._analytics;
  }

  protected render(): JSX.Element {
    const summary = this._summary;
    const errors = summary.lint.filter(message => message.level === 'error');
    const warnings = summary.lint.filter(
      message => message.level === 'warning'
    );

    return (
      <div>
        <p>
          <strong>{summary.title}</strong>
          {summary.version ? ` ${summary.version}` : ''} wants to drive this
          JupyterLab session. Choose how far to trust it.
        </p>
        <dl className="jp-WorkshopTrust-facts">
          <dt>Source</dt>
          <dd>{describeSource(summary.source)}</dd>
          <dt>Hash</dt>
          <dd>
            <code title={summary.hash}>{summary.hash.slice(0, 16)}</code>
          </dd>
          <dt>Automatic actions</dt>
          <dd>{summary.automatic}</dd>
        </dl>
        <p className="jp-WorkshopTrust-heading">Capabilities</p>
        {summary.capabilities.length === 0 ? (
          <p>The workshop declares no capabilities.</p>
        ) : (
          <ul className="jp-WorkshopTrust-capabilities">
            {summary.capabilities.map(item => (
              <li
                key={item.capability}
                className={item.declared ? '' : 'jp-mod-undeclared'}
              >
                <code>{item.capability}</code>
                {item.scopes.length > 0 ? (
                  <span className="jp-WorkshopTrust-scopes">
                    {' '}
                    ({item.scopes.join(', ')})
                  </span>
                ) : null}
                <span className="jp-WorkshopTrust-description">
                  {' '}
                  {CAPABILITY_DESCRIPTIONS[item.capability]}
                  {item.count > 0
                    ? ` Used by ${item.count} ${item.count === 1 ? 'action' : 'actions'}.`
                    : ' Not used by any action.'}
                  {item.declared
                    ? ''
                    : ' Not declared, so these actions will not run.'}
                </span>
              </li>
            ))}
          </ul>
        )}
        {errors.length > 0 ? (
          <details className="jp-WorkshopTrust-lint jp-mod-error" open>
            <summary>
              {errors.length} {errors.length === 1 ? 'problem' : 'problems'}
            </summary>
            <ul>
              {errors.map((message, index) => (
                <li key={index}>{formatLintMessage(message)}</li>
              ))}
            </ul>
          </details>
        ) : null}
        {warnings.length > 0 ? (
          <details className="jp-WorkshopTrust-lint">
            <summary>
              {warnings.length} {warnings.length === 1 ? 'warning' : 'warnings'}
            </summary>
            <ul>
              {warnings.map((message, index) => (
                <li key={index}>{formatLintMessage(message)}</li>
              ))}
            </ul>
          </details>
        ) : null}
        {summary.analyticsSink ? (
          <label className="jp-WorkshopTrust-analytics">
            <input
              type="checkbox"
              defaultChecked={false}
              onChange={event => {
                this._analytics = event.target.checked;
              }}
            />{' '}
            Report my progress (pages, actions and check results, no file
            contents) to <code>{sinkHost(summary.analyticsSink)}</code>
          </label>
        ) : null}
        <p className="jp-WorkshopTrust-heading">Levels</p>
        <dl className="jp-WorkshopTrust-levels">
          <dt>Trust</dt>
          <dd>{TRUST_LEVEL_DESCRIPTIONS.trusted}</dd>
          <dt>Restricted</dt>
          <dd>{TRUST_LEVEL_DESCRIPTIONS.restricted}</dd>
          <dt>Ask each time</dt>
          <dd>{TRUST_LEVEL_DESCRIPTIONS.ask}</dd>
        </dl>
      </div>
    );
  }

  private _summary: ITrustSummary;
  private _analytics = false;
}

function sinkHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * Dialog body for confirming one action.
 */
class ConfirmBody extends ReactWidget implements Dialog.IBodyWidget<boolean> {
  constructor(request: IConfirmRequest) {
    super();

    this._request = request;
    this.addClass('jp-WorkshopConfirm');
  }

  /** Whether the learner ticked "always allow". */
  getValue(): boolean {
    return this._always;
  }

  protected render(): JSX.Element {
    const request = this._request;

    return (
      <div>
        <p>
          <strong>{request.description}</strong>
        </p>
        <p className="jp-WorkshopConfirm-reason">{request.reason}</p>
        {request.detail ? (
          <pre className="jp-WorkshopConfirm-detail">{request.detail}</pre>
        ) : null}
        {request.offerAlways ? (
          <label className="jp-WorkshopConfirm-always">
            <input
              type="checkbox"
              defaultChecked={false}
              onChange={event => {
                this._always = event.target.checked;
              }}
            />{' '}
            Always allow <code>{request.capability}</code> for this workshop
          </label>
        ) : null}
      </div>
    );
  }

  private _request: IConfirmRequest;
  private _always = false;
}

/**
 * Show the trust dialog and return the chosen level, or null to cancel.
 */
export async function showTrustDialog(
  summary: ITrustSummary,
  defaultLevel: TrustLevel
): Promise<ITrustChoice | null> {
  const buttons: Dialog.IButton[] = [
    Dialog.cancelButton({ label: 'Cancel' }),
    Dialog.okButton({
      label: 'Ask each time',
      className: 'jp-WorkshopTrust-button jp-mod-ask'
    }),
    Dialog.okButton({
      label: 'Restricted',
      className: 'jp-WorkshopTrust-button jp-mod-restricted'
    }),
    Dialog.warnButton({
      label: 'Trust',
      className: 'jp-WorkshopTrust-button jp-mod-trusted'
    })
  ];
  const levels: (TrustLevel | null)[] = [null, 'ask', 'restricted', 'trusted'];
  const defaultButton = levels.indexOf(defaultLevel);

  const result = await showDialog<boolean>({
    title: `Open workshop "${summary.title}"?`,
    body: new TrustBody(summary),
    buttons,
    defaultButton: defaultButton < 0 ? 2 : defaultButton,
    hasClose: true
  });

  const index = buttons.findIndex(
    button => button.label === result.button.label
  );
  const level = result.button.accept && index >= 0 ? levels[index] : null;

  return level ? { level, analytics: result.value === true } : null;
}

/**
 * Ask whether an action may run.
 */
export async function showConfirmDialog(
  request: IConfirmRequest
): Promise<ConfirmAnswer> {
  const body = new ConfirmBody(request);
  const result = await showDialog<boolean>({
    title: 'Allow this action?',
    body,
    buttons: [
      Dialog.cancelButton({ label: 'Skip' }),
      Dialog.okButton({ label: 'Allow' })
    ],
    defaultButton: 1,
    hasClose: true
  });

  if (!result.button.accept) {
    return 'no';
  }

  return result.value ? 'always' : 'yes';
}

/** The dialogs, packaged for the manager. */
export const trustPrompts: ITrustPrompts = {
  decide: showTrustDialog,
  confirm: showConfirmDialog
};

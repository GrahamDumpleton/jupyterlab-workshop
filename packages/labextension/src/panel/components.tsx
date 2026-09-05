import {
  ACTION_TYPES,
  ActionDisposition,
  IDirectiveNode,
  IFormField,
  IPage,
  IProseNode,
  PageNode,
  TRUST_LEVEL_DESCRIPTIONS,
  describeRequirement,
  isActionType,
  parseForm,
  parseQuiz,
  parseTriggers,
  validateForm
} from '@educates/workshop-core';
import {
  UseSignal,
  caretLeftIcon,
  caretRightIcon,
  checkIcon,
  closeIcon,
  downloadIcon,
  folderIcon,
  listIcon,
  runIcon,
  settingsIcon,
  stopIcon
} from '@jupyterlab/ui-components';
import { CommandRegistry } from '@lumino/commands';
import React, {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState
} from 'react';

import { CommandIDs, IActionRequest, IWorkshopManager } from '../tokens';

/** Props shared by the panel components. */
export interface IPanelProps {
  manager: IWorkshopManager;
  commands: CommandRegistry;
}

const PULSE_CLASS = 'jp-mod-pulse';

/**
 * Root component of the workshop panel. Re-renders whenever the manager
 * signals a change.
 */
export function WorkshopPanelComponent(props: IPanelProps): JSX.Element {
  return (
    <UseSignal signal={props.manager.changed}>
      {() => <PanelContent {...props} />}
    </UseSignal>
  );
}

function IconButton({
  icon,
  title,
  disabled,
  onClick
}: {
  icon: typeof runIcon;
  title: string;
  disabled?: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="jp-WorkshopPanel-iconButton"
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      <icon.react tag="span" width="16px" height="16px" />
    </button>
  );
}

function PanelContent({ manager, commands }: IPanelProps): JSX.Element {
  const workshop = manager.workshop;
  const page = manager.currentPage;

  if (!workshop || !page) {
    return (
      <EmptyState
        error={manager.error}
        onOpen={() => void commands.execute(CommandIDs.open)}
        onOpenUrl={() => void commands.execute(CommandIDs.openUrl)}
      />
    );
  }

  const visible = manager.visiblePages;
  const count = visible.length;
  const index = manager.pageIndex;
  const doneCount = visible.filter(
    item => manager.pageProgress(item.id).done
  ).length;
  const done = manager.pageProgress(page.id).done;
  const gate = manager.gate(page.id);
  const run = (command: string): void => void commands.execute(command);
  const jumpTo = (id: string): void => manager.focusAction(id);

  return (
    <div className="jp-WorkshopPanel-content">
      <div className="jp-WorkshopPanel-header">
        <div className="jp-WorkshopPanel-titleRow">
          <h2
            className="jp-WorkshopPanel-title"
            title={workshop.manifest.description}
          >
            {workshop.manifest.title}
          </h2>
          <TrustBadge manager={manager} onClick={() => run(CommandIDs.trust)} />
          {manager.chainRunning ? (
            <IconButton
              icon={stopIcon}
              title="Stop running actions"
              onClick={() => run(CommandIDs.stopChain)}
            />
          ) : null}
          <IconButton
            icon={settingsIcon}
            title="Variables"
            onClick={() => run(CommandIDs.variables)}
          />
          <IconButton
            icon={listIcon}
            title="Action log"
            onClick={() => run(CommandIDs.showLog)}
          />
          <IconButton
            icon={folderIcon}
            title="Open another workshop"
            onClick={() => run(CommandIDs.open)}
          />
          <IconButton
            icon={downloadIcon}
            title="Open a workshop from a URL"
            onClick={() => run(CommandIDs.openUrl)}
          />
          <IconButton
            icon={closeIcon}
            title="Close this workshop"
            onClick={() => run(CommandIDs.close)}
          />
        </div>
        <div
          className="jp-WorkshopPanel-progress"
          title={`${doneCount} of ${count} pages done`}
        >
          <div
            className="jp-WorkshopPanel-progressBar"
            style={{ width: `${count > 0 ? (doneCount / count) * 100 : 0}%` }}
          />
        </div>
        <div className="jp-WorkshopPanel-nav">
          <IconButton
            icon={caretLeftIcon}
            title="Previous page"
            disabled={index === 0}
            onClick={() => manager.previous()}
          />
          <select
            className="jp-WorkshopPanel-pageSelect"
            value={index}
            onChange={event => manager.goTo(Number(event.target.value))}
          >
            {visible.map((item, position) => (
              <option key={item.path} value={position}>
                {position + 1}. {item.title}
                {item.frontmatter.optional ? ' (optional)' : ''}
                {manager.pageProgress(item.id).done ? ' ✓' : ''}
              </option>
            ))}
          </select>
          <IconButton
            icon={caretRightIcon}
            title="Next page"
            disabled={index >= count - 1}
            onClick={() => manager.next()}
          />
        </div>
      </div>
      <PageBody
        key={`${workshop.path}:${page.id}`}
        page={page}
        manager={manager}
      />
      {gate.unmet.length > 0 ? (
        <div
          className={`jp-WorkshopPanel-gate${gate.blocked ? ' jp-mod-blocked' : ''}`}
        >
          <span>{gate.blocked ? 'Before moving on: ' : 'Not yet done: '}</span>
          {gate.unmet.map((item, position) => (
            <React.Fragment key={item.id}>
              {position > 0 ? ', ' : null}
              <a
                href="#"
                onClick={event => {
                  event.preventDefault();
                  jumpTo(item.id);
                }}
              >
                {describeRequirement(item)}
              </a>
            </React.Fragment>
          ))}
        </div>
      ) : null}
      <div className="jp-WorkshopPanel-footer">
        <button
          type="button"
          className="jp-Button jp-mod-styled"
          disabled={index === 0}
          onClick={() => manager.previous()}
        >
          Previous
        </button>
        <button
          type="button"
          className={`jp-Button jp-mod-styled jp-WorkshopPanel-doneButton${done ? ' jp-mod-done' : ''}`}
          title={done ? 'Mark this page as not done' : 'Mark this page as done'}
          onClick={() => manager.markDone(page.id, !done)}
        >
          <checkIcon.react tag="span" width="14px" height="14px" />
          {done ? 'Done' : 'Mark done'}
        </button>
        <button
          type="button"
          className="jp-Button jp-mod-styled jp-mod-accept"
          disabled={index >= count - 1 || gate.blocked}
          title={gate.blocked ? 'Complete the requirements above first' : ''}
          onClick={() => manager.next()}
        >
          Next
        </button>
      </div>
    </div>
  );
}

function EmptyState({
  error,
  onOpen,
  onOpenUrl
}: {
  error: string | null;
  onOpen: () => void;
  onOpenUrl: () => void;
}): JSX.Element {
  return (
    <div className="jp-WorkshopPanel-empty">
      <p>No workshop is open.</p>
      {error ? <p className="jp-WorkshopPanel-error">{error}</p> : null}
      <div className="jp-WorkshopPanel-emptyActions">
        <button
          type="button"
          className="jp-Button jp-mod-styled jp-mod-accept"
          onClick={onOpen}
        >
          Open a directory
        </button>
        <button
          type="button"
          className="jp-Button jp-mod-styled"
          onClick={onOpenUrl}
        >
          Open from URL
        </button>
      </div>
    </div>
  );
}

function TrustBadge({
  manager,
  onClick
}: {
  manager: IWorkshopManager;
  onClick: () => void;
}): JSX.Element | null {
  const level = manager.trust;

  if (!level) {
    return null;
  }

  const label =
    level === 'trusted'
      ? 'trusted'
      : level === 'restricted'
        ? 'restricted'
        : 'ask';

  return (
    <button
      type="button"
      className={`jp-WorkshopPanel-trust jp-mod-${level}`}
      title={`Trust level: ${TRUST_LEVEL_DESCRIPTIONS[level]} Click to change.`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function PageBody({
  page,
  manager
}: {
  page: IPage;
  manager: IWorkshopManager;
}): JSX.Element {
  const [, refresh] = useReducer((count: number) => count + 1, 0);
  const container = useRef<HTMLDivElement>(null);

  // Re-render on action status changes, and scroll to automatic runs.
  useEffect(() => {
    const onChanged = (): void => refresh();
    const onFocused = (_: IWorkshopManager, id: string): void => {
      const element = container.current?.querySelector<HTMLElement>(
        `[data-action-id="${CSS.escape(id)}"]`
      );

      if (element) {
        element.scrollIntoView({ block: 'center', behavior: 'smooth' });
        element.classList.add(PULSE_CLASS);
        window.setTimeout(() => element.classList.remove(PULSE_CLASS), 1500);
      }
    };

    manager.actionChanged.connect(onChanged);
    manager.actionFocused.connect(onFocused);

    return () => {
      manager.actionChanged.disconnect(onChanged);
      manager.actionFocused.disconnect(onFocused);
    };
  }, [manager]);

  const onProseClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      const target = (event.target as HTMLElement).closest<HTMLElement>(
        'button[data-role]'
      );

      if (!target) {
        return;
      }

      const request = roleRequest(
        target.dataset.role ?? '',
        target.dataset.value ?? ''
      );

      if (request) {
        void manager.runRequest(request, 'role');
      }
    },
    [manager]
  );

  return (
    <div className="jp-WorkshopPanel-body" ref={container}>
      <h3 className="jp-WorkshopPanel-pageTitle">{page.title}</h3>
      {manager.pageIndex === 0 ? <PreflightBanner manager={manager} /> : null}
      {page.warnings.length > 0 ? (
        <div className="jp-WorkshopPanel-warnings">
          {page.warnings.map((warning, position) => (
            <div key={position}>{warning}</div>
          ))}
        </div>
      ) : null}
      <Nodes nodes={page.nodes} manager={manager} onProseClick={onProseClick} />
    </div>
  );
}

function Nodes({
  nodes,
  manager,
  onProseClick
}: {
  nodes: PageNode[];
  manager: IWorkshopManager;
  onProseClick: (event: React.MouseEvent<HTMLDivElement>) => void;
}): JSX.Element {
  return (
    <>
      {nodes.map((node, position) => {
        if (node.kind === 'prose') {
          return (
            <ProseBlock key={position} node={node} onClick={onProseClick} />
          );
        }

        if (node.kind === 'when') {
          return manager.evaluate(node.condition) ? (
            <Nodes
              key={position}
              nodes={node.nodes}
              manager={manager}
              onProseClick={onProseClick}
            />
          ) : null;
        }

        if (node.options.when && !manager.evaluate(node.options.when)) {
          return null;
        }

        return <DirectiveBlock key={node.id} node={node} manager={manager} />;
      })}
    </>
  );
}

function ProseBlock({
  node,
  onClick
}: {
  node: IProseNode;
  onClick: (event: React.MouseEvent<HTMLDivElement>) => void;
}): JSX.Element {
  // Pages are rendered with raw HTML disabled, so this is generated markup.
  return (
    <div
      className="jp-WorkshopPanel-prose jp-RenderedHTMLCommon"
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: node.html }}
    />
  );
}

function DirectiveBlock({
  node,
  manager
}: {
  node: IDirectiveNode;
  manager: IWorkshopManager;
}): JSX.Element {
  switch (node.name) {
    case 'hint':
      return <HintBlock node={node} />;
    case 'choice':
      return <ChoiceBlock node={node} manager={manager} />;
    case 'verify':
      return <VerifyBlock node={node} manager={manager} />;
    case 'quiz':
      return <QuizBlock node={node} manager={manager} />;
    case 'form':
      return <FormBlock node={node} manager={manager} />;
    default:
      return isActionType(node.name) ? (
        <ActionBlock node={node} manager={manager} />
      ) : (
        <UnknownBlock node={node} />
      );
  }
}

function HintBlock({ node }: { node: IDirectiveNode }): JSX.Element {
  return (
    <details
      className="jp-WorkshopPanel-hint"
      open={node.options.open === 'true'}
    >
      <summary>{node.options.title ?? 'Hint'}</summary>
      <div
        className="jp-WorkshopPanel-prose jp-RenderedHTMLCommon"
        dangerouslySetInnerHTML={{ __html: node.html ?? '' }}
      />
    </details>
  );
}

function ChoiceBlock({
  node,
  manager
}: {
  node: IDirectiveNode;
  manager: IWorkshopManager;
}): JSX.Element {
  const manifest = manager.workshop?.manifest;
  const isTrack = node.options.track === 'true';
  const variable = node.options.variable ?? (isTrack ? 'track' : '');

  // Options come from the directive, the variable definition, or the tracks.
  let options: { value: string; label: string }[] = [];

  if (node.options.options) {
    options = node.options.options
      .split(',')
      .map(item => item.trim())
      .filter(item => item !== '')
      .map(value => ({ value, label: value }));
  } else if (isTrack && manifest && manifest.tracks.length > 0) {
    options = manifest.tracks.map(track => ({
      value: track.id,
      label: track.label
    }));
  } else if (manifest) {
    const definition = manifest.variables.find(item => item.name === variable);

    options = (definition?.options ?? []).map(value => ({
      value,
      label: value
    }));
  }

  const current = manager.variables.get(variable);
  const status = manager.actionStatus(node.id);

  return (
    <div
      className="jp-WorkshopPanel-action jp-WorkshopPanel-choice"
      data-action-id={node.id}
    >
      <div className="jp-WorkshopPanel-actionHeader">
        <span className="jp-WorkshopPanel-actionLabel">
          {node.options.label ??
            node.options.title ??
            (isTrack ? 'Choose a track' : `Choose ${variable}`)}
        </span>
      </div>
      {node.body.trim() ? (
        <div className="jp-WorkshopPanel-choiceText">{node.body}</div>
      ) : null}
      <div className="jp-WorkshopPanel-choiceOptions">
        {options.map(option => (
          <button
            key={option.value}
            type="button"
            className={`jp-Button jp-mod-styled${current === option.value ? ' jp-mod-accept' : ''}`}
            onClick={() => void manager.runAction(node, 'click', option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
      {status.status === 'error' && status.message ? (
        <div className="jp-WorkshopPanel-actionMessage">{status.message}</div>
      ) : null}
    </div>
  );
}

function ActionBlock({
  node,
  manager
}: {
  node: IDirectiveNode;
  manager: IWorkshopManager;
}): JSX.Element {
  const status = manager.actionStatus(node.id);
  const request: IActionRequest = {
    type: node.name,
    id: node.id,
    argument: node.argument,
    options: node.options,
    body: node.body
  };
  const title =
    node.options.title ?? manager.registry?.describe(request) ?? node.name;
  const display = displayText(node);
  const disposition = manager.disposition(node);
  const trustBadge = dispositionBadge(disposition, node);
  const onRun = (): void => void manager.runAction(node, 'click');
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onRun();
    }
  };

  return (
    <div
      className={`jp-WorkshopPanel-action jp-mod-${node.name} jp-mod-status-${status.status}`}
      data-action-id={node.id}
      role="button"
      tabIndex={0}
      title="Click to run"
      onClick={onRun}
      onKeyDown={onKeyDown}
    >
      <div className="jp-WorkshopPanel-actionHeader">
        <runIcon.react tag="span" width="14px" height="14px" />
        <span className="jp-WorkshopPanel-actionLabel">{title}</span>
        {node.options.auto ? (
          <span className="jp-WorkshopPanel-badge">auto</span>
        ) : null}
        {node.options.cascade && node.options.cascade !== 'false' ? (
          <span className="jp-WorkshopPanel-badge">cascade</span>
        ) : null}
        {trustBadge ? (
          <span
            className={`jp-WorkshopPanel-badge ${trustBadge.className}`}
            title={trustBadge.title}
          >
            {trustBadge.label}
          </span>
        ) : null}
        <span className="jp-WorkshopPanel-actionStatus">
          {statusText(status)}
        </span>
      </div>
      {display ? (
        <pre className="jp-WorkshopPanel-actionBody">{display}</pre>
      ) : null}
      {status.status === 'error' && status.message ? (
        <div className="jp-WorkshopPanel-actionMessage">{status.message}</div>
      ) : null}
      {status.status === 'ok' && status.message && showsOutput(node) ? (
        <pre className="jp-WorkshopPanel-actionOutput">{status.message}</pre>
      ) : null}
    </div>
  );
}

function PreflightBanner({
  manager
}: {
  manager: IWorkshopManager;
}): JSX.Element | null {
  const results = manager.preflight;

  if (!results) {
    return null;
  }

  const problems = results.filter(result => !result.satisfied);

  if (problems.length === 0) {
    return null;
  }

  return (
    <div className="jp-WorkshopPanel-preflight">
      <div className="jp-WorkshopPanel-preflightTitle">
        This workshop needs tools that were not found:
      </div>
      <ul>
        {problems.map(result => (
          <li key={result.name}>
            <code>{result.name}</code>
            {result.requirement ? ` ${result.requirement}` : ''}
            {result.found
              ? result.version
                ? ` (found ${result.version})`
                : ' (version unknown)'
              : ' (not installed)'}
            {result.optional ? ', optional' : ''}
            {result.hint ? (
              <span className="jp-WorkshopPanel-preflightHint">
                {' '}
                Try: <code>{result.hint}</code>
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function VerifyBlock({
  node,
  manager
}: {
  node: IDirectiveNode;
  manager: IWorkshopManager;
}): JSX.Element {
  const status = manager.actionStatus(node.id);
  const label = node.options.label ?? node.options.title ?? 'Check progress';
  const triggers = parseTriggers(node.options.trigger).triggers.filter(
    trigger => trigger.kind !== 'click'
  );
  const disposition = manager.disposition(node);
  const trustBadge = dispositionBadge(disposition, node);
  const state =
    status.status === 'ok'
      ? 'pass'
      : status.status === 'error'
        ? 'fail'
        : status.status;

  return (
    <div
      className={`jp-WorkshopPanel-action jp-WorkshopPanel-verify jp-mod-verify-${state}`}
      data-action-id={node.id}
    >
      <div className="jp-WorkshopPanel-actionHeader">
        <span className="jp-WorkshopPanel-verifyMark" aria-hidden="true">
          {state === 'pass' ? '✓' : state === 'fail' ? '✗' : '○'}
        </span>
        <span className="jp-WorkshopPanel-actionLabel">{label}</span>
        {triggers.length > 0 ? (
          <span
            className="jp-WorkshopPanel-badge"
            title={`Runs on: ${triggers.map(describeTrigger).join(', ')}`}
          >
            auto
          </span>
        ) : null}
        {trustBadge ? (
          <span
            className={`jp-WorkshopPanel-badge ${trustBadge.className}`}
            title={trustBadge.title}
          >
            {trustBadge.label}
          </span>
        ) : null}
        <button
          type="button"
          className="jp-Button jp-mod-styled jp-WorkshopPanel-verifyButton"
          disabled={status.status === 'running'}
          onClick={() => void manager.runAction(node, 'click')}
        >
          {status.status === 'running' ? 'Checking…' : 'Check'}
        </button>
      </div>
      {status.message ? (
        <div className="jp-WorkshopPanel-verifyMessage">{status.message}</div>
      ) : null}
    </div>
  );
}

function describeTrigger(trigger: {
  kind: string;
  id?: string;
  pattern?: string;
  path?: string;
  tag?: string;
  ms?: number;
}): string {
  switch (trigger.kind) {
    case 'action':
      return trigger.id ? `after ${trigger.id}` : 'after any action';
    case 'terminal-output':
      return `terminal prints "${trigger.pattern}"`;
    case 'file-saved':
      return `${trigger.path} is saved`;
    case 'cell-executed':
      return `cell "${trigger.tag}" runs`;
    case 'interval':
      return `every ${Math.round((trigger.ms ?? 0) / 1000)}s`;
    default:
      return trigger.kind;
  }
}

function QuizBlock({
  node,
  manager
}: {
  node: IDirectiveNode;
  manager: IWorkshopManager;
}): JSX.Element {
  const parsed = parseQuiz(node.body, node.options);
  const status = manager.actionStatus(node.id);
  const [picked, setPicked] = useState<number[]>([]);

  if (!parsed.quiz) {
    return (
      <div className="jp-WorkshopPanel-action jp-mod-unknown">
        <div className="jp-WorkshopPanel-actionHeader">
          <span className="jp-WorkshopPanel-actionLabel">Invalid quiz</span>
        </div>
        <div className="jp-WorkshopPanel-actionMessage">
          {parsed.errors.join('; ')}
        </div>
      </div>
    );
  }

  const quiz = parsed.quiz;
  const order = quiz.shuffle
    ? shuffled(quiz.options.length, node.id)
    : quiz.options.map((_, index) => index);
  const passed = status.status === 'ok';
  const exhausted =
    quiz.attempts > 0 && status.runs >= quiz.attempts && !passed;
  const locked = passed || exhausted || status.status === 'running';
  const remaining = quiz.attempts > 0 ? quiz.attempts - status.runs : null;

  const toggle = (index: number): void => {
    if (quiz.type === 'single') {
      setPicked([index]);
    } else {
      setPicked(current =>
        current.includes(index)
          ? current.filter(item => item !== index)
          : [...current, index]
      );
    }
  };

  return (
    <div
      className={`jp-WorkshopPanel-action jp-WorkshopPanel-quiz jp-mod-status-${status.status}`}
      data-action-id={node.id}
    >
      <div className="jp-WorkshopPanel-actionHeader">
        <span className="jp-WorkshopPanel-actionLabel">
          {node.options.title ?? 'Quiz'}
        </span>
        <span className="jp-WorkshopPanel-actionStatus">
          {passed ? 'correct' : exhausted ? 'no attempts left' : ''}
        </span>
      </div>
      <div className="jp-WorkshopPanel-quizQuestion">{quiz.question}</div>
      <div className="jp-WorkshopPanel-quizOptions">
        {order.map(index => (
          <label key={index} className="jp-WorkshopPanel-quizOption">
            <input
              type={quiz.type === 'single' ? 'radio' : 'checkbox'}
              name={`quiz-${node.id}`}
              checked={picked.includes(index)}
              disabled={locked}
              onChange={() => toggle(index)}
            />{' '}
            {quiz.options[index].text}
          </label>
        ))}
      </div>
      <div className="jp-WorkshopPanel-quizFooter">
        <button
          type="button"
          className="jp-Button jp-mod-styled jp-mod-accept"
          disabled={locked || picked.length === 0}
          onClick={() =>
            void manager.runAction(node, 'click', JSON.stringify(picked))
          }
        >
          Submit
        </button>
        {remaining !== null && !passed ? (
          <span className="jp-WorkshopPanel-quizAttempts">
            {remaining} {remaining === 1 ? 'attempt' : 'attempts'} left
          </span>
        ) : null}
      </div>
      {status.message && status.status !== 'running' ? (
        <div
          className={`jp-WorkshopPanel-quizFeedback${passed ? ' jp-mod-pass' : ' jp-mod-fail'}`}
        >
          {status.message}
        </div>
      ) : null}
    </div>
  );
}

function shuffled(count: number, seed: string): number[] {
  // A stable shuffle per quiz id, so re-renders keep the same order.
  let hash = 0;

  for (const char of seed) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }

  const order = Array.from({ length: count }, (_, index) => index);

  for (let index = count - 1; index > 0; index -= 1) {
    hash = (hash * 1103515245 + 12345) >>> 0;

    const other = hash % (index + 1);

    [order[index], order[other]] = [order[other], order[index]];
  }

  return order;
}

function FormBlock({
  node,
  manager
}: {
  node: IDirectiveNode;
  manager: IWorkshopManager;
}): JSX.Element {
  const parsed = parseForm(node.body);
  const status = manager.actionStatus(node.id);
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};

    for (const field of parsed.form?.fields ?? []) {
      initial[field.name] =
        manager.variables.get(field.name) ?? field.default ?? '';
    }

    return initial;
  });
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});

  if (!parsed.form) {
    return (
      <div className="jp-WorkshopPanel-action jp-mod-unknown">
        <div className="jp-WorkshopPanel-actionHeader">
          <span className="jp-WorkshopPanel-actionLabel">Invalid form</span>
        </div>
        <div className="jp-WorkshopPanel-actionMessage">
          {parsed.errors.join('; ')}
        </div>
      </div>
    );
  }

  const form = parsed.form;
  const update = (name: string, value: string): void => {
    setValues(current => ({ ...current, [name]: value }));
    setProblems(current => {
      const next = { ...current };

      delete next[name];

      return next;
    });
  };
  const submit = (): void => {
    const found = validateForm(form, values);

    setProblems(found);

    if (Object.keys(found).length === 0) {
      void manager.runAction(node, 'click', JSON.stringify(values));
    }
  };

  return (
    <form
      className={`jp-WorkshopPanel-action jp-WorkshopPanel-form jp-mod-status-${status.status}`}
      data-action-id={node.id}
      noValidate
      onSubmit={event => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="jp-WorkshopPanel-actionHeader">
        <span className="jp-WorkshopPanel-actionLabel">
          {node.options.title ?? node.options.label ?? 'Your details'}
        </span>
        <span className="jp-WorkshopPanel-actionStatus">
          {status.status === 'ok' ? 'saved' : ''}
        </span>
      </div>
      {form.fields.map(field => (
        <FormFieldInput
          key={field.name}
          field={field}
          value={values[field.name] ?? ''}
          problem={problems[field.name]}
          revealed={revealed[field.name] ?? false}
          onReveal={() =>
            setRevealed(current => ({
              ...current,
              [field.name]: !current[field.name]
            }))
          }
          onChange={value => update(field.name, value)}
        />
      ))}
      <div className="jp-WorkshopPanel-formFooter">
        <button
          type="submit"
          className="jp-Button jp-mod-styled jp-mod-accept"
          disabled={status.status === 'running'}
        >
          {status.status === 'ok' ? 'Update' : 'Save'}
        </button>
      </div>
      {status.status === 'error' && status.message ? (
        <div className="jp-WorkshopPanel-actionMessage">{status.message}</div>
      ) : null}
    </form>
  );
}

function FormFieldInput({
  field,
  value,
  problem,
  revealed,
  onReveal,
  onChange
}: {
  field: IFormField;
  value: string;
  problem?: string;
  revealed: boolean;
  onReveal: () => void;
  onChange: (value: string) => void;
}): JSX.Element {
  let control: JSX.Element;

  switch (field.type) {
    case 'boolean':
      control = (
        <input
          type="checkbox"
          checked={value === 'true'}
          onChange={event => onChange(event.target.checked ? 'true' : 'false')}
        />
      );
      break;

    case 'select':
      control = (
        <select value={value} onChange={event => onChange(event.target.value)}>
          <option value="">Choose…</option>
          {field.options.map(option => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
      break;

    case 'multiselect': {
      const chosen = value
        .split(',')
        .map(item => item.trim())
        .filter(item => item !== '');

      control = (
        <div className="jp-WorkshopPanel-formChoices">
          {field.options.map(option => (
            <label key={option}>
              <input
                type="checkbox"
                checked={chosen.includes(option)}
                onChange={event =>
                  onChange(
                    (event.target.checked
                      ? [...chosen, option]
                      : chosen.filter(item => item !== option)
                    ).join(',')
                  )
                }
              />{' '}
              {option}
            </label>
          ))}
        </div>
      );
      break;
    }

    case 'secret':
      control = (
        <span className="jp-WorkshopPanel-formSecret">
          <input
            type={revealed ? 'text' : 'password'}
            value={value}
            placeholder={field.placeholder}
            autoComplete="off"
            onChange={event => onChange(event.target.value)}
          />
          <button
            type="button"
            className="jp-Button jp-mod-styled jp-mod-minimal"
            onClick={onReveal}
          >
            {revealed ? 'Hide' : 'Show'}
          </button>
        </span>
      );
      break;

    default:
      control = (
        <input
          type={
            field.type === 'number'
              ? 'number'
              : field.type === 'email'
                ? 'email'
                : field.type === 'url'
                  ? 'url'
                  : 'text'
          }
          value={value}
          placeholder={field.placeholder}
          min={field.type === 'number' ? field.min : undefined}
          max={field.type === 'number' ? field.max : undefined}
          onChange={event => onChange(event.target.value)}
        />
      );
      break;
  }

  return (
    <label
      className={`jp-WorkshopPanel-formField${problem ? ' jp-mod-invalid' : ''}`}
    >
      <span className="jp-WorkshopPanel-formLabel">
        {field.label}
        {field.required ? <span aria-hidden="true"> *</span> : null}
      </span>
      {control}
      {field.description ? (
        <span className="jp-WorkshopPanel-formHelp">{field.description}</span>
      ) : null}
      {problem ? (
        <span className="jp-WorkshopPanel-formProblem">{problem}</span>
      ) : null}
    </label>
  );
}

function UnknownBlock({ node }: { node: IDirectiveNode }): JSX.Element {
  return (
    <div
      className="jp-WorkshopPanel-action jp-mod-unknown"
      data-action-id={node.id}
    >
      <div className="jp-WorkshopPanel-actionHeader">
        <span className="jp-WorkshopPanel-actionLabel">
          Unknown directive "{node.name}"
        </span>
      </div>
      <pre className="jp-WorkshopPanel-actionBody">{node.body}</pre>
    </div>
  );
}

function roleRequest(role: string, value: string): IActionRequest | null {
  switch (role) {
    case 'open':
      return {
        type: 'file-open',
        id: 'role-open',
        argument: '',
        options: { path: value },
        body: ''
      };
    case 'copy':
      return {
        type: 'copy',
        id: 'role-copy',
        argument: '',
        options: {},
        body: value
      };
    case 'highlight':
      return {
        type: 'highlight',
        id: 'role-highlight',
        argument: '',
        options: { selector: value },
        body: ''
      };
    default:
      return null;
  }
}

function dispositionBadge(
  disposition: ActionDisposition,
  node: IDirectiveNode
): { label: string; title: string; className: string } | null {
  switch (disposition.kind) {
    case 'reject':
      return {
        label: 'not allowed',
        title: disposition.reason,
        className: 'jp-mod-reject'
      };
    case 'skip':
      return {
        label: node.options.auto ? 'auto off' : 'off',
        title: disposition.reason,
        className: 'jp-mod-trust'
      };
    case 'downgrade':
      return {
        label: 'types only',
        title: disposition.reason,
        className: 'jp-mod-trust'
      };
    case 'confirm':
      return {
        label: 'confirms',
        title: disposition.reason,
        className: 'jp-mod-trust'
      };
    default:
      return null;
  }
}

function displayText(node: IDirectiveNode): string {
  const body = ACTION_TYPES[node.name]?.body;

  if (body === 'none' || node.name === 'file-open') {
    return '';
  }

  return node.body;
}

function showsOutput(node: IDirectiveNode): boolean {
  return node.name === 'execute-capture' || node.name === 'kernel-execute';
}

function statusText(status: { status: string; runs: number }): string {
  switch (status.status) {
    case 'running':
      return 'running';
    case 'ok':
      return status.runs > 1 ? `done ×${status.runs}` : 'done';
    case 'error':
      return 'failed';
    case 'skipped':
      return 'skipped';
    default:
      return '';
  }
}

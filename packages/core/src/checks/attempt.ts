/**
 * An attempt: an answer for the self-test to try against a check, with
 * what the check should then say.
 *
 * The self-test walks a workshop along the path where everything goes
 * right, so on its own it shows that a check passes on a correct answer
 * and nothing of what the check says on a wrong one. An `attempt` block
 * holds the actions that make an answer, names the check to run after
 * them, and says how the check should come out. The learner never sees
 * it. The reading of its options and of the check's result lives here,
 * free of JupyterLab, so lint and the self-test agree.
 */

/** How the check an attempt names should come out. */
export type AttemptResult = 'fail' | 'pass';

/** A parsed attempt. */
export interface IAttemptSpec {
  /** The id of the check to run once the attempt's actions have run. */
  check: string;

  /** Whether the check should fail, as for a wrong answer, or pass. */
  result: AttemptResult;

  /** Text the check's message must contain; empty when any message will do. */
  expect: string;
}

/** The outcome of parsing an attempt: the attempt, or what is wrong with it. */
export interface IAttemptParse {
  attempt?: IAttemptSpec;
  error?: string;
}

/**
 * Read the options of an `attempt` directive. An attempt that expects a
 * failure must say what the check should say, since that message is
 * what it is there to test; one that expects a pass need not.
 */
export function parseAttempt(options: Record<string, string>): IAttemptParse {
  const check = (options.check ?? '').trim();
  const result = (options.result ?? 'fail').trim();
  const expect = (options.expect ?? '').trim();

  if (check === '') {
    return { error: 'An attempt needs a "check" option naming a verify' };
  }

  if (result !== 'fail' && result !== 'pass') {
    return {
      error: `The "result" of an attempt is "fail" or "pass", not "${result}"`
    };
  }

  if (result === 'fail' && expect === '') {
    return {
      error:
        'An attempt needs an "expect" option with text the check should say when it fails'
    };
  }

  return { attempt: { check, result, expect } };
}

/**
 * What is wrong with how a check came out for an attempt, or null when
 * it came out as the attempt expects. The expected text may be any part
 * of the message, and runs of white space count as one space on both
 * sides, so a message wrapped over lines still matches.
 */
export function attemptProblem(
  attempt: IAttemptSpec,
  outcome: { status: string; message?: string }
): string | null {
  const said = comparable(outcome.message ?? '');
  const quoted = said === '' ? 'nothing' : `"${said}"`;

  if (attempt.result === 'fail' && outcome.status === 'ok') {
    return `The check "${attempt.check}" passed, and was expected to fail; it said ${quoted}`;
  }

  if (attempt.result === 'pass' && outcome.status === 'error') {
    return `The check "${attempt.check}" failed, and was expected to pass; it said ${quoted}`;
  }

  if (outcome.status !== 'ok' && outcome.status !== 'error') {
    return `The check "${attempt.check}" did not run: ${said || outcome.status}`;
  }

  if (attempt.expect !== '' && !said.includes(comparable(attempt.expect))) {
    return `The check "${attempt.check}" said ${quoted}, which does not contain "${attempt.expect}"`;
  }

  return null;
}

function comparable(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

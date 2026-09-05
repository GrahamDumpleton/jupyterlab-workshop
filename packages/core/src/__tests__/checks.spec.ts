import { parseForm, validateForm } from '../checks/form';
import { describeRequirement, parseRequirement } from '../checks/gating';
import { gradeQuiz, parseQuiz } from '../checks/quiz';
import {
  CONTENTS_PREDICATES,
  UI_PREDICATES,
  parsePredicates,
  parseTriggers,
  verifySubstrate
} from '../checks/verify';
import { effectiveCapability } from '../trust/capabilities';
import { decideAction } from '../trust/policy';

describe('parseTriggers', () => {
  it('parses each trigger form', () => {
    const { triggers, errors } = parseTriggers(
      'click; page-enter; after:setup; action; terminal-output "git commit"; terminal-output /^done$/; file-saved demo/README.md; cell-executed train; interval 5s'
    );

    expect(errors).toEqual([]);
    expect(triggers).toEqual([
      { kind: 'click' },
      { kind: 'page-enter' },
      { kind: 'action', id: 'setup' },
      { kind: 'action' },
      { kind: 'terminal-output', pattern: 'git commit', regex: false },
      { kind: 'terminal-output', pattern: '^done$', regex: true },
      { kind: 'file-saved', path: 'demo/README.md' },
      { kind: 'cell-executed', tag: 'train' },
      { kind: 'interval', ms: 5000 }
    ]);
  });

  it('reports malformed triggers', () => {
    const { triggers, errors } = parseTriggers(
      'teleport; interval 100ms; file-saved; terminal-output'
    );

    expect(triggers).toEqual([]);
    expect(errors).toHaveLength(4);
    expect(parseTriggers(undefined)).toEqual({ triggers: [], errors: [] });
  });
});

describe('parsePredicates', () => {
  it('parses contents and ui predicates', () => {
    const contents = parsePredicates(
      'exists demo/README.md\n# comment\nmatches demo/README.md ^# Demo project\ncell-executed scratch/hello.ipynb train',
      CONTENTS_PREDICATES
    );

    expect(contents.errors).toEqual([]);
    expect(contents.predicates).toEqual([
      { name: 'exists', args: ['demo/README.md'] },
      { name: 'matches', args: ['demo/README.md', '^# Demo project'] },
      { name: 'cell-executed', args: ['scratch/hello.ipynb', 'train'] }
    ]);

    const ui = parsePredicates('terminal-open git', UI_PREDICATES);

    expect(ui.predicates).toEqual([{ name: 'terminal-open', args: ['git'] }]);
  });

  it('reports unknown and incomplete predicates', () => {
    const parsed = parsePredicates(
      'nope x\ncontains only',
      CONTENTS_PREDICATES
    );

    expect(parsed.errors).toEqual([
      'Unknown predicate "nope"',
      'Predicate "contains" needs 2 arguments'
    ]);
    expect(parsePredicates('', UI_PREDICATES).errors).toEqual([
      'No predicates given'
    ]);
  });
});

describe('verifySubstrate', () => {
  it('defaults by options', () => {
    expect(verifySubstrate({})).toBe('kernel');
    expect(verifySubstrate({ script: 'verify/x.py' })).toBe('script');
    expect(verifySubstrate({ substrate: 'ui' })).toBe('ui');
    expect(verifySubstrate({ substrate: 'magic' })).toBeNull();
  });

  it('decides the capability by substrate', () => {
    expect(effectiveCapability('verify', {})).toBe('kernel-exec');
    expect(effectiveCapability('verify', { substrate: 'contents' })).toBe(
      'none'
    );
    expect(
      decideAction({
        type: 'verify',
        options: { substrate: 'contents' },
        level: 'restricted',
        automatic: false,
        declared: []
      })
    ).toEqual({ kind: 'run' });
    expect(
      decideAction({
        type: 'verify',
        options: {},
        level: 'restricted',
        automatic: false,
        declared: ['kernel-exec']
      })
    ).toMatchObject({ kind: 'skip' });
  });
});

describe('parseQuiz', () => {
  const BODY = `
question: Which command stages changes?
options:
  - { text: git add, correct: true }
  - { text: git commit }
  - git stage-it
explanation: git add stages.
`;

  it('parses and grades a single answer quiz', () => {
    const { quiz, errors } = parseQuiz(BODY, { attempts: '2' });

    expect(errors).toEqual([]);
    expect(quiz).toMatchObject({
      question: 'Which command stages changes?',
      type: 'single',
      attempts: 2,
      explanation: 'git add stages.'
    });
    expect(quiz?.options).toHaveLength(3);
    expect(gradeQuiz(quiz!, [0])).toBe(true);
    expect(gradeQuiz(quiz!, [1])).toBe(false);
    expect(gradeQuiz(quiz!, [0, 1])).toBe(false);
  });

  it('reports problems', () => {
    expect(parseQuiz('question: x\noptions: [a, b]', {}).errors).toEqual([
      'No option is marked correct'
    ]);
    expect(
      parseQuiz(
        'question: x\noptions:\n  - {text: a, correct: true}\n  - {text: b, correct: true}',
        { type: 'single' }
      ).errors
    ).toEqual(['A single answer quiz has more than one correct option']);
    expect(parseQuiz('- just a list', {}).errors).toEqual([
      'The quiz body must be a mapping'
    ]);
    expect(parseQuiz(BODY, { type: 'triple' }).errors[0]).toContain('triple');
  });
});

describe('parseForm', () => {
  const BODY = `
fields:
  - { name: user_name, type: text, label: Name, required: true, pattern: "^.+$" }
  - { name: repo_dir, type: path, default: demo }
  - { name: pkg, type: select, options: [pip, conda], set_track: true }
  - { name: age, type: number, min: 1, max: 120 }
  - { name: email, type: email }
`;

  it('parses fields and validates values', () => {
    const { form, errors } = parseForm(BODY);

    expect(errors).toEqual([]);
    expect(form?.fields.map(field => field.name)).toEqual([
      'user_name',
      'repo_dir',
      'pkg',
      'age',
      'email'
    ]);
    expect(form?.fields[2].setTrack).toBe(true);
    expect(form?.fields[1].default).toBe('demo');

    expect(validateForm(form!, { pkg: 'pip', age: '30' })).toEqual({
      user_name: 'This field is required'
    });
    expect(
      validateForm(form!, {
        user_name: 'A',
        pkg: 'npm',
        age: '200',
        email: 'nope'
      })
    ).toEqual({
      pkg: 'Choose one of the options',
      age: 'Enter a number of at most 120',
      email: 'Enter an email address'
    });
  });

  it('accepts a bare list and reports problems', () => {
    expect(parseForm('- { name: a }').form?.fields[0]).toMatchObject({
      name: 'a',
      type: 'text',
      label: 'a'
    });
    expect(parseForm('- { name: a, type: select }').errors).toEqual([
      'Field "a" needs "options"'
    ]);
    expect(parseForm('- { name: a }\n- { name: a }').errors).toEqual([
      'Field "a" is listed twice'
    ]);
    expect(parseForm('- { name: 1bad }').errors).toEqual([
      'Invalid field name "1bad"'
    ]);
    expect(parseForm('nothing: here').errors).toEqual([
      'The form needs a list of fields'
    ]);
  });
});

describe('requirements', () => {
  it('parses and describes', () => {
    expect(parseRequirement('verify:first-commit')).toEqual({
      kind: 'verify',
      id: 'first-commit'
    });
    expect(parseRequirement('quiz: staging')).toEqual({
      kind: 'quiz',
      id: 'staging'
    });
    expect(parseRequirement('task:x')).toBeNull();
    expect(parseRequirement('verify:')).toBeNull();
    expect(describeRequirement({ kind: 'form', id: 'setup' })).toBe(
      'Fill in the form "setup"'
    );
  });
});

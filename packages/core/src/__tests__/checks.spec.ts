import { parseForm, validateForm } from '../checks/form';
import { describeRequirement, parseRequirement } from '../checks/gating';
import {
  gradeAnswer,
  gradeQuiz,
  parseQuiz,
  quizTestAnswer
} from '../checks/quiz';
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

describe('a quiz with a typed answer', () => {
  const BODY = `
question: What does print(10 / 2) show?
answer: "5.0"
wrong:
  - { text: "5", explanation: Division gives a float. }
  - { pattern: "5\\\\.0+", explanation: One digit only. }
otherwise: Think about the type.
explanation: True division.
`;
  const OPTIONS: Record<string, string> = { type: 'text' };

  it('grades what was typed exactly, apart from white space around it', () => {
    const { quiz, errors } = parseQuiz(BODY, OPTIONS);

    expect(errors).toEqual([]);
    expect(quiz).toMatchObject({ type: 'text', options: [], lines: 1 });
    expect(gradeAnswer(quiz!, '5.0')).toEqual({ correct: true });
    expect(gradeAnswer(quiz!, '  5.0 \n')).toEqual({ correct: true });
    expect(gradeAnswer(quiz!, '5')).toEqual({
      correct: false,
      explanation: 'Division gives a float.'
    });
    expect(gradeAnswer(quiz!, '5.00')).toEqual({
      correct: false,
      explanation: 'One digit only.'
    });
    expect(gradeAnswer(quiz!, 'five')).toEqual({
      correct: false,
      explanation: 'Think about the type.'
    });
    expect(quizTestAnswer(quiz!)).toBe('5.0');
  });

  it('keeps case unless told to ignore it', () => {
    const body = 'question: x\nanswer: "True"';
    const exact = parseQuiz(body, OPTIONS).quiz!;
    const loose = parseQuiz(body, { type: 'text', case: 'false' }).quiz!;

    expect(gradeAnswer(exact, 'true').correct).toBe(false);
    expect(gradeAnswer(loose, 'true').correct).toBe(true);
    expect(gradeAnswer(exact, 'xyz').explanation).toBeUndefined();
  });

  it('compares several lines, ignoring white space at line ends', () => {
    const quiz = parseQuiz('question: x\nanswer: "1\\n2"', {
      type: 'text',
      lines: '2'
    }).quiz!;

    expect(quiz.lines).toBe(2);
    expect(gradeAnswer(quiz, '1  \r\n2\n').correct).toBe(true);
    expect(gradeAnswer(quiz, '1\n 2').correct).toBe(false);
  });

  it('accepts any of a list of answers, and a pattern with an example', () => {
    const quiz = parseQuiz(
      'question: x\nanswer:\n  - { pattern: "0x[0-9a-f]+", example: "0x1f" }\n  - "none"',
      OPTIONS
    ).quiz!;

    expect(gradeAnswer(quiz, '0xbeef').correct).toBe(true);
    expect(gradeAnswer(quiz, 'at 0xbeef').correct).toBe(false);
    expect(gradeAnswer(quiz, 'none').correct).toBe(true);
    expect(quizTestAnswer(quiz)).toBe('none');
  });

  it('refuses an answer that YAML did not read as text', () => {
    expect(parseQuiz('question: x\nanswer: 4.0', OPTIONS).errors[0]).toContain(
      'The answer 4 is not text'
    );
    expect(parseQuiz('question: x\nanswer: True', OPTIONS).errors[0]).toContain(
      'The answer true is not text'
    );
    expect(
      parseQuiz('question: x\nanswer: ["a", [1, 2]]', OPTIONS).errors[0]
    ).toContain('The answer [1,2] is not text');
    expect(
      parseQuiz(
        'question: x\nanswer: "4"\nwrong:\n  - { text: 4.0, explanation: y }',
        OPTIONS
      ).errors[0]
    ).toContain('The wrong text 4 is not text');
  });

  it('reports problems', () => {
    const problems = (body: string, options = OPTIONS): string[] =>
      parseQuiz(`question: x\n${body}`, options).errors;

    expect(problems('')).toEqual(['A text quiz needs an "answer"']);
    expect(problems('answer: "a"\noptions: [a]')).toEqual([
      'A text quiz takes an "answer", not "options"'
    ]);
    expect(problems('answer: { pattern: "a+" }')[0]).toContain(
      'for the self-test to type'
    );
    expect(problems('answer: { pattern: "a(" }')[0]).toContain(
      'Invalid pattern'
    );
    expect(problems('answer: { pattern: "a+", example: "b" }')[0]).toContain(
      'does not match the pattern'
    );
    expect(
      problems('answer: "a"\nwrong:\n  - { text: " a ", explanation: y }')
    ).toEqual(['The wrong answer " a " is also an accepted answer']);
    expect(problems('answer: "a"\nwrong:\n  - { text: "b" }')).toEqual([
      'Each wrong answer needs an "explanation"'
    ]);
    expect(problems('answer: "a"', { type: 'text', lines: '0' })[0]).toContain(
      'Lines must be'
    );
    expect(problems('answer: "a"', { type: 'text', shuffle: 'false' })).toEqual(
      ['A text quiz has no options to shuffle']
    );
    expect(
      parseQuiz(
        'question: x\nanswer: "a"\noptions:\n  - { text: a, correct: true }',
        { lines: '2' }
      ).errors
    ).toEqual([
      '"answer" is for a quiz of type text',
      'The lines option is for a quiz of type text'
    ]);
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

  it('shuffles the options unless told not to', () => {
    // The correct answer tends to be written first, so showing the
    // options as written is what a quiz has to ask for.
    expect(parseQuiz(BODY, {}).quiz?.shuffle).toBe(true);
    expect(parseQuiz(BODY, { shuffle: 'true' }).quiz?.shuffle).toBe(true);
    expect(parseQuiz(BODY, { shuffle: 'false' }).quiz?.shuffle).toBe(false);
    expect(parseQuiz(BODY, { shuffle: 'no' }).errors).toEqual([
      'Shuffle must be true or false, not "no"'
    ]);
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

import { load } from 'js-yaml';

import { isRecord } from '../util';

/** One answer the learner may pick. */
export interface IQuizOption {
  text: string;
  correct: boolean;
  explanation?: string;
}

/**
 * One answer a typed quiz looks for: the text itself, or a regular
 * expression the whole of what was typed must match.
 */
export interface IQuizAnswer {
  text?: string;
  pattern?: string;

  /** For a pattern, an answer that matches it, which the self-test types. */
  example?: string;

  /** For an expected wrong answer, why it is wrong. */
  explanation?: string;
}

/** How a typed answer was graded. */
export interface IQuizGrade {
  correct: boolean;

  /** What to tell the learner about a wrong answer, when the quiz says. */
  explanation?: string;
}

/** A parsed quiz. */
export interface IQuizSpec {
  question: string;

  /** The answers to pick from, empty for a `text` quiz. */
  options: IQuizOption[];
  type: 'single' | 'multi' | 'text';

  /** For a `text` quiz, the answers that are accepted. */
  answers: IQuizAnswer[];

  /** For a `text` quiz, the wrong answers the author expects. */
  wrong: IQuizAnswer[];

  /** For a `text` quiz, what any other wrong answer is told. */
  otherwise?: string;

  /** Whether a typed answer must match in case, which it must by default. */
  matchCase: boolean;

  /** The number of lines the learner is given to type in. */
  lines: number;

  /**
   * Whether the options are shown in an order other than the one
   * written, which they are unless the quiz says `shuffle: false`: the
   * correct answer tends to be written first.
   */
  shuffle: boolean;

  /** Attempts allowed, or 0 for unlimited. */
  attempts: number;
  explanation?: string;
}

/** The most lines a typed answer can be given. */
const MAX_LINES = 20;

/** The parsed quiz, or the reasons it could not be parsed. */
export interface IParsedQuiz {
  quiz: IQuizSpec | null;
  errors: string[];
}

/**
 * Parse the YAML body and options of a `quiz` directive.
 */
export function parseQuiz(
  body: string,
  options: Record<string, string>
): IParsedQuiz {
  const errors: string[] = [];
  let data: unknown;

  try {
    data = load(body);
  } catch (error) {
    return { quiz: null, errors: [`Invalid YAML: ${String(error)}`] };
  }

  if (!isRecord(data)) {
    return { quiz: null, errors: ['The quiz body must be a mapping'] };
  }

  const question =
    typeof data.question === 'string' ? data.question.trim() : '';

  if (question === '') {
    errors.push('The quiz needs a "question"');
  }

  const type = options.type ?? 'single';
  const typed = type === 'text';

  if (type !== 'single' && type !== 'multi' && !typed) {
    errors.push(`Quiz type must be single, multi or text, not "${type}"`);
  }

  const quizOptions: IQuizOption[] = [];

  if (typed) {
    if (data.options !== undefined) {
      errors.push('A text quiz takes an "answer", not "options"');
    }
  } else if (!Array.isArray(data.options) || data.options.length === 0) {
    errors.push('The quiz needs a list of "options"');
  } else {
    for (const item of data.options) {
      if (typeof item === 'string') {
        quizOptions.push({ text: item, correct: false });
      } else if (isRecord(item) && typeof item.text === 'string') {
        quizOptions.push({
          text: item.text,
          correct: item.correct === true,
          explanation:
            typeof item.explanation === 'string' ? item.explanation : undefined
        });
      } else {
        errors.push('Each option needs a "text"');
      }
    }
  }

  const correct = quizOptions.filter(option => option.correct).length;

  if (quizOptions.length > 0 && correct === 0) {
    errors.push('No option is marked correct');
  }

  if (type === 'single' && correct > 1) {
    errors.push('A single answer quiz has more than one correct option');
  }

  // What only a typed quiz has: the answers it accepts, the wrong ones
  // it expects, and how they are matched and typed.
  for (const key of ['answer', 'wrong', 'otherwise']) {
    if (!typed && data[key] !== undefined) {
      errors.push(`"${key}" is for a quiz of type text`);
    }
  }

  for (const key of ['case', 'lines']) {
    if (!typed && options[key] !== undefined) {
      errors.push(`The ${key} option is for a quiz of type text`);
    }
  }

  if (typed && options.shuffle !== undefined) {
    errors.push('A text quiz has no options to shuffle');
  }

  if (
    options.case !== undefined &&
    options.case !== 'true' &&
    options.case !== 'false'
  ) {
    errors.push(`Case must be true or false, not "${options.case}"`);
  }

  const matchCase = options.case !== 'false';
  const lines = options.lines === undefined ? 1 : Number(options.lines);

  if (!Number.isInteger(lines) || lines < 1 || lines > MAX_LINES) {
    errors.push(
      `Lines must be a whole number from 1 to ${MAX_LINES}, not "${options.lines}"`
    );
  }

  const answers: IQuizAnswer[] = [];
  const wrong: IQuizAnswer[] = [];

  if (typed) {
    const given = Array.isArray(data.answer) ? data.answer : [data.answer];

    if (data.answer === undefined || given.length === 0) {
      errors.push('A text quiz needs an "answer"');
    } else {
      for (const item of given) {
        readAnswer(item, 'answer', answers, errors);
      }
    }

    if (data.wrong !== undefined && !Array.isArray(data.wrong)) {
      errors.push('"wrong" must be a list');
    }

    for (const item of Array.isArray(data.wrong) ? data.wrong : []) {
      readAnswer(item, 'wrong', wrong, errors);
    }

    if (data.otherwise !== undefined && typeof data.otherwise !== 'string') {
      errors.push('"otherwise" must be text');
    }

    // The self-test types an answer, so one has to be written down: a
    // pattern says what is accepted, not what to type.
    if (
      answers.length > 0 &&
      !answers.some(
        answer => answer.text !== undefined || answer.example !== undefined
      )
    ) {
      errors.push(
        'A text quiz needs one answer given as text, or an "example" on a pattern, for the self-test to type'
      );
    }

    // An accepted answer is looked for first, so a wrong answer that is
    // also accepted would never show its explanation.
    if (errors.length === 0) {
      for (const item of wrong) {
        const sample = item.text ?? item.example;

        if (
          sample !== undefined &&
          answers.some(answer => answerMatches(answer, sample, matchCase))
        ) {
          errors.push(
            `The wrong answer ${JSON.stringify(sample)} is also an accepted answer`
          );
        }
      }
    }
  }

  if (
    options.shuffle !== undefined &&
    options.shuffle !== 'true' &&
    options.shuffle !== 'false'
  ) {
    errors.push(`Shuffle must be true or false, not "${options.shuffle}"`);
  }

  const attempts =
    options.attempts === undefined ? 0 : Number(options.attempts);

  if (!Number.isInteger(attempts) || attempts < 0) {
    errors.push(`Attempts must be a whole number, not "${options.attempts}"`);
  }

  if (errors.length > 0) {
    return { quiz: null, errors };
  }

  return {
    quiz: {
      question,
      options: quizOptions,
      type: type as 'single' | 'multi' | 'text',
      answers,
      wrong,
      otherwise:
        typeof data.otherwise === 'string' ? data.otherwise : undefined,
      matchCase,
      lines,
      shuffle: options.shuffle !== 'false',
      attempts,
      explanation:
        typeof data.explanation === 'string' ? data.explanation : undefined
    },
    errors
  };
}

/**
 * Whether a set of picked option indexes is exactly the correct set.
 */
export function gradeQuiz(quiz: IQuizSpec, picked: number[]): boolean {
  const expected = quiz.options
    .map((option, index) => (option.correct ? index : -1))
    .filter(index => index >= 0);
  const chosen = [...new Set(picked)].sort((a, b) => a - b);

  return (
    chosen.length === expected.length &&
    chosen.every((index, position) => index === expected[position])
  );
}

/**
 * Grade what the learner typed into a `text` quiz.
 *
 * The accepted answers are looked for first. A wrong answer the author
 * expected gives its own explanation, and any other gives the quiz's
 * `otherwise`, when it has one.
 */
export function gradeAnswer(quiz: IQuizSpec, typed: string): IQuizGrade {
  if (
    quiz.answers.some(answer => answerMatches(answer, typed, quiz.matchCase))
  ) {
    return { correct: true };
  }

  const expected = quiz.wrong.find(answer =>
    answerMatches(answer, typed, quiz.matchCase)
  );

  return {
    correct: false,
    explanation: expected?.explanation ?? quiz.otherwise
  };
}

/**
 * An answer a `text` quiz accepts, for the self-test to type: the first
 * given as text, or else the first example of a pattern. Null for a quiz
 * of another type.
 */
export function quizTestAnswer(quiz: IQuizSpec): string | null {
  const literal = quiz.answers.find(answer => answer.text !== undefined);

  if (literal?.text !== undefined) {
    return literal.text;
  }

  return (
    quiz.answers.find(answer => answer.example !== undefined)?.example ?? null
  );
}

/**
 * Text as it is compared: line endings made the same, white space at the
 * end of each line dropped, and white space around the whole trimmed.
 * White space inside a line is kept, as is case: `4.0` against `4`, or
 * `True` against `true`, is often the point of the question.
 */
function comparable(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .trim();
}

/** Whether what was typed is this answer. */
function answerMatches(
  answer: IQuizAnswer,
  typed: string,
  matchCase: boolean
): boolean {
  const given = comparable(typed);

  if (answer.pattern !== undefined) {
    try {
      return new RegExp(`^(?:${answer.pattern})$`, matchCase ? '' : 'i').test(
        given
      );
    } catch {
      return false;
    }
  }

  const wanted = comparable(answer.text ?? '');

  return matchCase
    ? given === wanted
    : given.toLowerCase() === wanted.toLowerCase();
}

/**
 * Read one entry of `answer` or `wrong` into the list, reporting what is
 * wrong with it.
 *
 * A value YAML did not read as text is refused and not converted: an
 * unquoted `4.0` is read as the number 4, `True` as a boolean and
 * `[1, 2]` as a list, so the answer compared against would not be the
 * one the author wrote.
 */
function readAnswer(
  item: unknown,
  key: 'answer' | 'wrong',
  into: IQuizAnswer[],
  errors: string[]
): void {
  if (typeof item === 'string') {
    if (key === 'wrong') {
      errors.push(
        'Each wrong answer needs a "text" or "pattern" and an "explanation"'
      );
    } else if (comparable(item) === '') {
      errors.push('An answer is empty');
    } else {
      into.push({ text: item });
    }

    return;
  }

  if (!isRecord(item)) {
    errors.push(notText(item, key));

    return;
  }

  const answer: IQuizAnswer = {};

  for (const field of ['text', 'pattern', 'example', 'explanation'] as const) {
    const value = item[field];

    if (typeof value === 'string') {
      answer[field] = value;
    } else if (value !== undefined) {
      errors.push(notText(value, `${key} ${field}`));

      return;
    }
  }

  if ((answer.text === undefined) === (answer.pattern === undefined)) {
    errors.push(
      key === 'answer'
        ? 'Each answer is text, or a mapping with one of "text" or "pattern"'
        : 'Each wrong answer needs one of "text" or "pattern"'
    );

    return;
  }

  if (answer.text !== undefined && comparable(answer.text) === '') {
    errors.push('An answer is empty');

    return;
  }

  if (answer.pattern !== undefined) {
    try {
      new RegExp(answer.pattern);
    } catch (error) {
      errors.push(`Invalid pattern "${answer.pattern}": ${String(error)}`);

      return;
    }

    if (
      answer.example !== undefined &&
      !answerMatches({ pattern: answer.pattern }, answer.example, true)
    ) {
      errors.push(
        `The example ${JSON.stringify(answer.example)} does not match the pattern "${answer.pattern}"`
      );

      return;
    }
  } else if (answer.example !== undefined) {
    errors.push('An "example" goes with a "pattern"');

    return;
  }

  if (key === 'wrong' && answer.explanation === undefined) {
    errors.push('Each wrong answer needs an "explanation"');

    return;
  }

  into.push(answer);
}

/** The problem with a value that YAML did not read as text. */
function notText(value: unknown, what: string): string {
  return `The ${what} ${JSON.stringify(value)} is not text: put it in quotes, since YAML reads an unquoted number, true, false, null, list or mapping as that and not as what was written`;
}

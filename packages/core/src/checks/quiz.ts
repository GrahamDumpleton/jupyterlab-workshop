import { load } from 'js-yaml';

import { isRecord } from '../util';

/** One answer the learner may pick. */
export interface IQuizOption {
  text: string;
  correct: boolean;
  explanation?: string;
}

/** A parsed quiz. */
export interface IQuizSpec {
  question: string;
  options: IQuizOption[];
  type: 'single' | 'multi';
  shuffle: boolean;

  /** Attempts allowed, or 0 for unlimited. */
  attempts: number;
  explanation?: string;
}

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

  const quizOptions: IQuizOption[] = [];

  if (!Array.isArray(data.options) || data.options.length === 0) {
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

  const type = options.type ?? 'single';

  if (type !== 'single' && type !== 'multi') {
    errors.push(`Quiz type must be single or multi, not "${type}"`);
  }

  const correct = quizOptions.filter(option => option.correct).length;

  if (quizOptions.length > 0 && correct === 0) {
    errors.push('No option is marked correct');
  }

  if (type === 'single' && correct > 1) {
    errors.push('A single answer quiz has more than one correct option');
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
      type: type as 'single' | 'multi',
      shuffle: options.shuffle === 'true',
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

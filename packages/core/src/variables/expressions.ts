/**
 * A tiny expression language for `when` conditions.
 *
 * Grammar, lowest precedence first:
 *
 *     or       := and ("or" and)*
 *     and      := not ("and" not)*
 *     not      := "not" not | comparison
 *     compare  := primary (("==" | "!=" | "in" | "not in") primary)?
 *     primary  := "(" or ")" | string | list | "true" | "false" | name
 *
 * Names resolve to workshop variables. Values are strings, booleans or
 * lists of strings. A string is true when it is non-empty and not one of
 * `false`, `no` or `0`.
 */

import { Variables } from './substitute';

/** Error raised for a malformed expression. */
export class ExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpressionError';
  }
}

/** Result of evaluating an expression. */
export interface IEvaluation {
  value: boolean;

  /** Names referenced by the expression that had no value. */
  unknown: string[];
}

type Value = string | boolean | string[];

interface IToken {
  kind: 'name' | 'string' | 'op' | 'punct' | 'end';
  text: string;
}

const KEYWORDS = new Set(['and', 'or', 'not', 'in', 'true', 'false']);

/**
 * Evaluate a `when` expression against variables.
 */
export function evaluateExpression(
  source: string,
  variables: Variables
): IEvaluation {
  const parser = new Parser(tokenize(source), variables);
  const value = parser.parse();

  return { value: truthy(value), unknown: parser.unknown };
}

/**
 * Return the variable names an expression refers to, without evaluating it.
 */
export function expressionNames(source: string): string[] {
  const names: string[] = [];

  for (const token of tokenize(source)) {
    if (token.kind === 'name' && !KEYWORDS.has(token.text)) {
      names.push(token.text);
    }
  }

  return names;
}

function tokenize(source: string): IToken[] {
  const tokens: IToken[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index];

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    // Two character operators, then single punctuation.
    const pair = source.slice(index, index + 2);

    if (pair === '==' || pair === '!=') {
      tokens.push({ kind: 'op', text: pair });
      index += 2;
      continue;
    }

    if (
      char === '(' ||
      char === ')' ||
      char === '[' ||
      char === ']' ||
      char === ','
    ) {
      tokens.push({ kind: 'punct', text: char });
      index += 1;
      continue;
    }

    // Quoted strings with either quote style and backslash escapes.
    if (char === '"' || char === "'") {
      let end = index + 1;
      let text = '';

      while (end < source.length && source[end] !== char) {
        if (source[end] === '\\' && end + 1 < source.length) {
          end += 1;
        }

        text += source[end];
        end += 1;
      }

      if (end >= source.length) {
        throw new ExpressionError(`Unterminated string in "${source}"`);
      }

      tokens.push({ kind: 'string', text });
      index = end + 1;
      continue;
    }

    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(index));

    if (name) {
      tokens.push({ kind: 'name', text: name[0] });
      index += name[0].length;
      continue;
    }

    throw new ExpressionError(`Unexpected character "${char}" in "${source}"`);
  }

  tokens.push({ kind: 'end', text: '' });

  return tokens;
}

class Parser {
  constructor(tokens: IToken[], variables: Variables) {
    this._tokens = tokens;
    this._variables = variables;
  }

  readonly unknown: string[] = [];

  parse(): Value {
    const value = this._or();

    if (this._peek().kind !== 'end') {
      throw new ExpressionError(`Unexpected "${this._peek().text}"`);
    }

    return value;
  }

  private _or(): Value {
    let left = this._and();

    while (this._acceptName('or')) {
      const right = this._and();

      left = truthy(left) || truthy(right);
    }

    return left;
  }

  private _and(): Value {
    let left = this._not();

    while (this._acceptName('and')) {
      const right = this._not();

      left = truthy(left) && truthy(right);
    }

    return left;
  }

  private _not(): Value {
    if (this._acceptName('not')) {
      return !truthy(this._not());
    }

    return this._comparison();
  }

  private _comparison(): Value {
    const left = this._primary();
    const token = this._peek();

    if (token.kind === 'op') {
      this._next();

      const right = this._primary();
      const equal = asString(left) === asString(right);

      return token.text === '==' ? equal : !equal;
    }

    if (token.kind === 'name' && token.text === 'in') {
      this._next();

      return contains(this._primary(), left);
    }

    if (token.kind === 'name' && token.text === 'not') {
      // Only `not in` is valid here; a bare `not` cannot follow a value.
      this._next();

      if (!this._acceptName('in')) {
        throw new ExpressionError('Expected "in" after "not"');
      }

      return !contains(this._primary(), left);
    }

    return left;
  }

  private _primary(): Value {
    const token = this._next();

    if (token.kind === 'punct' && token.text === '(') {
      const value = this._or();

      this._expect(')');

      return value;
    }

    if (token.kind === 'punct' && token.text === '[') {
      return this._list();
    }

    if (token.kind === 'string') {
      return token.text;
    }

    if (token.kind === 'name') {
      if (token.text === 'true') {
        return true;
      }

      if (token.text === 'false') {
        return false;
      }

      if (KEYWORDS.has(token.text)) {
        throw new ExpressionError(`Unexpected keyword "${token.text}"`);
      }

      if (!(token.text in this._variables)) {
        this.unknown.push(token.text);

        return '';
      }

      return this._variables[token.text];
    }

    throw new ExpressionError(
      token.kind === 'end'
        ? 'Unexpected end of expression'
        : `Unexpected "${token.text}"`
    );
  }

  private _list(): string[] {
    const items: string[] = [];

    if (this._peek().kind === 'punct' && this._peek().text === ']') {
      this._next();

      return items;
    }

    for (;;) {
      items.push(asString(this._primary()));

      if (this._peek().kind === 'punct' && this._peek().text === ',') {
        this._next();
        continue;
      }

      this._expect(']');

      return items;
    }
  }

  private _acceptName(text: string): boolean {
    const token = this._peek();

    if (token.kind === 'name' && token.text === text) {
      this._next();

      return true;
    }

    return false;
  }

  private _expect(text: string): void {
    const token = this._next();

    if (token.kind !== 'punct' || token.text !== text) {
      throw new ExpressionError(`Expected "${text}"`);
    }
  }

  private _peek(): IToken {
    return this._tokens[this._position];
  }

  private _next(): IToken {
    const token = this._tokens[this._position];

    if (token.kind !== 'end') {
      this._position += 1;
    }

    return token;
  }

  private _tokens: IToken[];
  private _variables: Variables;
  private _position = 0;
}

function truthy(value: Value): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  const lowered = value.trim().toLowerCase();

  return (
    lowered !== '' && lowered !== 'false' && lowered !== 'no' && lowered !== '0'
  );
}

function asString(value: Value): string {
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  if (Array.isArray(value)) {
    return value.join(',');
  }

  return value;
}

function contains(container: Value, item: Value): boolean {
  const needle = asString(item);

  if (Array.isArray(container)) {
    return container.includes(needle);
  }

  return asString(container).includes(needle);
}

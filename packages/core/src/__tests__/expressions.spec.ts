import {
  ExpressionError,
  evaluateExpression,
  expressionNames
} from '../variables/expressions';

const variables = { track: 'pip', platform: 'macos', lite: 'false', empty: '' };

function value(source: string): boolean {
  return evaluateExpression(source, variables).value;
}

describe('evaluateExpression', () => {
  it('compares variables with strings', () => {
    expect(value('track == "pip"')).toBe(true);
    expect(value("track == 'conda'")).toBe(false);
    expect(value('track != "conda"')).toBe(true);
  });

  it('treats bare variables by truthiness', () => {
    expect(value('track')).toBe(true);
    expect(value('lite')).toBe(false);
    expect(value('not lite')).toBe(true);
    expect(value('empty')).toBe(false);
  });

  it('supports and, or, not and parentheses', () => {
    expect(value('track == "pip" and platform == "macos"')).toBe(true);
    expect(value('track == "conda" or platform == "macos"')).toBe(true);
    expect(value('not (track == "pip" or lite)')).toBe(false);
    expect(value('not track == "pip"')).toBe(false);
  });

  it('supports in and not in against lists and strings', () => {
    expect(value('platform in ["linux", "macos"]')).toBe(true);
    expect(value('platform not in ["windows"]')).toBe(true);
    expect(value('"mac" in platform')).toBe(true);
    expect(value('true in [true]')).toBe(true);
  });

  it('reports unknown names and treats them as empty', () => {
    const result = evaluateExpression('missing == ""', variables);

    expect(result.value).toBe(true);
    expect(result.unknown).toEqual(['missing']);
  });

  it('rejects malformed expressions', () => {
    expect(() => value('track ==')).toThrow(ExpressionError);
    expect(() => value('track == "pip" extra')).toThrow(ExpressionError);
    expect(() => value('"unterminated')).toThrow(ExpressionError);
    expect(() => value('track = "pip"')).toThrow(ExpressionError);
    expect(() => value('(track')).toThrow(ExpressionError);
  });
});

describe('expressionNames', () => {
  it('lists the variables an expression uses', () => {
    expect(expressionNames('track == "pip" and not lite or x in [y]')).toEqual([
      'track',
      'lite',
      'x',
      'y'
    ]);
  });
});

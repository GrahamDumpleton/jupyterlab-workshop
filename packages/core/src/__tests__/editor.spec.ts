import {
  IMatchTarget,
  editorTargetProblems,
  expandReplacement,
  findEditorMatches,
  lineAt,
  lineCount,
  lineSpan,
  lineStart,
  lineTextSpan,
  parseEditorTarget
} from '../actions/editor';

const SOURCE = [
  'import os',
  '',
  'def greet(name):',
  '    print("hi")',
  '    print(name)',
  '',
  'def farewell(name):',
  '    print("bye")',
  ''
].join('\n');

function matchTarget(
  pattern: string,
  extra: Partial<IMatchTarget> = {}
): IMatchTarget {
  return {
    kind: 'match',
    pattern,
    regex: false,
    occurrence: { start: 1, end: 1 },
    expand: false,
    position: 'before',
    ...extra
  };
}

describe('parseEditorTarget', () => {
  it('reads a literal match with the defaults', () => {
    const { target, errors } = parseEditorTarget('editor-select', {
      match: 'print'
    });

    expect(errors).toEqual([]);
    expect(target).toEqual(
      matchTarget('print', { occurrence: { start: 1, end: 1 } })
    );
  });

  it('reads occurrences, groups, expansion and position', () => {
    expect(
      parseEditorTarget('editor-highlight', {
        match: 'def (\\w+)',
        regex: 'true',
        occurrence: '2-3',
        group: '1'
      }).target
    ).toEqual(
      matchTarget('def (\\w+)', {
        regex: true,
        occurrence: { start: 2, end: 3 },
        group: '1'
      })
    );
    expect(
      parseEditorTarget('editor-replace', {
        match: 'x',
        regex: 'true',
        occurrence: 'all',
        expand: 'true'
      }).target
    ).toMatchObject({ occurrence: { start: 1, end: null }, expand: true });
    expect(
      parseEditorTarget('editor-insert', {
        match: 'x',
        position: 'after'
      }).target
    ).toMatchObject({ position: 'after' });
  });

  it('reads line numbers, ranges and the end', () => {
    expect(parseEditorTarget('editor-select', { line: '4' }).target).toEqual({
      kind: 'line',
      start: 4,
      end: 4,
      position: 'before'
    });
    expect(
      parseEditorTarget('editor-replace', { line: '4-5' }).target
    ).toMatchObject({ kind: 'line', start: 4, end: 5 });
    expect(parseEditorTarget('editor-insert', { line: 'end' }).target).toEqual({
      kind: 'end'
    });
    expect(parseEditorTarget('editor-insert', {}).target).toEqual({
      kind: 'end'
    });
  });

  it('reports the problems the linter shows', () => {
    const problems = (type: string, options: Record<string, string>) =>
      editorTargetProblems(type, options);

    expect(problems('editor-select', {})).toEqual([
      'A "match" or a "line" option is needed'
    ]);
    expect(problems('editor-select', { match: 'a', line: '1' })).toEqual([
      'Give either a "match" or a "line" option, not both'
    ]);
    expect(problems('editor-select', { line: '0' })[0]).toMatch(
      /line number or a range/
    );
    expect(problems('editor-select', { line: '5-2' })[0]).toMatch(
      /line number or a range/
    );
    expect(problems('editor-insert', { line: '2-3' })[0]).toMatch(
      /single line, not a range/
    );
    expect(problems('editor-insert', { line: 'start' })[0]).toMatch(
      /line number or end/
    );
    expect(problems('editor-select', { match: 'a', regex: 'yes' })).toEqual([
      'The "regex" option must be true or false'
    ]);
    expect(problems('editor-select', { line: '1', occurrence: '2' })).toEqual([
      'The "occurrence" option needs a "match" option'
    ]);
    expect(
      problems('editor-select', { match: 'a', occurrence: '3-2' })[0]
    ).toMatch(/a number, a range like 2-3, or all/);
    expect(problems('editor-select', { match: 'a', group: '1' })).toEqual([
      'The "group" option needs "regex: true"'
    ]);
    expect(problems('editor-replace', { match: 'a', expand: 'true' })).toEqual([
      'The "expand" option needs "regex: true"'
    ]);
    expect(problems('editor-select', { match: '(', regex: 'true' })[0]).toMatch(
      /not a valid regular expression/
    );
    expect(
      problems('editor-select', { match: '(a)', regex: 'true', group: '2' })
    ).toEqual(['The pattern has 1 capture group, so "group: 2" names nothing']);
    expect(
      problems('editor-select', { match: 'a', regex: 'true', group: '1' })
    ).toEqual([
      'The pattern has no capture groups, so "group: 1" names nothing'
    ]);
    expect(
      problems('editor-select', {
        match: '(?<word>a)',
        regex: 'true',
        group: 'other'
      })
    ).toEqual(['The pattern has no group named "other"']);
    expect(
      problems('editor-select', { match: '(a)', regex: 'true', group: '1' })
    ).toEqual([]);
    expect(
      problems('editor-insert', { match: 'a', position: 'above' })
    ).toEqual(['The "position" option must be before or after']);
    expect(problems('editor-select', { match: '' })).toEqual([
      'The "match" option is empty'
    ]);
  });
});

describe('findEditorMatches', () => {
  it('finds literal text by occurrence', () => {
    const all = findEditorMatches(
      SOURCE,
      matchTarget('print', { occurrence: { start: 1, end: null } })
    );

    expect(all.map(match => match.start)).toEqual([
      SOURCE.indexOf('print'),
      SOURCE.indexOf('print', SOURCE.indexOf('print') + 1),
      SOURCE.lastIndexOf('print')
    ]);
    expect(
      findEditorMatches(
        SOURCE,
        matchTarget('print', { occurrence: { start: 2, end: 3 } })
      )
    ).toEqual(all.slice(1));
    expect(
      findEditorMatches(
        SOURCE,
        matchTarget('print', { occurrence: { start: 4, end: 4 } })
      )
    ).toEqual([]);
    expect(findEditorMatches(SOURCE, matchTarget('nowhere'))).toEqual([]);
  });

  it('treats ^ and $ as line anchors in a regex', () => {
    const [match] = findEditorMatches(
      SOURCE,
      matchTarget('^def \\w+\\(.*$', { regex: true })
    );

    expect(match.text).toBe('def greet(name):');
    expect(match.start).toBe(SOURCE.indexOf('def greet'));
  });

  it('spans a function and its body with a lazy run', () => {
    const [match] = findEditorMatches(
      SOURCE,
      matchTarget('def farewell\\(.*\\n(?:    .*\\n)+', { regex: true })
    );

    expect(match.text).toBe('def farewell(name):\n    print("bye")\n');
  });

  it('uses a capture group as the span and keeps the captures', () => {
    const [match] = findEditorMatches(
      SOURCE,
      matchTarget('def (?<name>\\w+)\\(.*\\n((?:    .*\\n)+)', {
        regex: true,
        group: '2'
      })
    );

    expect(SOURCE.slice(match.spanStart, match.spanEnd)).toBe(
      '    print("hi")\n    print(name)\n'
    );
    expect(match.captures[0]).toBe('greet');
    expect(match.named.name).toBe('greet');

    const [named] = findEditorMatches(
      SOURCE,
      matchTarget('def (?<name>\\w+)', { regex: true, group: 'name' })
    );

    expect(SOURCE.slice(named.spanStart, named.spanEnd)).toBe('greet');
  });

  it('skips a match whose group took no part', () => {
    const matches = findEditorMatches(
      'aa\nab\n',
      matchTarget('a(b)?', {
        regex: true,
        group: '1',
        occurrence: { start: 1, end: null }
      })
    );

    expect(matches.map(match => match.text)).toEqual(['ab']);
  });

  it('advances past an empty match', () => {
    const matches = findEditorMatches(
      'ab',
      matchTarget('x*', { regex: true, occurrence: { start: 1, end: null } })
    );

    expect(matches.map(match => match.start)).toEqual([0, 1, 2]);
  });
});

describe('expandReplacement', () => {
  const match = {
    start: 0,
    end: 9,
    spanStart: 0,
    spanEnd: 9,
    text: 'def greet',
    captures: ['greet', undefined],
    named: { name: 'greet' }
  };

  it('expands references the way String.replace does', () => {
    expect(expandReplacement('$1 $<name> $& $$1', match)).toBe(
      'greet greet def greet $1'
    );
  });

  it('leaves references to missing groups alone', () => {
    expect(expandReplacement('$3 $<other> $0', match)).toBe('$3 $<other> $0');
    expect(expandReplacement('$2', match)).toBe('');
  });

  it('falls back from two digits to one', () => {
    expect(expandReplacement('$10', match)).toBe('greet0');
    expect(
      expandReplacement('$10', {
        ...match,
        captures: Array.from({ length: 10 }, (_, index) => `g${index + 1}`)
      })
    ).toBe('g10');
  });
});

describe('line helpers', () => {
  const text = 'one\ntwo\nthree';

  it('counts lines and finds where they start', () => {
    expect(lineCount(text)).toBe(3);
    expect(lineCount(`${text}\n`)).toBe(3);
    expect(lineCount('')).toBe(1);
    expect(lineStart(text, 2)).toBe(4);
    expect(lineStart(text, 9)).toBe(text.length);
    expect(lineAt(text, 0)).toBe(1);
    expect(lineAt(text, 4)).toBe(2);
    expect(lineAt(text, text.length)).toBe(3);
  });

  it('spans whole lines and their text', () => {
    expect(lineSpan(text, 2, 2)).toEqual({ start: 4, end: 8 });
    expect(lineSpan(text, 2, 3)).toEqual({ start: 4, end: text.length });
    expect(lineSpan(text, 1, 9)).toEqual({ start: 0, end: text.length });
    expect(lineSpan(text, 9, 9)).toEqual({
      start: text.length,
      end: text.length
    });
    expect(lineTextSpan(text, 2, 2)).toEqual({ start: 4, end: 7 });
    expect(lineTextSpan(text, 3, 3)).toEqual({ start: 8, end: text.length });
  });
});

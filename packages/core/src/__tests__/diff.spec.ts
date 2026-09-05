import { formatDiff, lineDiff } from '../diff';

describe('lineDiff', () => {
  it('marks added, removed and unchanged lines', () => {
    const diff = lineDiff('a\nb\nc\n', 'a\nx\nc\nd\n');

    expect(formatDiff(diff)).toBe('  a\n- b\n+ x\n  c\n+ d');
  });

  it('handles empty sides', () => {
    expect(lineDiff('', 'a\n')).toEqual([{ kind: 'add', text: 'a' }]);
    expect(lineDiff('a', '')).toEqual([{ kind: 'remove', text: 'a' }]);
    expect(lineDiff('', '')).toEqual([]);
  });
});

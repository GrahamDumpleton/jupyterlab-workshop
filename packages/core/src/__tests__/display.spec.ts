import { actionDisplay } from '../actions/display';

describe('actionDisplay', () => {
  it('leaves the body of other actions to be shown as written', () => {
    expect(actionDisplay('execute', 'ls -l')).toBeNull();
    expect(actionDisplay('highlight', 'The menu bar.')).toBeNull();
    expect(actionDisplay('command', '{"path": "a.txt"}')).toBeNull();
  });

  it('shows what each step of a tour says, numbered', () => {
    const body = [
      '- selector: "#jp-top-panel"',
      '  text: The menu bar.',
      '- selector: "#jp-main-dock-panel"',
      '  text: Notebooks open here.'
    ].join('\n');

    expect(actionDisplay('tour', body)).toEqual([
      '1. The menu bar.',
      '2. Notebooks open here.'
    ]);
  });

  it('keeps the number of a tour step that says nothing', () => {
    const body = [
      '- selector: "#one"',
      '- selector: "#two"',
      '  text: The second.'
    ].join('\n');

    expect(actionDisplay('tour', body)).toEqual(['2. The second.']);
  });

  it('shows the content of each notebook cell', () => {
    const body = [
      '- markdown: |',
      '    # Hello notebook',
      '    Created by a workshop action.',
      '- code: |',
      '    answer = 6 * 7',
      '    answer',
      '  tags: [answer]',
      '- print("bare")',
      '- kind: markdown',
      '  source: Written the long way.',
      '- raw: Left as it is.'
    ].join('\n');

    expect(actionDisplay('notebook-create', body)).toEqual([
      '# Hello notebook\nCreated by a workshop action.',
      'answer = 6 * 7\nanswer',
      'print("bare")',
      'Written the long way.',
      'Left as it is.'
    ]);
  });

  it('leaves out a notebook cell with nothing in it', () => {
    const body = ['- code: ""', '- code: x = 1'].join('\n');

    expect(actionDisplay('notebook-create', body)).toEqual(['x = 1']);
  });

  it('shows nothing for an empty body', () => {
    expect(actionDisplay('notebook-create', '')).toEqual([]);
    expect(actionDisplay('tour', '  \n')).toEqual([]);
  });

  it('leaves a body it cannot read to be shown as written', () => {
    expect(actionDisplay('tour', '- selector: [unclosed')).toBeNull();
    expect(actionDisplay('tour', 'selector: "#one"')).toBeNull();
    expect(actionDisplay('tour', '- text: No selector.')).toBeNull();
    expect(actionDisplay('tour', '- just a string')).toBeNull();
    expect(actionDisplay('notebook-create', 'not a list')).toBeNull();
    expect(actionDisplay('notebook-create', '- 42')).toBeNull();
  });
});

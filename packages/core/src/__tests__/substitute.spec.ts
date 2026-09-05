import { shellQuote, substitute } from '../variables/substitute';

describe('substitute', () => {
  const variables = { repo_dir: 'demo', name: 'Ada Lovelace', empty: '' };

  it('replaces references with values', () => {
    const result = substitute(
      'cd {{ repo_dir }} && echo {{repo_dir}}',
      variables
    );

    expect(result.text).toBe('cd demo && echo demo');
    expect(result.warnings).toEqual([]);
  });

  it('leaves unknown variables in place and warns', () => {
    const result = substitute('{{ missing }}', variables);

    expect(result.text).toBe('{{ missing }}');
    expect(result.warnings).toEqual(['Unknown variable "missing"']);
  });

  it('removes the backslash from an escaped reference', () => {
    const result = substitute('\\{{ repo_dir }}', variables);

    expect(result.text).toBe('{{ repo_dir }}');
    expect(result.warnings).toEqual([]);
  });

  it('ignores references that are not variable names', () => {
    const text =
      "kubectl get pods -o go-template='{{.metadata.name}}' {{ range .Items }}";
    const result = substitute(text, variables);

    expect(result.text).toBe(text);
    expect(result.warnings).toEqual([]);
  });

  it('applies filters left to right', () => {
    expect(substitute('{{ name | lower }}', variables).text).toBe(
      'ada lovelace'
    );
    expect(substitute('{{ name | slug | upper }}', variables).text).toBe(
      'ADA-LOVELACE'
    );
    expect(substitute('{{ empty | default("none") }}', variables).text).toBe(
      'none'
    );
    expect(substitute("{{ repo_dir | default('x') }}", variables).text).toBe(
      'demo'
    );
    expect(substitute('{{ name | shell }}', variables).text).toBe(
      "'Ada Lovelace'"
    );
    expect(
      substitute('{{ repo_dir | path }}/a/b', variables, { pathSep: '\\' }).text
    ).toBe('demo/a/b');
    expect(
      substitute('{{ path | path }}', { path: 'src/app.py' }, { pathSep: '\\' })
        .text
    ).toBe('src\\app.py');
  });

  it('warns on unknown filters and leaves the reference in place', () => {
    const result = substitute('{{ name | bogus }}', variables);

    expect(result.text).toBe('{{ name | bogus }}');
    expect(result.warnings).toEqual(['Unknown filter "bogus"']);
  });
});

describe('shellQuote', () => {
  it('leaves safe words alone and quotes the rest', () => {
    expect(shellQuote('demo/dir')).toBe('demo/dir');
    expect(shellQuote("it's here")).toBe("'it'\\''s here'");
  });
});

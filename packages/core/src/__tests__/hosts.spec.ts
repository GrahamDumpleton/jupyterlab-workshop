import { IHostContext, describeHost } from '../trust/hosts';

const LOCAL: IHostContext = {
  host: 'local',
  container: false,
  user: 'ada',
  hubUser: '',
  address: 'localhost'
};

describe('describeHost', () => {
  it('describes a local host by the account it runs as', () => {
    const { label, description } = describeHost(LOCAL);

    expect(label).toBe('The computer running JupyterLab');
    expect(description).toContain('as the user ada');
    expect(description).toContain('not only the workshop folder');
  });

  it("never calls a local host the learner's own computer", () => {
    expect(describeHost(LOCAL).description).not.toMatch(/your (own )?computer/);
  });

  it('leaves the account out when it is unknown', () => {
    const { description } = describeHost({ ...LOCAL, user: '' });

    expect(description).toContain('was started on. Commands');
  });

  it('names the address unless it is the loopback one', () => {
    for (const address of [
      '',
      'localhost',
      '127.0.0.1',
      '[::1]',
      'x.localhost'
    ]) {
      expect(describeHost({ ...LOCAL, address }).label).not.toContain('(');
    }

    expect(describeHost({ ...LOCAL, address: 'lab.example.org' }).label).toBe(
      'The computer running JupyterLab (lab.example.org)'
    );
  });

  it('describes a local container apart from the computer it is on', () => {
    const { label, description } = describeHost({ ...LOCAL, container: true });

    expect(label).toBe('A container');
    expect(description).toContain('not the whole computer');
  });

  it('describes each hosting service, whatever the container flag says', () => {
    const labels: Record<string, string> = {
      binder: 'Binder (hub.example.org)',
      codespaces: 'GitHub Codespaces (hub.example.org)',
      jupyterhub: 'JupyterHub (hub.example.org)',
      static: 'This browser (JupyterLite)'
    };

    for (const [host, label] of Object.entries(labels)) {
      const described = describeHost({
        ...LOCAL,
        host,
        container: true,
        address: 'hub.example.org'
      });

      expect(described.label).toBe(label);
      expect(described.description).not.toContain('JupyterLab was started on');
    }
  });

  it('names the hub user under JupyterHub', () => {
    const { description } = describeHost({
      ...LOCAL,
      host: 'jupyterhub',
      hubUser: 'ada@example.org'
    });

    expect(description).toContain('as the hub user ada@example.org');
  });

  it('describes an unknown host as local', () => {
    expect(describeHost({ ...LOCAL, host: 'elsewhere' })).toEqual(
      describeHost(LOCAL)
    );
  });
});

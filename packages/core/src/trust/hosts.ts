/**
 * Where a workshop runs: a description of the host for the trust dialog.
 * The capabilities say what a workshop may do, and the host decides how
 * far that reaches, so each description answers the same three things in
 * the same order: where commands and code execute, where files go, and
 * what the network reaches.
 */

/** What is known about the host when the description is written. */
export interface IHostContext {
  /**
   * The service hosting the session as the platform reports it: local,
   * binder, codespaces, jupyterhub or static. Anything else is described
   * as local, which promises the least.
   */
  host: string;

  /** Whether the server runs inside a container. */
  container: boolean;

  /** The account the server runs as, or empty when unknown. */
  user: string;

  /** The JupyterHub user name, or empty when there is none. */
  hubUser: string;

  /** Host name of the address the page was loaded from, or empty. */
  address: string;
}

/** A host as the trust dialog shows it. */
export interface IHostDescription {
  /** A few words naming the host, for the list of facts. */
  label: string;

  /** Sentences saying where code runs, where files go and what it can reach. */
  description: string;
}

/**
 * Whether a host name is the loopback address, which is no more than
 * the browser's name for the computer it runs on, or for a tunnel to
 * another one, and so says nothing worth showing.
 */
function isLoopback(address: string): boolean {
  const name = address.toLowerCase().replace(/^\[|\]$/g, '');

  return (
    name === '' ||
    name === 'localhost' ||
    name.endsWith('.localhost') ||
    name === '::1' ||
    /^127(\.\d{1,3}){3}$/.test(name)
  );
}

/**
 * Describe the host a workshop is about to run on. A local host is never
 * called the learner's own computer: local only means that no hosting
 * service was detected, which is just as true of a server reached over a
 * tunnel, so the text speaks of the computer JupyterLab was started on.
 */
export function describeHost(context: IHostContext): IHostDescription {
  const where = isLoopback(context.address) ? '' : ` (${context.address})`;

  switch (context.host) {
    case 'static':
      return {
        label: 'This browser (JupyterLite)',
        description:
          "Entirely inside this browser tab. Files are kept in this browser's storage for this site, not on your disk, and stay until you clear the site's data. Code runs in the browser's sandbox: it cannot see your files or other programs, and can make only the web requests any web page can."
      };

    case 'binder':
      return {
        label: `Binder${where}`,
        description:
          'In a temporary container on Binder, a public service, not on your computer. Files exist only in that container and are deleted when the session ends or sits idle, so download anything you want to keep. Code can reach the public internet within limits the operator sets, and nothing on your own computer or network. Do not enter passwords or tokens here.'
      };

    case 'codespaces':
      return {
        label: `GitHub Codespaces${where}`,
        description:
          'In your GitHub codespace, a container on a virtual machine hosted by GitHub, not on your computer. Files stay in the codespace until it is deleted. Code has full internet access, and the codespace holds a GitHub token for its repository, so commands can act on that repository as you. Running time counts against your Codespaces quota.'
      };

    case 'jupyterhub': {
      const account = context.hubUser
        ? `, as the hub user ${context.hubUser}`
        : '';

      return {
        label: `JupyterHub${where}`,
        description: `On a JupyterHub server${account}, not on your computer. Files go to your storage on that hub, which usually persists between sessions and may hold your other work. Network access is whatever the hub's operator allows, and can include the organisation's internal network.`
      };
    }
  }

  if (context.container) {
    return {
      label: `A container${where}`,
      description:
        "In a container on the computer JupyterLab was started on. Commands and code see the container's files and any folders shared into it, not the whole computer. Network access is whatever the container was given, which is usually the same as the computer's. Whether files outlive the container depends on how it was started."
    };
  }

  const account = context.user ? `, as the user ${context.user}` : '';

  return {
    label: `The computer running JupyterLab${where}`,
    description: `Directly on the computer JupyterLab was started on${account}. Commands and code have the same access as that account: all of its files, not only the workshop folder, its saved credentials, and every network the computer can reach, including private ones. Anything they change outside the workshop folder stays changed.`
  };
}

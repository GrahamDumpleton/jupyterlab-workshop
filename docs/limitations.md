# Known limitations

A record of the setups and features the extension is known not to
handle, or not to handle fully, so that nobody has to rediscover them.
Each entry says what the limit is, why it exists, and what would change
it. None of these is a promise of work: the ones marked as waiting for
a request are investigated when someone comes forward wanting to
operate that way, and either the documentation grows to say how, or the
extension changes.

## Remote kernels: Kernel Gateway and Enterprise Gateway

**Status: not supported; waiting for a request.**

When JupyterLab launches its kernels through
[Jupyter Kernel Gateway](https://jupyter-kernel-gateway.readthedocs.io/)
or [Enterprise Gateway](https://jupyter-enterprise-gateway.readthedocs.io/),
the kernel runs on another host while the Jupyter Server, and with it
this extension's server side, stays where JupyterLab was started. The
extension assumes that everything a workshop touches is on one machine,
and its actions are split across the two:

- **On the Jupyter Server host:** the file actions and file checks,
  which use the contents API; terminals, which the server spawns, along
  with the terminal-output triggers and the `_workshop/` environment
  files; script verifies, checkpoints, fetching and the
  `environment-create` action, which all run through the server
  extension.

- **On the gateway host:** `kernel-execute` and notebook cells, as
  intended; but also `execute-capture` and the `shell` verify
  substrate, which run their command as a subprocess inside the hidden
  workshop kernel, and every kernel check.

A workshop that mixes the two is working against two filesystems. A
terminal `git init` happens on the server host, and a following
`execute-capture` or kernel check that looks for the repository runs on
the gateway host and does not find it. The working directory passed to
the kernel is the server's own absolute root, so even a shared
filesystem helps only when it is mounted at the same path on both
hosts. A virtual environment created by `environment-create` lives on
the server host, but the kernelspec it registers would be launched by
the gateway, which does not have it. Variables reach the kernel through
the code the extension sends rather than the process environment, so
those alone are unaffected.

Nothing detects the split: the platform information comes from the
server extension and describes the server host, and there is no
warning when the kernel's host or working directory differ.

What would change it: routing `execute-capture` and the shell verify
through a server endpoint so that shell work lands beside terminals
and files, keeping the kernel route for JupyterLite only; a preflight
comparison of the kernel's host and working directory with the
server's, with a banner when they differ; and guidance on which check
substrates to use in that mode. This has not been tried against a real
gateway. If you run one and want workshops on it, open an issue
describing the setup and which actions you need; the architecture will
be looked at properly then, and the documentation or the extension
changed to suit.

## Other single-host assumptions

The same assumption holds for any arrangement where the Jupyter
Server, its terminals and its kernels do not share one filesystem and
one process environment, such as kernels in separate containers
started by a custom kernel provisioner. The remote kernel entry above
applies to those too.

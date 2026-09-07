# Testing

Tests are split by layer so that as much logic as possible is covered by
fast unit tests, with browser tests reserved for the glue between the
extension and JupyterLab.

## Where the tests are

- `packages/core/src/**/__tests__/*.spec.ts` are Jest unit tests for the
  pure TypeScript core: page and directive parsing, front matter, manifest
  validation and variable substitution. New parsing or lint behaviour goes
  here first; the core package has no JupyterLab dependencies, so these
  tests need no browser and run in a second or two.

- `tests/python/` holds the pytest suite for the Python package: the
  server extension handlers, platform detection, fetching, checks,
  collections, catalogs, events, environments, the bridge, the MCP server (through
  an in-memory client) and the CLI. It uses `pytest-jupyter`
  to start a real Jupyter Server in a temporary directory and talks to
  the handlers over HTTP with the `jp_fetch` fixture. Anything that
  needs a remote (archives, collections, event sinks) is served by a
  local `ThreadingHTTPServer` started inside the test.

- `tests/ui-tests/` holds Galata (Playwright) tests that start a real
  JupyterLab with the built extension, upload an example workshop into the
  test server's root directory and drive the panel and its actions in a
  browser. The author mode test drives the editing commands with explicit
  arguments (`draft`, `title`) so no dialog needs answering.

- `examples/` are the workshops used as fixtures by the UI tests. Keep
  them working; they are also the demo.

## Running the tests

- `just test` runs the Jest and pytest suites. Extra arguments pass
  through to pytest: `just test tests/python/test_platform.py` or
  `just test -k windows`.

- `just test-core` and `just test-python` run one suite. Jest arguments
  pass through `just test-core`, for example `just test-core --watch`.

- `just test-ui` installs the UI test dependencies (the first run also
  needs `uv run jlpm playwright install chromium` from `tests/ui-tests`)
  and runs the Galata tests. Build the extension first with `just build`;
  the tests use whatever is linked into JupyterLab. The test server runs
  on port 8890 so it never collides with a JupyterLab started by
  `just lab`; set `JUPYTER_PORT` to change it.

- `just selftest [dir...]` runs `jupyter workshop test` on the three
  example workshops (or the directories given): a real JupyterLab driven by
  Playwright runs every action, check, quiz and form in order. It needs
  `uv run playwright install chromium` once. CI runs it after the Galata
  tests. The Python tests for the CLI itself live in
  `tests/python/test_cli.py`; the ones that need the Node bundle skip
  unless `just build` has run.

- `just selftest-lite [dir...]` runs `jupyter workshop test --lite` on
  `hello-jupyterlab` (or the directories given): it builds a static
  JupyterLite site with the workshop and the linked extension, serves it
  under a sub-path and drives it the same way. The build needs `node`,
  `npm` and `micromamba` on the path for the terminal, and the browser
  loads Pyodide from a CDN, so it needs network access. The site builder
  itself is unit tested in `tests/python/test_lite.py` with a fake build
  runner; the tests needing the `lite` extra skip when it is missing.

## Conventions

- Test against real things. The Python tests start a real server and
  create real files in `tmp_path`; the UI tests use a real JupyterLab.
  Do not use `unittest.mock`. Where a function depends on the
  environment, give it the dependency as an explicit parameter (as
  `detect_platform` does) so tests can pass values in rather than patch.

- Keep browser tests few and broad. A Galata test should walk through a
  realistic slice of a workshop rather than assert one detail, because
  each test pays for a JupyterLab start.

- Settings for a browser test go through Galata's `mockSettings` (see
  `browser.spec.ts`), and files it needs at a fixed path under the test
  server's root, such as a collection index, a catalog or a workshop
  archive the server fetches from its own `files/`, are uploaded in `beforeEach`
  and removed in `afterEach` so runs do not interfere.

- Opening a workshop shows the trust dialog, so a browser test must not
  await the `workshop:open` command; fire it, answer the dialog, and wait
  for the panel title to appear, as the `openWorkshop` helper in the
  existing specs does. Choose "Restricted" or "Ask each time" to test the
  degraded behaviour.

- When adding a directive, option or action, add a core unit test for the
  parsing, and extend the example workshop and the UI test if the action
  touches JupyterLab.

- Python tests use plain functions with type hints and descriptive names
  that read as sentences, for example
  `test_configured_shell_command_wins_over_environment`.

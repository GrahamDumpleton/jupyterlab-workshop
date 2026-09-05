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
  server extension handlers and platform detection. It uses
  `pytest-jupyter` to start a real Jupyter Server in a temporary directory
  and talks to the handlers over HTTP with the `jp_fetch` fixture.

- `tests/ui-tests/` holds Galata (Playwright) tests that start a real
  JupyterLab with the built extension, upload an example workshop into the
  test server's root directory and drive the panel and its actions in a
  browser.

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
  the tests use whatever is linked into JupyterLab.

## Conventions

- Test against real things. The Python tests start a real server and
  create real files in `tmp_path`; the UI tests use a real JupyterLab.
  Do not use `unittest.mock`. Where a function depends on the
  environment, give it the dependency as an explicit parameter (as
  `detect_platform` does) so tests can pass values in rather than patch.

- Keep browser tests few and broad. A Galata test should walk through a
  realistic slice of a workshop rather than assert one detail, because
  each test pays for a JupyterLab start.

- When adding a directive, option or action, add a core unit test for the
  parsing, and extend the example workshop and the UI test if the action
  touches JupyterLab.

- Python tests use plain functions with type hints and descriptive names
  that read as sentences, for example
  `test_configured_shell_command_wins_over_environment`.

# Development tasks for jupyterlab-workshop.
#
# Python is managed with uv, JavaScript with jlpm (the Yarn that ships with
# JupyterLab, installed into the project environment). Run `just --list`
# to see the available targets.

set positional-arguments

# List the available targets.
default:
    @just --list

# Set up the development environment and link the extension into JupyterLab.
install:
    uv sync --no-install-project
    uv run --no-sync jlpm install
    uv run --no-sync jlpm build
    uv sync
    uv run jupyter labextension develop . --overwrite
    uv run jupyter server extension enable jupyterlab_workshop

# Build the TypeScript packages and the labextension bundle.
build:
    uv run jlpm build

# Rebuild the TypeScript packages and labextension on change (run alongside `just lab`).
watch:
    uv run jlpm watch

# Start JupyterLab from the repository root with the extension loaded.
lab *args:
    uv run jupyter lab --notebook-dir=. "$@"

# Run the fast test suites: Jest for packages/core and pytest for the Python package.
test *args:
    uv run jlpm test
    uv run pytest "$@"

# Run only the Jest tests for packages/core.
test-core *args:
    uv run jlpm test "$@"

# Run only the pytest suite for the Python package.
test-python *args:
    uv run pytest "$@"

# Run the Galata browser tests against a real JupyterLab on port 8890 (slow).
test-ui *args:
    cd tests/ui-tests && uv run jlpm install && JUPYTER_PORT=8890 uv run jlpm playwright test "$@"

# Check TypeScript with eslint and prettier, and Python with ruff.
lint:
    uv run jlpm lint:check
    uv run ruff check .
    uv run ruff format --check .

# Reformat and apply auto-fixes for TypeScript and Python.
format:
    uv run jlpm lint
    uv run ruff check --fix .
    uv run ruff format .

# Type check the TypeScript packages with tsc and the Python package with mypy.
typecheck:
    uv run jlpm typecheck
    uv run mypy

# Retake the screenshots in docs/_static from a throwaway JupyterLab (needs the test extra and a Chromium for Playwright).
screenshots:
    uv run python scripts/screenshots.py

# Build the documentation with Sphinx into docs/_build/html (generates the manifest reference first).
docs:
    uv run sphinx-build -W --keep-going -b html docs docs/_build/html

# Serve the documentation with live reload.
docs-serve:
    uv run sphinx-autobuild docs docs/_build/html

# Clear generated documentation outputs.
docs-clean:
    rm -rf docs/_build docs/reference

# Assemble the GitHub Pages site into site/: landing page, JSON schemas and the JupyterLite demo.
pages *args:
    rm -rf site
    mkdir -p site/schemas/v1alpha1
    cp github-pages/index.html site/index.html
    touch site/.nojekyll
    cp packages/core/src/schema/workshop.schema.json packages/core/src/schema/registry.schema.json site/schemas/v1alpha1/
    uv run jupyter workshop lite examples/hello-jupyterlab --out site/demo "$@"

# Self-test a workshop directory in a real JupyterLab (default: every example).
selftest *args:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "$#" -eq 0 ]; then set -- examples/git-basics examples/hello-jupyterlab examples/workshop-authoring; fi
    for dir in "$@"; do uv run jupyter workshop test "$dir"; done

# Self-test a workshop in a static JupyterLite build (default: hello-jupyterlab).
selftest-lite *args:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "$#" -eq 0 ]; then set -- examples/hello-jupyterlab; fi
    for dir in "$@"; do uv run jupyter workshop test "$dir" --lite; done

# Build a JupyterLite site with the example workshop into lite-site/ and serve it.
lite *args:
    uv run jupyter workshop lite examples/hello-jupyterlab --out lite-site --serve "$@"

# Remove build outputs (compiled TypeScript, the labextension bundle, lint caches).
clean:
    uv run jlpm clean
    uv run jlpm clean:lintcache

# Remove what running the example workshops leaves behind (_workshop state, scratch and demo directories).
clean-examples:
    rm -rf examples/*/_workshop examples/*/scratch examples/*/demo

# Return to a fresh checkout: also removes node_modules, .venv, caches, built docs and sites.
distclean: clean-examples
    rm -rf packages/core/lib packages/labextension/lib packages/*/tsconfig.tsbuildinfo
    rm -rf jupyterlab_workshop/labextension jupyterlab_workshop/nodejs jupyterlab_workshop/schema
    rm -rf .eslintcache .stylelintcache packages/core/coverage
    rm -rf node_modules packages/*/node_modules tests/ui-tests/node_modules .venv
    rm -rf site docs/_build docs/reference build dist lite-site .jupyterlite.doit.db .coverage htmlcov
    rm -rf tests/ui-tests/test-results tests/ui-tests/playwright-report
    rm -rf workshops
    find . -type d \( -name __pycache__ -o -name .ipynb_checkpoints -o -name '*.egg-info' -o -name .yarn -o -name .mypy_cache -o -name .ruff_cache -o -name .pytest_cache \) -prune -exec rm -rf {} +

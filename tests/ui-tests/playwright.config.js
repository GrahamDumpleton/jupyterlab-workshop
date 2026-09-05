/**
 * Configuration for Playwright using default from @jupyterlab/galata.
 *
 * Set JUPYTER_PORT to run the test server on a port other than 8888, for
 * example when a development JupyterLab is already running there.
 */
const port = process.env.JUPYTER_PORT ?? '8888';

process.env.TARGET_URL = process.env.TARGET_URL ?? `http://localhost:${port}`;

const baseConfig = require('@jupyterlab/galata/lib/playwright-config');

module.exports = {
  ...baseConfig,
  webServer: {
    command: `jupyter lab --config jupyter_server_test_config.py --port ${port}`,
    url: `http://localhost:${port}/lab`,
    timeout: 120 * 1000,
    reuseExistingServer: !process.env.CI
  }
};

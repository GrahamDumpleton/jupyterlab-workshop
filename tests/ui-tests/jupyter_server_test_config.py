"""Server configuration for integration tests.

!! Never use this configuration in production because it
opens the server to the world and provide access to JupyterLab
JavaScript objects through the global window variable.
"""

import os

from jupyterlab.galata import configure_jupyter_server

configure_jupyter_server(c)  # noqa: F821

# Workshop Author talks to an agent that answers by rule, so no test ever
# reaches a real model, whatever credentials the machine has.
os.environ["JUPYTERLAB_WORKSHOP_AGENT_PROVIDER"] = "fake"

# Uncomment to set server log level to debug level
# c.ServerApp.log_level = "DEBUG"

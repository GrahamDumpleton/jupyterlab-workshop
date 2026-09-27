# The jupyterlab-workshop container image: JupyterLab with the extension,
# ready to run a collection or catalog of workshops named when the
# container starts, and the base for images that carry their workshops
# with them. See "A container image" in docs/deploying.md.
#
# It is built on the Jupyter docker-stacks base-notebook image, which
# brings the jovyan user, the NB_UID and NB_GID remapping of start.sh,
# tini, the before-notebook.d hooks, and an image a JupyterHub can spawn.
# The extension is installed from the wheel in dist/, so the image holds
# exactly what was built and tested: build the wheel first with `uv build`
# or take it from the release artifacts. `just container` does both.
#
#   docker build -f container/Dockerfile -t jupyterlab-workshop .
#   docker run --rm -p 8888:8888 \
#       -e WORKSHOP_COLLECTION=https://example.org/collection.json \
#       -e WORKSHOP_INSTALL=1 jupyterlab-workshop

ARG BASE_IMAGE=quay.io/jupyter/base-notebook:latest
FROM ${BASE_IMAGE}

USER root

# git is not in base-notebook, and workshops that teach it, such as the
# git-basics example, need it in the terminal. Nothing else is added: a
# workshop with requirements of its own gets an isolated environment
# built with venv and pip when it is opened.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# The seeding hook and the launch command. Hooks in before-notebook.d
# run before whatever command the container starts with, under
# JupyterHub too, so workshops staged in the image reach the home
# directory either way. The staging tree is laid out as the home
# directory is, with the workshops directory and the collection index
# beside it, and is writable by the notebook user so a derived image
# can install into it.
COPY container/seed-workshops.sh /usr/local/bin/before-notebook.d/20-seed-workshops.sh
COPY container/workshop-launch /usr/local/bin/workshop-launch
ENV WORKSHOP_STAGING=/opt/workshops
RUN chmod 0755 /usr/local/bin/workshop-launch \
        /usr/local/bin/before-notebook.d/20-seed-workshops.sh \
    && mkdir -p "${WORKSHOP_STAGING}" \
    && fix-permissions "${WORKSHOP_STAGING}"

USER ${NB_UID}

COPY --chown=${NB_UID}:${NB_GID} dist/*.whl /tmp/dist/
RUN pip install --no-cache-dir /tmp/dist/jupyterlab_workshop-*.whl \
    && rm -rf /tmp/dist \
    && fix-permissions "${CONDA_DIR}" \
    && fix-permissions "/home/${NB_USER}"

# The image's own settings: start in the workshop browser, with the
# workshops directory under the home directory, and the Jupyter news
# prompt off. A launch merges its own settings over these.
COPY --chown=${NB_UID}:${NB_GID} container/overrides.json \
    ${CONDA_DIR}/share/jupyter/lab/settings/overrides.json

WORKDIR "${HOME}"

CMD ["workshop-launch"]

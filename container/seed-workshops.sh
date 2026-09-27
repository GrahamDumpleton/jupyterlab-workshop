#!/bin/bash
# Seed the home directory with the workshops staged in the image.
#
# A derived image installs its workshops into the staging tree, outside
# the home directory, because the home directory is where a volume is
# mounted for the learner's files, and a mounted volume hides whatever
# the image put there. This hook runs before the server starts, under
# JupyterHub as well, and copies into the home directory each staged
# workshop that is not there yet, and each file beside the workshops
# directory, such as the collection index. Anything already there is
# left alone, so a returning learner keeps their work and their
# progress, and a newer image only adds. When the container was started
# as root, the copies are given to the notebook user.
#
# This file is sourced by run-hooks.sh, so it must neither exit nor set
# shell options.

seed_workshops() {
    local staging="${WORKSHOP_STAGING:-/opt/workshops}"
    local directory="${WORKSHOP_DIRECTORY:-workshops}"
    local entry workshop name

    if [ ! -d "${staging}" ]; then
        return 0
    fi

    for entry in "${staging}"/*; do
        if [ ! -e "${entry}" ]; then
            continue
        fi

        name="$(basename "${entry}")"

        if [ "${name}" = "${directory}" ]; then
            seed_directory "${HOME}/${directory}"

            for workshop in "${entry}"/*/; do
                if [ ! -d "${workshop}" ]; then
                    continue
                fi

                name="$(basename "${workshop}")"

                if [ ! -e "${HOME}/${directory}/${name}" ]; then
                    seed_copy "${workshop}" "${HOME}/${directory}/${name}"
                fi
            done
        elif [ ! -e "${HOME}/${name}" ]; then
            seed_copy "${entry}" "${HOME}/${name}"
        fi
    done
}

seed_directory() {
    if [ -d "$1" ]; then
        return 0
    fi

    mkdir -p "$1"

    if [ "$(id -u)" = "0" ]; then
        chown "${NB_UID:-1000}:${NB_GID:-100}" "$1"
    fi
}

seed_copy() {
    cp -a "$1" "$2"

    if [ "$(id -u)" = "0" ]; then
        chown -R "${NB_UID:-1000}:${NB_GID:-100}" "$2"
    fi

    echo "Seeded $2 from the image"
}

seed_workshops
unset -f seed_workshops seed_directory seed_copy

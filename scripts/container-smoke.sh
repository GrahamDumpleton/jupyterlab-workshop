#!/usr/bin/env bash
# Start the container image with a collection and check it over HTTP:
# the server answers with the token, the platform reports a container,
# the collection's workshops were installed and are listed, the image's
# settings are the defaults, and a kernel executes code. Needs Docker
# and the network, for the collection. Used by `just container-test`
# and the image job in CI.
#
#   scripts/container-smoke.sh [IMAGE] [COLLECTION]

set -euo pipefail

image="${1:-jupyterlab-workshop:dev}"
collection="${2:-https://raw.githubusercontent.com/GrahamDumpleton/jupyterlab-workshop-showcase/main/collection.json}"
port="${CONTAINER_TEST_PORT:-8899}"
token="smoke-$(date +%s)"
name="jupyterlab-workshop-smoke-$$"
base="http://127.0.0.1:${port}"
failed=1

cleanup() {
    if [ "${failed}" = "1" ]; then
        echo "== container log"
        docker logs "${name}" 2>&1 | tail -60 || true
    fi

    docker rm -f "${name}" > /dev/null 2>&1 || true
}

trap cleanup EXIT

api() {
    curl -sS -H "Authorization: token ${token}" "${base}$1"
}

echo "== starting ${image} with ${collection}"
docker run -d --name "${name}" -p "${port}:8888" \
    -e "JUPYTER_TOKEN=${token}" \
    -e "WORKSHOP_COLLECTION=${collection}" \
    -e "WORKSHOP_INSTALL=1" \
    "${image}" > /dev/null

# Installing the collection happens before the server starts, so allow
# for the downloads as well as the start.
for _ in $(seq 1 180); do
    if curl -sf -H "Authorization: token ${token}" "${base}/api/status" > /dev/null; then
        break
    fi

    if [ -z "$(docker ps -q -f "name=${name}")" ]; then
        echo "the container exited before the server answered" >&2
        exit 1
    fi

    sleep 1
done

echo "== server status"
api /api/status | python3 -c 'import json, sys; json.load(sys.stdin); print("ok")'

echo "== launch link"
docker logs "${name}" 2>&1 | grep -F "/lab?token=${token}" | head -1

echo "== platform"
api /jupyterlab-workshop/platform | python3 -c '
import json, sys
info = json.load(sys.stdin)
assert info["container"] is True, info
assert info["os"] == "linux", info
print("container:", info["container"], "version:", info["frontend_version"])
'

echo "== installed workshops"
api "/jupyterlab-workshop/workshops?directory=workshops" | python3 -c '
import json, sys
workshops = json.load(sys.stdin)["workshops"]
assert workshops, "no workshops were installed"
for workshop in workshops:
    print(" ", workshop.get("name"), "from", workshop.get("collection"))
'

echo "== settings defaults"
api "/lab/api/settings/@jupyterlab-workshop/labextension:panel" | python3 -c '
import json, sys
properties = json.load(sys.stdin)["schema"]["properties"]
defaults = {key: properties[key].get("default") for key in ("browseOnStart", "workshopsDirectory")}
assert defaults == {"browseOnStart": True, "workshopsDirectory": "workshops"}, defaults
print(" ", defaults)
'

echo "== kernel"
docker exec "${name}" python -c '
from jupyter_client.manager import run_kernel
with run_kernel(kernel_name="python3") as client:
    client.execute("print(6 * 7)")
    for _ in range(50):
        message = client.get_iopub_msg(timeout=30)
        if message["msg_type"] == "stream":
            text = message["content"]["text"].strip()
            assert text == "42", text
            print("  executed:", text)
            break
    else:
        raise SystemExit("no output from the kernel")
' 2> /dev/null

failed=0
echo "== passed"

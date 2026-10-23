#!/bin/sh
# bare: Docker installed and running, nothing on 80, 443, 8443, 8480, 8481 (case 1). As root, on a
# DOCKER=1 test server.
set -eu
systemctl is-active --quiet docker || systemctl start docker
docker info >/dev/null

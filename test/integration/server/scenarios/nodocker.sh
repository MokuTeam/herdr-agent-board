#!/bin/sh
# nodocker: no Docker, nothing on the ports (case 1 with Docker's install). As root, on a DOCKER=0
# test server.
set -eu
if command -v docker >/dev/null 2>&1; then
  echo 'nodocker needs a server built with DOCKER=0' >&2
  exit 1
fi

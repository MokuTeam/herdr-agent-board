#!/bin/sh
# caddy-bridge: the official Caddy image started by `docker run` on Docker's default bridge only,
# publishing 80 and 443, its Caddyfile in a single-file bind mount (3c: "Do it myself"). As root, on
# a DOCKER=1 test server; THEIR_CADDY (default caddy:2) is pulled when missing.
set -eu
image=${THEIR_CADDY:-caddy:2}
docker image inspect "$image" >/dev/null 2>&1 || docker pull -q "$image" >/dev/null
install -d -m 755 /srv/bridge
# Their certificates: their own sites' from Caddy's local CA. With THEIR_ACME (the integration
# tests' Pebble) any other site, the board's once added, gets its certificate from that CA, whose
# HTTPS root is THEIR_ACME_ROOT; else from the local CA too, as their sites'.
if [ -n "${THEIR_ACME:-}" ]; then
  global="	acme_ca $THEIR_ACME
	acme_ca_root $THEIR_ACME_ROOT"
  tls='	tls internal
'
else
  global='	local_certs'
  tls=''
fi
cat > /srv/bridge/Caddyfile <<EOF
{
$global
	skip_install_trust
}

a.example.com {
${tls}	respond "site a"
}

b.example.com {
${tls}	respond "site b"
}
EOF
docker run -d --name their-caddy --restart unless-stopped -p 80:80 -p 443:443 \
  -v /srv/bridge/Caddyfile:/etc/caddy/Caddyfile ${THEIR_ACME:+-v /opt/pebble:/opt/pebble:ro} "$image" >/dev/null
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  docker exec their-caddy caddy version >/dev/null 2>&1 && exit 0
  sleep 1
done
echo 'their caddy did not start' >&2
exit 1

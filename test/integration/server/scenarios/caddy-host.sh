#!/bin/sh
# caddy-host: the official Caddy image in compose with network_mode: host, its Caddyfile in a
# single-file bind mount (case 3b). As root, on a DOCKER=1 test server; THEIR_CADDY (default
# caddy:2) is pulled when missing.
set -eu
image=${THEIR_CADDY:-caddy:2}
docker image inspect "$image" >/dev/null 2>&1 || docker pull -q "$image" >/dev/null
install -d -m 755 '/srv/my web'
cd '/srv/my web'
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
mount=''
[ -z "${THEIR_ACME:-}" ] || mount='      - /opt/pebble:/opt/pebble:ro'
cat > Caddyfile <<EOF
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
cat > compose.yaml <<EOF
name: web
services:
  caddy:
    image: $image
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
      - caddy_config:/config
$mount
volumes:
  caddy_data:
  caddy_config:
EOF
docker compose up -d --quiet-pull
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  ss -H -ltn 'sport = :443' | grep -q . && exit 0
  sleep 1
done
echo 'their caddy does not listen on 443' >&2
exit 1

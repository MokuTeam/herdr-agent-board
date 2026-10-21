#!/bin/sh
# caddy-unit: Caddy from the distribution's package as a systemd unit, two sites (case 2). As root,
# on a DOCKER=1 test server. local_certs: their Caddy never asks a public CA in tests.
set -eu
export DEBIAN_FRONTEND=noninteractive
# a mirror can answer 502 now and then: apt tries again, three times
apt_get() { for _ in 1 2 3; do apt-get "$@" && return 0; sleep 3; done; return 1; }
apt_get update -qq
apt_get install -y -qq --no-install-recommends caddy >/dev/null
cat > /etc/caddy/Caddyfile <<'EOF'
{
	local_certs
	skip_install_trust
}

a.example.com {
	respond "site a"
}

b.example.com {
	respond "site b"
}
EOF
systemctl restart caddy
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  ss -H -ltn 'sport = :443' | grep -q . && exit 0
  sleep 1
done
echo 'caddy does not listen on 443' >&2
exit 1

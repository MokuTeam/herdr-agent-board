#!/bin/sh
# dummy80: a program that is not Caddy holds 80, 443 is free (case 1b): `python3 -m http.server 80`
# as a systemd unit. As root, on a DOCKER=1 test server.
set -eu
export DEBIAN_FRONTEND=noninteractive
# a mirror can answer 502 now and then: apt tries again, three times
apt_get() { for _ in 1 2 3; do apt-get "$@" && return 0; sleep 3; done; return 1; }
if ! command -v python3 >/dev/null 2>&1; then
  apt_get update -qq
  apt_get install -y -qq --no-install-recommends python3 >/dev/null
fi
install -d -m 755 /srv/dummy80
echo 'dummy80' > /srv/dummy80/index.html
cat > /etc/systemd/system/dummy80.service <<'EOF'
[Unit]
Description=A program on port 80 that is not Caddy

[Service]
WorkingDirectory=/srv/dummy80
ExecStart=/usr/bin/python3 -m http.server 80

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --quiet --now dummy80.service
for _ in 1 2 3 4 5 6 7 8 9 10; do
  ss -H -ltn 'sport = :80' | grep -q . && exit 0
  sleep 1
done
echo 'dummy80 does not listen on 80' >&2
exit 1

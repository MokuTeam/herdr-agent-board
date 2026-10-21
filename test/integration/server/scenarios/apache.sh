#!/bin/sh
# apache: Apache from the distribution's package on 80 and 443 (4c: "Do it myself"). As root, on a
# DOCKER=1 test server.
set -eu
export DEBIAN_FRONTEND=noninteractive
# a mirror can answer 502 now and then: apt tries again, three times
apt_get() { for _ in 1 2 3; do apt-get "$@" && return 0; sleep 3; done; return 1; }
apt_get update -qq
apt_get install -y -qq --no-install-recommends apache2 ssl-cert >/dev/null
a2enmod -q ssl >/dev/null
a2ensite -q default-ssl >/dev/null
systemctl restart apache2
ss -H -ltn 'sport = :443' | grep -q .
ss -H -ltn 'sport = :80' | grep -q .

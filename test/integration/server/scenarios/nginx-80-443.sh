#!/bin/sh
# nginx-80-443: nginx from the distribution's package on 80 and 443, its conf.d included in http {}
# as the package ships it, the default site on 80 kept (case 4b). As root, on a DOCKER=1 test server.
set -eu
export DEBIAN_FRONTEND=noninteractive
# a mirror can answer 502 now and then: apt tries again, three times
apt_get() { for _ in 1 2 3; do apt-get "$@" && return 0; sleep 3; done; return 1; }
apt_get update -qq
apt_get install -y -qq --no-install-recommends nginx ssl-cert >/dev/null
cat > /etc/nginx/conf.d/site.conf <<'EOF'
server {
    listen 80;
    listen [::]:80;
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name site.example.com;
    ssl_certificate /etc/ssl/certs/ssl-cert-snakeoil.pem;
    ssl_certificate_key /etc/ssl/private/ssl-cert-snakeoil.key;
    location / {
        return 200 "site\n";
    }
}
EOF
nginx -t 2>/dev/null
systemctl restart nginx
ss -H -ltn 'sport = :443' | grep -q .
ss -H -ltn 'sport = :80' | grep -q .

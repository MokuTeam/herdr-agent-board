#!/bin/sh
# compose-folder: the official Caddy image in compose (project "web", folder "/srv/my web") on the
# user network web_default, its Caddyfile in a folder bind mount (case 3a). As root, on a DOCKER=1
# test server; THEIR_CADDY (default caddy:2) is pulled when the server does not have it.
set -eu
image=${THEIR_CADDY:-caddy:2}
docker image inspect "$image" >/dev/null 2>&1 || docker pull -q "$image" >/dev/null
install -d -m 755 '/srv/my web'
cd '/srv/my web'
cat > Caddyfile <<'EOF'
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
cat > compose.yaml <<EOF
name: web
services:
  caddy:
    image: $image
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./:/etc/caddy
      - caddy_data:/data
      - caddy_config:/config
volumes:
  caddy_data:
  caddy_config:
EOF
docker compose up -d --quiet-pull
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  docker exec web-caddy-1 caddy version >/dev/null 2>&1 && exit 0
  sleep 1
done
echo 'their caddy did not start' >&2
exit 1

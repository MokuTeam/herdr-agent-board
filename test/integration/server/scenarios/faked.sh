#!/bin/sh
# faked: a bare server (Docker, nothing on the ports) that Look reads as one the board leaves to "Do
# it myself", faked where Look reads it. FAKE=podman: Docker's command is Podman's emulation (its
# --version lines); FAKE=rootless: Docker's daemon runs rootless (its security options); FAKE=selinux:
# SELinux enforcing (getenforce). The fakes sit in /usr/local, ahead of the real programs on root's
# PATH; anything they do not fake goes to the real docker. As root, on a DOCKER=1 test server.
set -eu
case "${FAKE:?}" in
podman | rootless)
  cat > /usr/local/bin/docker <<EOF
#!/bin/sh
fake=$FAKE
EOF
  cat >> /usr/local/bin/docker <<'EOF'
if [ "$fake" = podman ] && [ "$*" = --version ]; then
  echo 'Emulate Docker CLI using podman. Create /etc/containers/nodocker to quiet msg.'
  echo 'podman version 5.4.2'
  exit 0
fi
if [ "$fake" = podman ] && [ "$1" = version ]; then echo 5.4.2; exit 0; fi
if [ "$fake" = rootless ] && [ "$1" = info ]; then
  echo '["name=seccomp,profile=builtin","name=rootless","name=cgroupns"]'
  exit 0
fi
exec /usr/bin/docker "$@"
EOF
  chmod 755 /usr/local/bin/docker
  ;;
selinux)
  printf '#!/bin/sh\necho Enforcing\n' > /usr/local/sbin/getenforce
  chmod 755 /usr/local/sbin/getenforce
  ;;
*)
  echo "faked: no fake named $FAKE" >&2
  exit 1
  ;;
esac

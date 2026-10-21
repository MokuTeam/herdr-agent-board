# A test server for the server setup: Ubuntu 26.04 (sudo-rs, Rust coreutils: the defaults), systemd as PID 1,
# sshd, and with DOCKER=1 Docker CE from Docker's own repository (Docker in Docker).
#
#   docker build -f ubuntu2604.Dockerfile --build-arg DOCKER=1 --build-arg PUBKEY="$(cat key.pub)" -t <tag> .
#   docker run -d --privileged --cgroupns=host -v /var/lib/docker -v /var/lib/containerd \
#       -p 127.0.0.1:2226:22 <tag>
#
# Users: admin (sudo with the password admin-pw), nopw (sudo without a password), root; each takes
# PUBKEY. Never anything but a throwaway container on this PC.
FROM ubuntu:26.04

ARG DOCKER=1
ENV container=docker LANG=C.UTF-8

# apt tries again when a mirror answers 502 (the PC's network can be flaky)
RUN echo 'Acquire::Retries "5";' > /etc/apt/apt.conf.d/80-retries \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus openssh-server sudo sudo-rs curl ca-certificates iproute2 procps \
 && rm -rf /var/lib/apt/lists/* \
 && sudo --version | grep -q '^sudo-rs ' && ls --version | grep -q uutils

# Docker CE, by the steps Docker documents (the board's own install is checked on a DOCKER=0 image)
RUN if [ "$DOCKER" = 1 ]; then \
      install -m 0755 -d /etc/apt/keyrings \
   && curl -fsSL "https://download.docker.com/linux/$(. /etc/os-release && echo "$ID")/gpg" -o /etc/apt/keyrings/docker.asc \
   && chmod a+r /etc/apt/keyrings/docker.asc \
   && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$(. /etc/os-release && echo "$ID") $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
        > /etc/apt/sources.list.d/docker.list \
   && apt-get update \
   && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        docker-ce docker-ce-cli containerd.io docker-compose-plugin \
   && rm -rf /var/lib/apt/lists/*; \
    fi

RUN useradd -m -s /bin/bash admin && echo 'admin:admin-pw' | chpasswd && usermod -aG sudo admin \
 && useradd -m -s /bin/bash nopw && usermod -p '*' nopw \
 && echo 'nopw ALL=(ALL:ALL) NOPASSWD: ALL' > /etc/sudoers.d/nopw && chmod 440 /etc/sudoers.d/nopw \
 && systemctl mask getty@tty1.service console-getty.service systemd-firstboot.service \
      systemd-modules-load.service \
 && systemctl enable ssh.socket \
 && rm -f /usr/sbin/policy-rc.d
# (the base image's policy-rc.d keeps services from starting when installed; a server has none)

ARG PUBKEY=""
RUN for home in /root /home/admin /home/nopw; do \
      install -d -m 700 "$home/.ssh" && printf '%s\n' "$PUBKEY" > "$home/.ssh/authorized_keys" \
   && chmod 600 "$home/.ssh/authorized_keys" && chown -R "$(stat -c %U "$home"):" "$home/.ssh"; \
    done

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]

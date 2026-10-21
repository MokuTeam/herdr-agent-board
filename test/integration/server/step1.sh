#!/bin/sh
# Step 1 of "On the server", as the panel's one paste does it, for the defaults (tunnel user
# boardtunnel, socket /var/lib/boardtunnel/board.sock). Run as root on a test server:
#   sh step1.sh '<the tunnel's public key>'
# Safe to run twice. Never anything but a throwaway container on this PC.
set -eu
key=$1
( set -e
id -u boardtunnel >/dev/null 2>&1 || sudo useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin boardtunnel
sudo usermod -p '*' boardtunnel
[ -d /var/lib/boardtunnel ] || sudo install -d -m 2750 -o boardtunnel -g boardtunnel /var/lib/boardtunnel
sudo install -d -m 755 /etc/ssh/authorized_keys
echo "restrict,port-forwarding $key" | sudo tee /etc/ssh/authorized_keys/boardtunnel >/dev/null
grep -qx 'Match User boardtunnel' /etc/ssh/sshd_config || printf '\n%s\n' 'Match User boardtunnel
    AuthorizedKeysFile /etc/ssh/authorized_keys/boardtunnel
    AuthenticationMethods publickey
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AllowTcpForwarding remote
    PermitListen none
    AllowStreamLocalForwarding remote
    StreamLocalBindUnlink yes
    StreamLocalBindMask 0117
    X11Forwarding no
    AllowAgentForwarding no
    PermitTunnel no
    PermitTTY no
    ForceCommand /bin/false
    ClientAliveInterval 15
    ClientAliveCountMax 2' | sudo tee -a /etc/ssh/sshd_config >/dev/null
sudo sshd -t
{ sudo systemctl try-reload-or-restart ssh 2>/dev/null || sudo systemctl try-reload-or-restart sshd; }
)

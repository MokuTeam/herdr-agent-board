#!/bin/sh
# agent-board on a server of yours: herdr, Claude Code and the board on this host as a user of
# their own (agent, no sudo), herdr as that user's service started with the server, and the board
# at your domain through the web server, with the board's own login. Debian 12 and 13, Ubuntu
# 22.04 to 26.04. In a root shell on the server (or as a user with sudo):
#
#   curl -fsSL https://raw.githubusercontent.com/MokuTeam/herdr-agent-board/main/server-install.sh | sh -s -- --domain board.example.com
#
#   --domain <name>   the board's address (asked on the terminal when missing); point it at this server
#   --ref <ref>       the board's branch, tag or commit (main); `board update` follows it later
#   --user <name>     the board's user (agent); --sudo gives it sudo
#   --undo            takes it back: herdr's service, the web server's part, sudo
#                     (with --remove-user: the user and its home too, and the packages
#                     it added for the agents' browsers)
#   --repo <url>      a fork's git URL
#
# It looks at the server first and asks once before it changes anything; at the end it prints the
# link that sets the board's login, once. Safe to run again: it then updates what is there.
#
# This script is the bootstrap: it gets what the install needs (curl, git, unzip; Bun and the
# board's code for root's own use, in /usr/local/lib/agent-board) and hands over to the board's own
# install, src/entrypoints/server-install.ts, which the local board's "Install the board on this
# server" runs too (with --archive, the board's code it sent, and --yes: the panel asked).
set -u
if [ "$(id -u)" = 0 ]; then
  r=sh
elif command -v sudo >/dev/null 2>&1; then
  echo 'agent-board: this needs root; it runs itself again with sudo.'
  r='sudo sh'
else
  echo 'agent-board: run this as root (there is no sudo here). Nothing was changed.'
  exit 1
fi
exec $r -s -- "$@" <<'AGENT_BOARD_MAIN'
set -u
umask 022
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
REPO=https://github.com/MokuTeam/herdr-agent-board
# the Bun the board is tried with (core/server-install.ts BUN_VERSION)
BUN_VERSION=1.4.3
# root's own Bun and copy of the board (core/server-install.ts INSTALL_HOME)
HOME_DIR=/usr/local/lib/agent-board
# the systems it installs on (core/server-look.ts SUPPORTED)
SUPPORTED='debian 12|debian 13|ubuntu 22.04|ubuntu 24.04|ubuntu 25.10|ubuntu 26.04'
TRIES=${BOARD_INSTALL_TRIES:-3}

say() { printf 'agent-board: %s\n' "$*"; }

# a command tried again while it fails (the internet fails now and then)
tried() {
  n=0
  until "$@"; do
    n=$((n + 1))
    [ "$n" -lt "$TRIES" ] || return 1
    sleep 2
  done
}

# yes on the terminal; 2: no terminal to ask on
ask() {
  { true >/dev/tty; } 2>/dev/null || return 2
  printf '%s' "$1" >/dev/tty
  a=
  read -r a </dev/tty || return 1
  case $a in y | Y | yes | Yes | YES | д | Д | да | Да | ДА) return 0 ;; *) return 1 ;; esac
}

bun_install() {
  d=$(mktemp -d) || return 1
  if curl -fsSL --retry 3 --retry-all-errors --connect-timeout 20 https://bun.sh/install -o "$d/install" &&
    BUN_INSTALL="$HOME_DIR/bun" SHELL=/bin/sh bash "$d/install" "bun-v$BUN_VERSION" >"$d/log" 2>&1; then
    rm -rf "$d"
    return 0
  fi
  tail -n 5 "$d/log" 2>/dev/null
  rm -rf "$d"
  return 1
}

board_fetch() {
  rm -rf "$HOME_DIR/src.new"
  git init -q "$HOME_DIR/src.new" &&
    git -C "$HOME_DIR/src.new" fetch -q --depth 1 "$repo" "$ref" &&
    git -C "$HOME_DIR/src.new" checkout -q --detach FETCH_HEAD
}

main() {
  ref=main
  repo=$REPO
  archive=
  undo=
  yes=
  prev=
  for a in "$@"; do
    case $prev in
    --ref) ref=$a ;;
    --repo) repo=$a ;;
    --archive) archive=$a ;;
    esac
    case $a in
    --undo) undo=1 ;;
    --yes) yes=1 ;;
    esac
    prev=$a
  done

  # the system: one the board installs on
  id=$(. /etc/os-release 2>/dev/null && echo "${ID:-}")
  ver=$(. /etc/os-release 2>/dev/null && echo "${VERSION_ID:-}")
  case "|$SUPPORTED|" in
  *"|$id $ver|"*) ;;
  *)
    say "the board installs on Debian 12 and 13 and Ubuntu 22.04 to 26.04, not on this server ($id $ver). Nothing was changed."
    exit 1
    ;;
  esac
  if [ ! -d /run/systemd/system ]; then
    say 'the board needs systemd running on this server. Nothing was changed.'
    exit 1
  fi
  case $(uname -m) in
  x86_64 | aarch64) ;;
  *)
    say "the board installs on x86_64 and arm64, not on $(uname -m). Nothing was changed."
    exit 1
    ;;
  esac

  # Undo with the install's own copy there: nothing to fetch
  if [ -n "$undo" ] && [ -x "$HOME_DIR/bun/bin/bun" ] && [ -f "$HOME_DIR/src/src/entrypoints/server-install.ts" ]; then
    "$HOME_DIR/bun/bin/bun" "$HOME_DIR/src/src/entrypoints/server-install.ts" "$@"
    c=$?
    [ "$c" != 0 ] || rm -rf "$HOME_DIR"
    exit "$c"
  fi

  # what the install needs, from the system's own packages: asked first
  need=
  for p in curl git unzip gzip tar; do
    command -v "$p" >/dev/null 2>&1 || need="$need $p"
  done
  [ -s /etc/ssl/certs/ca-certificates.crt ] || need="$need ca-certificates"
  if [ -n "$need" ]; then
    if [ -z "$yes" ]; then
      ask "agent-board: to look at this server, the install needs these packages:$need. Install them? [y/N] "
      case $? in
      0) ;;
      2)
        say 'no terminal to ask on: run this in a terminal on the server (an ssh session). Nothing was changed.'
        exit 1
        ;;
      *)
        say 'Stopped: nothing was changed.'
        exit 1
        ;;
      esac
    fi
    say "installing$need"
    # shellcheck disable=SC2086
    if ! tried sh -c "apt-get update -qq >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends $need >/dev/null"; then
      say "could not install$need with apt-get."
      exit 1
    fi
  fi

  # root's own Bun, at the board's version, and root's own copy of the board
  mkdir -p "$HOME_DIR"
  chmod 755 "$HOME_DIR"
  if [ "$("$HOME_DIR/bun/bin/bun" --version 2>/dev/null)" != "$BUN_VERSION" ]; then
    say "getting Bun $BUN_VERSION for the install ($HOME_DIR)"
    if ! tried bun_install; then
      say "could not get Bun $BUN_VERSION."
      exit 1
    fi
  fi
  if [ -n "$archive" ]; then
    rm -rf "$HOME_DIR/src.new"
    mkdir -p "$HOME_DIR/src.new"
    if ! tar -xzf "$archive" -C "$HOME_DIR/src.new"; then
      say "could not unpack $archive."
      exit 1
    fi
  else
    say "getting the board ($ref) for the install"
    if ! tried board_fetch; then
      say "could not get $ref from $repo."
      exit 1
    fi
  fi
  rm -rf "$HOME_DIR/src"
  mv "$HOME_DIR/src.new" "$HOME_DIR/src"

  "$HOME_DIR/bun/bin/bun" "$HOME_DIR/src/src/entrypoints/server-install.ts" "$@"
  c=$?
  if [ -n "$undo" ] && [ "$c" = 0 ]; then rm -rf "$HOME_DIR"; fi
  exit "$c"
}

main "$@" </dev/null
AGENT_BOARD_MAIN

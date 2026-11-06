#!/bin/sh
# Starts one agent or command: the firewall as root, then the command as the host user with no capabilities.
set -eu

# Fails closed: the command never runs without the firewall.
if [ "${ROLLOUT_FIREWALL:-1}" != 0 ]; then
  /usr/local/bin/init-firewall.sh
  # Started as root before the drop, so the agent cannot stop it.
  while sleep 300; do /usr/local/bin/init-firewall.sh || true; done &
fi

uid="${HOST_UID:-}"
gid="${HOST_GID:-}"

case "$uid" in
  '' | *[!0-9]*)
    echo 'entrypoint: HOST_UID must be a number' >&2
    exit 1
    ;;
esac

case "$gid" in
  '' | *[!0-9]*)
    echo 'entrypoint: HOST_GID must be a number' >&2
    exit 1
    ;;
esac

# A process that runs as uid 0 gets the container's capabilities back on exec, NET_ADMIN included.
if [ "$uid" -eq 0 ]; then
  echo 'entrypoint: refusing HOST_UID 0, the driver must not run as root' >&2
  exit 1
fi

# Files in the clone and the home then belong to the host user. The home is
# never walked: it already belongs to that user, and a kept one is large.
sed -i "s/^agent:x:[0-9]*:[0-9]*:/agent:x:$uid:$gid:/" /etc/passwd
sed -i "s/^agent:x:[0-9]*:/agent:x:$gid:/" /etc/group

git config --system --add safe.directory "$PWD"
git config --system credential.helper '!gh auth git-credential'

# Each passed variable becomes a NAME=value word before the command, for env
# below. The command word never contains `=`, so env runs it unchanged.
set -f
for name in ${ROLLOUT_ENV:-}; do
  if value="$(printenv "$name")"; then
    set -- "$name=$value" "$@"
  fi
done
set +f

# With no_new_privs, setuid bits and file capabilities are inert for the command and everything it starts.
exec setpriv --reuid="$uid" --regid="$gid" --clear-groups --inh-caps=-all --no-new-privs env -i HOME=/home/agent PATH=/usr/local/bin:/usr/bin:/bin TMPDIR=/tmp "$@"

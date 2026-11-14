#!/bin/sh
# Starts the API as `app` (uid 1654), never root, and hands it its two volumes first.
#
# The container starts as root only for this: a volume an older, root-run backend created is
# root-owned, and an unprivileged API could not write a photo into it. Doing the hand-over here,
# rather than in a separate compose service, means a stack file written for the root image keeps
# working unchanged. Only what is not already owned is touched, so a restart costs nothing.
set -eu
if [ "$(id -u)" = 0 ]; then
  find /app/media /app/biometric ! -user 1654 -exec chown 1654:1654 {} +
  exec setpriv --reuid=1654 --regid=1654 --init-groups --inh-caps=-all -- "$@"
fi
exec "$@"

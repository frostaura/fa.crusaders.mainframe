# Backup and restore — the club's database and photos

The production stack backs itself up. This page is how to check that it is doing so, how to get a
copy **off** the machine, and how to put a club back after the machine or its disk is gone. The
restore below was drilled end to end against a throwaway copy of the production stack before this
page was written, and `make test-infra` replays it on every CI run (`test/infra/test_backup_restore.py`).

## Why this matters more here than usual

- **Money is ledger-only.** Every member's balance is the sum of rows in one Postgres database. Lose
  the database and every balance is gone, with nothing to rebuild it from.
- **The court boxes and doors authenticate with the club's device API key, which lives in that
  database** (`tenants`). A rebuilt, empty database mints a *different* key, so every board is
  locked out until its key is replaced. Device contract v3 can put a known key back (Devices →
  *Restore a key*, or `Bootstrap__DeviceApiKey` on a rebuilt stack — `docs/specs/device-api.md` §6),
  but only if somebody still has the old key. **Keep it in the password manager.**
- **The photos** (`media_data`) are mandatory at registration and shown on the booking grid. They are
  backed up beside each dump.

## What runs, and where the files go

The `backup` service in `docker-compose.prod.yml` (and, by `extends`, the on-prem overlay):

| | |
|---|---|
| When | daily at `BACKUP_HOUR_UTC` (default `0`, i.e. 02:00 at the club), and **at once** on a host with no backup at all |
| What | `crusaders-daily-<UTC stamp>.dump` (`pg_dump` custom format, read back with `pg_restore --list` before it is kept) and `crusaders-daily-<stamp>.media.tar.gz` (the photos) |
| Where | `CRUSADERS_BACKUP_DIR` **on the host**, default `/var/backups/crusaders-mainframe` |
| Kept | `BACKUP_KEEP_DAYS` (default 14), but **never fewer than the newest `BACKUP_KEEP_MIN`** (default 3), however old — a job that has been failing for a month must not prune the last good copy |
| Health | the container turns **unhealthy** when the newest dump is more than 26 hours old |

Files are written with mode `0600`. They contain password hashes, members' e-mail addresses and the
device key. Treat them as secrets.

## Every week: is it working?

On the Pi (or the machine running the stack). `P` is the stack's name as Portainer lists it under
*Stacks* — compose labels every container with it, and filtering on it as well as on the service
keeps these commands off any other stack on the same host:

```bash
P=crusaders   # the Portainer stack's name
B=$(docker ps --filter label=com.docker.compose.project=$P --filter label=com.docker.compose.service=backup --format '{{.Names}}')
docker ps --filter name="$B" --format '{{.Names}} {{.Status}}'   # "(healthy)" is the answer
ls -lt /var/backups/crusaders-mainframe | head                   # a daily dump from the last 24 h
docker logs --tail 20 "$B"                                       # "backup: wrote ..." lines
```

`unhealthy`, or no file from today: read the log. The usual cause is the database password —
`PGPASSWORD` in the backup service is anchored to `POSTGRES_PASSWORD`, so it cannot drift from the
server's, but a stack whose `postgres` service was edited by hand can.

## A backup on demand — always before a redeploy

```bash
docker exec "$B" crusaders-backup predeploy
```

The label (`predeploy`) is lower-case letters, digits and dashes. `crusaders-prune` applies retention
at once; nothing else needs it.

## Off the machine — the step the stack cannot do for you

**A backup on the same SD card is not a backup.** The stack writes to the host; getting a copy off it
is a host-level job, because it needs a destination and a credential the repository must never hold.
Pick one destination (a second machine, a NAS, or an S3-compatible bucket through `rclone`) and run
this from the host's crontab half an hour after `BACKUP_HOUR_UTC`. It encrypts with a passphrase that
lives in the password manager and in a root-only file on the host, never in the stack:

```bash
# /etc/cron.d/crusaders-offsite  (root)   — 00:30 UTC, after the 00:00 backup
30 0 * * * root d=/var/backups/crusaders-mainframe; f=$(ls -1t $d/crusaders-*.dump | head -1); \
  for x in "$f" "${f%.dump}.media.tar.gz"; do \
    gpg --batch --yes --pinentry-mode loopback --passphrase-file /root/.crusaders-backup-passphrase \
        --symmetric --cipher-algo AES256 -o "/root/offsite/$(basename "$x").gpg" "$x"; done; \
  rclone copy /root/offsite crusaders-offsite:crusaders-mainframe && find /root/offsite -type f -delete
```

`crusaders-offsite:` is whatever `rclone config` named the destination. Check it once by decrypting a
copy on another machine: `gpg -d crusaders-daily-….dump.gpg > x.dump && pg_restore --list x.dump`.

## Restore — the club's machine or disk is gone

Time it. The drill on 2026-11-13 (a laptop, the backend image built from this tree, a real migrated
and bootstrapped database plus one photo, the volumes then deleted) took **18 seconds** from an empty
stack to a healthy backend serving the restored club: the same tenant id, the photo back and
writable by the API. A Pi will be slower; the steps are the same.

1. **Stand the stack up again** on the replacement machine from the same Portainer stack file (the
   `CHANGE-ME` values from the password manager — the JWT secret and the member-code master key above
   all: a different master key changes every member's code). Let it start; the backend will migrate
   an **empty** database and `ProductionBootstrap` will create a **new, empty** club in it. That is
   expected and is about to be replaced.
2. **Put the backup files back** into `CRUSADERS_BACKUP_DIR` on the new host (decrypt the offsite
   copy: `gpg -d … > crusaders-daily-<stamp>.dump`, and the same for `.media.tar.gz`). Keep each dump
   and its media archive side by side with the same name stem.
3. **Stop the backend**, so nothing writes while the database is replaced:

   ```bash
   P=crusaders   # the Portainer stack's name
   API=$(docker ps --filter label=com.docker.compose.project=$P --filter label=com.docker.compose.service=backend --format '{{.Names}}')
   B=$(docker ps --filter label=com.docker.compose.project=$P --filter label=com.docker.compose.service=backup --format '{{.Names}}')
   docker stop "$API"
   ```

4. **Restore**, naming the database a second time as the confirmation:

   ```bash
   docker exec "$B" crusaders-restore crusaders-daily-<stamp>.dump crusaders_mainframe
   ```

   It refuses (exit 3) while anything is still connected, backs up the database it is about to
   replace (`crusaders-pre-restore-…`), drops and recreates it, restores the dump, puts the photos
   back from the archive beside it, and prints the newest migration it restored.
5. **Start the backend**: `docker start "$API"`. If the image is newer than the backup, it applies
   the missing migrations on start, exactly as a redeploy would. Check `/healthz`, sign in, and open
   one member's ledger.
6. **The boards.** If the dump came from the same database the boards were flashed against, their
   key is in it and they reconnect by themselves on their next heartbeat. If the database could not
   be restored at all, set the old key back from the password manager (*Restore a key* on the Devices
   page, owner only), never a new one.

What a restore loses: everything written after the dump was taken. A daily dump loses up to a day
— bookings, top-ups and attendance. A PayFast top-up paid in that window is still in PayFast's
records and its ITN can be replayed from the merchant dashboard; nothing else comes back.

## Restore drill — once before go-live, then after any change to the backup service

On a spare machine or a laptop, never against the club's stack: bring up `docker-compose.prod.yml`
under its own project name (`docker compose -p crusaders-drill -f docker-compose.prod.yml …`) with
the `networks.default.ipam` subnet overridden to a free one, copy one real dump into its backup
directory, and run steps 3–5 above. Record the date and how long it took in the memory store's state
topic. `make test-infra` does the mechanical half of this on every CI run; only a drill with a real
dump proves the dump.

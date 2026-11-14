# Redeploy and roll back the club stack

CI publishes images and stops; putting a release on the club's machine is this page, done by hand in
Portainer. Read the first section every time — it is the part that has gone wrong before.

## Manual steps that are NOT automatic — every time, before you press anything

1. **Take a backup.** `docker exec <stack>-backup-1 crusaders-backup predeploy`
   ([`backup-and-restore.md`](backup-and-restore.md)). Migrations are forward-only; this dump is the
   only way back if the release has to be undone after it migrated.
2. **List the migrations this release will run**, against the club's real database, from a laptop
   with the repository (`git fetch` first, so the commit is there to read):

   ```bash
   make migrations-pending REF=<commit being deployed> \
     PSQL="ssh <the Pi> docker exec -i <stack>-postgres-1 psql -U crusaders -d crusaders_mainframe"
   ```

   Exit 0: nothing to migrate. Exit 3: the list, in the order the backend will run them on start.
   **Read every one flagged `CHANGES ROWS` or `CAN REFUSE` before deploying** — `git show
   <commit>:src/backend/Crusaders.Mainframe.Api/Migrations/<id>.cs`. Known ones:
   - `FindableByDefault` runs `UPDATE user_preferences SET "Findable" = TRUE WHERE "Findable" = FALSE`:
     every member who chose *not findable* becomes findable. If the club has members, count them
     first (`select count(*) from user_preferences where "Findable" = false;`) and decide with the
     club whether that is acceptable before deploying.
   - `MinutesReplaceCredits` refuses a database with any money history
     ([`../go-live-checklist.md`](../go-live-checklist.md) §2a).

   Exit 4 means the database is **ahead** of the commit — it was migrated by a newer image. Do not
   deploy it; see *Roll back* below.
3. **Open the STORED stack file in Portainer** (Stacks → the stack → *Editor*) and check, by eye:
   - no `CHANGE-ME` is left — above all `Jwt__Secret` and `MemberCodes__MasterKey`: the API refuses
     to start on either placeholder, and a member-code master key **changed** after members enrol
     changes every member's code;
   - the gateway service names `frostaura/crusaders-mainframe-gateway` and bind-mounts no
     `nginx.conf` (a stack that does keeps its old gateway config through every redeploy);
   - an older stack file still deploys: the backend image hands its own volumes to its
     unprivileged user, so no new service or value is required. The current
     `docker-compose.prod.yml` adds the `backup` service and `${CRUSADERS_IMAGE_TAG:-latest}`;
     carry those across when convenient, never as a precondition of a redeploy.
4. **Copy the stack file somewhere safe before pressing Update.** A failed Portainer update discards
   the edits you made in the editor, and with them the record of what you changed.

## Which release is running now

```bash
docker inspect <stack>-backend-1 --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
```

The same for `-frontend-1` and `-gateway-1`. Images published before 2026-11-13 carry no revision
label and print nothing: for those, *what runs* is only knowable from the database's newest migration
(`select max("MigrationId") from "__EFMigrationsHistory";`).

## Which release to deploy

Every push to `main` whose CI run is green publishes, for all three images, an **immutable** tag
`sha-<40-hex commit>` (multi-arch). `:latest` follows only after all six image builds and the
manifests succeeded, for all three images together, and only forward (an older run that finishes
late leaves it alone). Deploy by the sha tag, never by `:latest`:

```bash
docker buildx imagetools inspect frostaura/crusaders-mainframe-backend:sha-<commit>   # exists?
```

## Redeploy

1. Portainer → Stacks → the stack → *Environment variables*: set `CRUSADERS_IMAGE_TAG` to
   `sha-<commit>`. (Unset, the stack falls back to `:latest`.)
2. *Update the stack* with **Re-pull image** on.
3. Watch the backend come up — the migrations run here:
   `docker logs -f <stack>-backend-1`. A refusing migration exits the container with code 134 and
   the restart policy retries it; that is the moment to stop and roll back, not to wait.
4. Check: `/healthz` answers (`curl -s http://<the Pi>:8088/healthz`), the revision label above
   names the commit, `make migrations-pending REF=<commit> PSQL=…` exits 0, and one member can sign in
   and see their balance.

## Roll back

- **No migration ran** (step 2 above listed nothing pending): set `CRUSADERS_IMAGE_TAG` back to the
  previous `sha-<commit>` and update the stack. Nothing else is needed.
- **A migration ran**: an older image does not know the newer schema and may refuse to start or
  write wrongly. Stop the backend, restore the `predeploy` dump taken in step 1
  ([`backup-and-restore.md`](backup-and-restore.md), *Restore*, steps 3–5), set
  `CRUSADERS_IMAGE_TAG` back to the previous sha, and update the stack. **Everything written since
  the dump is lost** — bookings, top-ups and attendance made on the new release. Say so to the club.
- **The stack is on `:latest` and nobody wrote down the previous sha**: the GitHub Actions run
  history lists every published commit; pick the last one whose run was green and that predates the
  bad release.

## Moving `:latest` by hand

Only when the forward-only rule holds it back on purpose (history rewritten on `main`, or a deliberate
revert to an older commit that must become `:latest`). With Docker Hub credentials:

```bash
for i in backend frontend gateway; do
  docker buildx imagetools create -t frostaura/crusaders-mainframe-$i:latest frostaura/crusaders-mainframe-$i:sha-<commit>
done
```

Nothing in the club stack needs this if it pins `CRUSADERS_IMAGE_TAG`.

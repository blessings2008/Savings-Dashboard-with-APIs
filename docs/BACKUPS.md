# PocketVault — Firestore Backups

Two complementary mechanisms, per the decision to have both:

1. **Scheduled backups** — a recurring, automatic export configured once in
   Google Cloud, running independently of the app.
2. **Manual backups** — an on-demand export triggerable from the admin panel
   (Operations page) or `POST /api/admin/backups/export`, for snapshots
   before a risky deploy, migration, or any other one-off moment.

Both write to the same mechanism under the hood — Firestore's native
managed export to Cloud Storage — so backups from either path are restored
the same way (see "Restoring" below).

## 1. One-time setup (required for both mechanisms)

### 1.1 Create a Cloud Storage bucket for backups

```
gcloud storage buckets create gs://pocketvault-firestore-backups \
  --project=<your-firebase-project-id> \
  --location=<a region close to your Firestore location, e.g. europe-west1>
```

Use a dedicated bucket, not one already used for other app storage — this
keeps lifecycle/retention rules (Section 3) scoped to backups only.

### 1.2 Grant the service account export permission

The same service account already used for Firebase Admin (whichever
credential method is configured — see `core/firebase.js`) needs the
**Cloud Datastore Import Export Admin** IAM role to call the export API:

```
gcloud projects add-iam-policy-binding <your-firebase-project-id> \
  --member="serviceAccount:<your-service-account-email>" \
  --role="roles/datastore.importExportAdmin"
```

The service account also needs write access to the backup bucket
(`roles/storage.objectAdmin` on that bucket, or broader
`roles/storage.admin` on the project, is sufficient).

No new dependency or separate credentials were added to the app for this —
manual export (`helpers.js`'s `triggerFirestoreExport`) reuses the same
Firebase Admin credentials already loaded at boot, via
`getGcpAccessToken()`.

## 2. Scheduled backups (recurring, GCP-side)

This is configuration, not application code — set up once via Cloud
Scheduler + a Cloud Function, or Google's simpler built-in option below.

### Recommended: Firestore's built-in scheduled backups

As of recent Firestore versions, Google offers native scheduled backups
configurable directly from the Firestore console (Backups tab) with no
Cloud Function needed:

1. Firebase Console → Firestore Database → Backups
2. Create a backup schedule — daily or weekly, with a retention period
   (e.g. 7 daily + 4 weekly, adjust to your needs)
3. Done — Google handles the rest, including retention/expiry

This is the lowest-maintenance option and is what we'd recommend unless
you have a specific reason to need the Cloud Scheduler + Cloud Function
approach below (e.g. you want the export to also trigger a custom
notification or land in a bucket outside GCP's managed backup storage).

### Alternative: Cloud Scheduler + Cloud Function (more control)

If you want the recurring export to land in your own bucket (rather than
Google's managed backup storage) or want a custom hook on completion:

1. Deploy a small Cloud Function that calls the same
   `exportDocuments` REST endpoint used by `triggerFirestoreExport()`
   (see `helpers.js` for the exact request shape) — or reuse this app's
   own `POST /api/admin/backups/export` endpoint as the Cloud Scheduler's
   HTTP target, authenticated with the `x-admin-secret` header.
2. Create a Cloud Scheduler job:
   ```
   gcloud scheduler jobs create http pocketvault-daily-backup \
     --schedule="0 3 * * *" \
     --uri="https://savings-dashboard-with-apis-2-0.onrender.com/api/admin/backups/export" \
     --http-method=POST \
     --headers="x-admin-secret=<your ADMIN_SECRET>,Content-Type=application/json" \
     --message-body='{"bucketUri":"gs://pocketvault-firestore-backups/scheduled"}'
   ```
3. Verify by checking `GET /api/admin/backups/history` after the scheduled
   time, or the admin Operations page's Backups panel.

Note: this reuses the app's own endpoint for convenience, but it means a
scheduled backup depends on the app being up. If you want a backup
mechanism that's independent of app uptime, the built-in Firestore
scheduled backups (above) don't have this dependency.

## 3. Retention

Set a lifecycle rule on the backup bucket so old exports don't accumulate
indefinitely:

```
gcloud storage buckets update gs://pocketvault-firestore-backups \
  --lifecycle-file=lifecycle.json
```

where `lifecycle.json` deletes objects older than N days, e.g.:
```json
{
  "rule": [
    { "action": {"type": "Delete"}, "condition": {"age": 30} }
  ]
}
```

## 4. Manual/on-demand backups (app-triggered)

From the admin panel: **Operations → Backups card** — enter a `gs://`
bucket URI and click **Export Now**. From the API directly:

```
POST /api/admin/backups/export
x-admin-secret: <ADMIN_SECRET>
Content-Type: application/json

{ "bucketUri": "gs://pocketvault-firestore-backups/manual" }
```

Optional `collectionIds` array to export only specific collections
(omit to export everything). Rate-limited to 5 requests/hour — exports are
heavyweight, asynchronous operations on Google's side.

Check status/history via `GET /api/admin/backups/history` or the same
Operations page panel.

## 5. Restoring from a backup

Restores are also a managed operation, done via `gcloud` (there's no
in-app restore endpoint — a restore is a rare, high-stakes action best
done deliberately from the command line, not a button in the UI):

```
gcloud firestore import gs://pocketvault-firestore-backups/<export-folder>
```

**Important:** a Firestore import does not merge — it can overwrite
existing documents with the same IDs. Test restores against a separate
Firebase project first if at all possible, never directly against
production, unless production is already down and this is the recovery
action itself.

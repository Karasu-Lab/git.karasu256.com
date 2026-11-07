# git.karasu256.com

The internal git service for Karasu Lab, running as a Cloudflare Worker built with ElysiaJS. It does only three things: it creates the CDN server bucket that stores repository mirrors, it refreshes those mirrors and issues the signed upload URLs through which clients seed a mirror that does not exist yet, and it creates SSH-signed commits on the mirrors and pushes them to GitHub. This service never performs the first clone of a repository: the client clones the repository and uploads the initial mirror through a presigned URL issued by this service. Callers such as admin.karasu256.com describe the change and this service performs it. Git operations run on isomorphic-git over an in-memory filesystem; the durable home of every mirror is the bucket, where each mirror is stored as one JSON object under `mirrors/<owner>/<repository>.json` holding the base64-encoded files of the repository's `.git` directory.

Every endpoint is internal: requests must carry a valid signature made with the shared `INTERNAL_API_SECRET` (the same request-signing scheme used between api-auth and its callers), and unsigned or invalidly signed requests are rejected.

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `POST /api/internal/storage/bucket` | Creates the bucket named by the `STORAGE_BUCKET` variable on the CDN server's S3-compatible storage. Idempotent: an existing bucket is a success. The bucket is also created by the deploy workflow before the production worker deploys, and the mirror endpoints below ensure it exists before they touch the storage, so this endpoint does not have to be called first. |
| `POST /api/internal/repositories/access` | Answers whether a repository may be mirrored and committed to, keyed by the GitHub repository id: `{ repositoryId, remote, visibility: "public" \| "private" \| null, allowed, reason? }`. The source of truth is the `repositories` table in the admin app's Cloudflare D1 `admin` database (read through the `ADMIN_DB` binding; the migrations live in the admin repository, which owns the database). A repository with no row is blocked as unregistered — rows are created only from the admin dashboard, when a repository is added there. A row with `is_private` set is blocked as private, because mirror contents must never be placed in the CDN bucket; a row with `is_private` clear is allowed as public. GitHub is not queried for this decision. |
| `POST /api/internal/mirrors/upload-url` | Runs the access check by repository id first and refuses blocked repositories with the same 403 payload as the commit endpoint, then reports whether the repository's mirror already exists in the bucket: `{ exists: true, key }` when it does. When it does not, returns `{ exists: false, key, uploadUrl, expiresAt }`, where `uploadUrl` is a presigned PUT URL (valid for one hour, content type `application/json`) through which the client uploads the initial mirror it cloned itself. The server never clones a repository for the first mirror. |
| `POST /api/internal/mirrors/sync` | Runs the access check by repository id first and refuses blocked repositories, then fetches and fast-forwards the existing mirror in the bucket and returns the default branch and its HEAD. When no mirror exists yet, the request fails with `409 { error: "mirror_not_seeded", repositoryFullName }`: the initial mirror is seeded by the client through the upload URL above, not cloned by the server. |
| `POST /api/internal/mirrors/commit` | Runs the access check by repository id first and refuses blocked repositories, then, on a fresh copy of the mirror, creates the requested branch, applies file changes and gitlink changes (a submodule addition is a gitlink plus a `.gitmodules` entry; a pointer update is a gitlink SHA replacement), creates an SSH-signed commit and pushes the branch to GitHub. When no mirror exists yet, the request fails with `409 { error: "mirror_not_seeded", repositoryFullName }`, as with the sync endpoint. The signing key and the installation token are fetched server-to-server from api-auth for the user who installed the tenant's GitHub App bot and the tenant respectively. There is no unsigned fallback: when the key cannot be fetched or used, the request fails. |

## Required environment variables

The deploy workflow (`.github/workflows/git-deploy.yml`) is a thin wrapper around `Karasu-Lab/WorkersDeploy@v1`, in the same form as api-auth's deploy workflow: the production job runs in the `production` GitHub Environment and the preview job in the `preview` environment, and the following names are read from GitHub Environments as variables or secrets and synced to the worker. Values are never committed to the repository. Before the production worker deploys, the deploy job also creates the R2 bucket named by the `STORAGE_BUCKET` repository variable with wrangler, using the job's `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; an existing bucket is a success. `STORAGE_ENDPOINT` and `STORAGE_BUCKET` must be registered as variables and `INTERNAL_API_SECRET`, `STORAGE_ACCESS_KEY_ID` and `STORAGE_SECRET_ACCESS_KEY` as secrets, or the deployed worker cannot sign requests or reach the mirror storage.

### Deployment

| Name | Kind | Used for |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Secret | Authenticating wrangler against Cloudflare |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | The Cloudflare account the worker is deployed to |
| `NODE_AUTH_TOKEN` | Secret | Reading the `@karasu-lab` packages from GitHub Packages during the build; falls back to the workflow's `GITHUB_TOKEN` |

### Worker secrets

| Name | Used for |
| --- | --- |
| `INTERNAL_API_SECRET` | Shared secret that signs and verifies the internal API requests between this service, admin and api-auth, and that this service uses when calling api-auth for installation tokens and signing key material |
| `STORAGE_ACCESS_KEY_ID` | Access key for the CDN server's S3-compatible storage |
| `STORAGE_SECRET_ACCESS_KEY` | Secret key for the CDN server's S3-compatible storage |

### Worker variables

| Name | Used for |
| --- | --- |
| `APP_ENV` | `production` on the production worker, `preview` on previews |
| `AUTH_API_URL` | Base URL of api-auth.karasu256.com, which issues installation tokens and serves signing key material |
| `STORAGE_ENDPOINT` | Endpoint of the CDN server's S3-compatible storage |
| `STORAGE_BUCKET` | Name of the bucket that stores the repository mirrors, supplied as the `STORAGE_BUCKET` repository variable |
| `STORAGE_REGION` | Storage region for SigV4 signing; defaults to `auto` |

The worker reads the admin app's Cloudflare D1 database through an `ADMIN_DB` binding. The binding is not declared in `wrangler.jsonc` yet: a D1 binding without a `database_id` fails Cloudflare's deploy validation (error 10021). The `admin` database has since been created through the admin app's deploy workflow (the migrations live in the admin repository, which owns the database); once the binding `{ "binding": "ADMIN_DB", "database_name": "admin", "database_id": "<the created database's id>" }` is added to `wrangler.jsonc` — without a migrations directory here — the access decision starts working. Until then the access endpoint surfaces the missing binding as an error.

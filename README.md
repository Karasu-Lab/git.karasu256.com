# git.karasu256.com

The internal GitHub API proxy for Karasu Lab, running as a Cloudflare Worker built with ElysiaJS. It performs GitHub operations on behalf of callers such as admin.karasu256.com using the GitHub App installation token that api-auth issues for a tenant. It does not clone, push or store any repository data: commits are created through the GitHub Git Data API, and commits created with an installation token are signed by GitHub.

Every endpoint is internal: requests must carry a valid signature made with the shared `INTERNAL_API_SECRET` (the same request-signing scheme used between api-auth and its callers), and unsigned or invalidly signed requests are rejected. Every request body is validated with zod before any GitHub request is made; invalid bodies are answered with `400 { error: "Bad Request" }`.

## Endpoints

All endpoints are `POST` and take `organizationId`, which selects the tenant whose installation token is used.

| Endpoint | Request | Response |
| --- | --- | --- |
| `/api/internal/repositories/list` | `{ organizationId }` | `{ repositories }` |
| `/api/internal/repositories/create` | `{ organizationId, targetType, targetLogin, name, description?, private?, isTemplate? }` | `{ repository }` |
| `/api/internal/pull-requests/create` | `{ organizationId, repositoryFullName, title, head, base, body?, enableAutoMerge? }` | `{ pullRequest }` |
| `/api/internal/pull-requests/find-by-commit` | `{ organizationId, repositoryFullName, sha }` | `{ pullRequest }` |
| `/api/internal/comments/create` | `{ organizationId, repositoryFullName, issueNumber, body }` | `{ comment }` |
| `/api/internal/comments/update` | `{ organizationId, repositoryFullName, commentId, body }` | `{ comment }` |
| `/api/internal/statuses/create` | `{ organizationId, repositoryFullName, sha, state, context, description?, targetUrl? }` | `{ status }` |
| `/api/internal/contents/commit` | `{ organizationId, repositoryFullName, branch, baseBranch, message, files?, deletions? }` | `{ outcome: "pushed", commitOid, branch }` or `{ outcome: "no_changes", branch }` |
| `/api/internal/dispatches/create` | `{ organizationId, repositoryFullName, eventType, clientPayload }` | `{ dispatched: true }` |

### contents/commit

Creates one commit on a new branch through the Git Data API: it reads `baseBranch`, creates a blob for each entry of `files` (`{ path, content }`, UTF-8 text), builds a tree on top of the base tree that also removes every path in `deletions`, creates the commit and then the ref `refs/heads/<branch>`. `files` and `deletions` default to empty arrays and hold at most 50 entries each; a file is at most 512 KB and all files together at most 4 MB. When the resulting tree equals the base tree, no commit is created and `{ outcome: "no_changes", branch }` is returned. When `branch` already exists, the request fails with `409 { error: "branch_exists", branch }`; an existing branch is never updated.

### dispatches/create

Sends a `repository_dispatch` event. `eventType` must be one of `pointer-update`, `link-package` and `unlink-package`; any other value is answered with 400. `clientPayload` is a JSON object with at most 10 top-level keys and at most 8 KB when serialized.

### Validation

`repositoryFullName` is `owner/name` made of `A-Za-z0-9._-`, without `.` or `..` segments. `sha` is 40 lowercase hexadecimal characters. Branch names use `A-Za-z0-9._/-`, are at most 200 characters, and cannot contain `..` or `//`, start with `-` or `/`, or end with `/` or `.lock`. File paths are relative, at most 500 characters, and cannot contain `..` segments, empty segments, backslashes or control characters.

## Required environment variables

The deploy workflow (`.github/workflows/git-deploy.yml`) is a thin wrapper around `Karasu-Lab/WorkersDeploy`, pinned by commit SHA, in the same form as api-auth's deploy workflow: the production job runs in the `production` GitHub Environment and the preview job in the `preview` environment, and the following names are read from GitHub Environments as variables or secrets and synced to the worker. Values are never committed to the repository.

### Deployment

| Name | Kind | Used for |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Secret | Authenticating wrangler against Cloudflare |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | The Cloudflare account the worker is deployed to |
| `NODE_AUTH_TOKEN` | Secret | Reading the `@karasu-lab` packages from GitHub Packages during the build; falls back to the workflow's `GITHUB_TOKEN` |

### Worker secrets

| Name | Used for |
| --- | --- |
| `INTERNAL_API_SECRET` | Shared secret that signs and verifies the internal API requests between this service, admin and api-auth, and that this service uses when calling api-auth for installation tokens |

### Worker variables

| Name | Used for |
| --- | --- |
| `APP_ENV` | `production` on the production worker, `preview` on previews |
| `AUTH_API_URL` | Base URL of api-auth.karasu256.com, which issues installation tokens |

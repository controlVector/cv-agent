# Multi-Org Hotfix — Investigation Findings

## Current registration code
- File: `src/utils/api.ts:51`
- Function: `registerExecutor(creds, machineName, workingDir, repositoryId?, metadata?, repoOwnerSlug?)`
- Current request shape: `{ name, machine_name, type, workspace_root, capabilities, repository_id?, organization_id?, role?, dispatch_guard?, tags?, owner_project?, integration? }`
- Existing partial fix (v1.10.1): catches multi-org 400 and retries when `repoOwnerSlug` is available from a CV-Hub git remote. Fails when no CV-Hub remote exists.

## Expected server-side org parameter
- Form: body field
- Exact key name: `organization_id`
- Value type: UUID only (schema: `z.string().uuid().optional()`)
- Evidence: `apps/api/src/routes/executors.ts:118` — `organization_id: z.string().uuid().optional()`
- Resolution chain: explicit `organization_id` → inferred from `repository_id` → PAT org scope → single org → error with org list

## Error response schema
- Status: 400
- Body: `{ error: { message: "Multiple organizations found. Specify organization_id or use an org-scoped PAT.", organizations: Array<{id: uuid, name: string, slug: string}> } }`
- Trigger condition: user belongs to 2+ orgs AND no `organization_id` in body AND no PAT org scope AND repo doesn't infer an org

## Org-scoped PAT path
- Available: yes — PATs can have `organization_id` column set
- How it works: PAT created with `organization_id` → server resolves via `patOrgId` context → skips multi-org check
- Recommendation: primary path = body field + interactive picker; org-scoped PAT = documented alternative

## Gap in current fix
- v1.10.1 only auto-resolves when `repoOwnerSlug` comes from a CV-Hub git remote
- When the workspace has no CV-Hub remote (e.g., `~/project/cv-code` with only a GitHub remote), `detectedOwnerSlug` is undefined → no retry → 400 propagates
- Missing: interactive picker, env var fallback, repo-local config persistence

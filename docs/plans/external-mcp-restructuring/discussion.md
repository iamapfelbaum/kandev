# External MCP: Current-to-Target Tool Migration

## Discussion draft

**Status:** Proposed design. The target API is not implemented.

**Baseline:** Kandev main at
`727d59ce710ae16c4ec16c010a473590842409dd` on 2026-08-24.

This document maps every current External MCP tool to its proposed target.
It focuses on names, arguments, profile placement, and breaking changes.

## Executive summary

External MCP now exposes one fixed catalog with 40 tools. Any valid PAT gets
the same catalog. PAT records do not contain capability grants.

The proposal replaces the fixed catalog with three server-owned catalogs:

| Catalog | Purpose | Target |
| --- | --- | ---: |
| `supervisor_v2` | Task, session, clarification, and permission work | 16 tools, 4,000 schema tokens |
| `configuration_v2` | Workflow, agent, MCP, and executor configuration | At most 30 tools, 5,000 schema tokens |
| `legacy_v1` | Existing PAT and tool compatibility | 40 tools, 6,532 tokens, shrink-only |

The target request path is:

```text
External client
  -> network and PAT policy
  -> capability resolver
  -> server-owned catalog
  -> MCP adapter
  -> versioned application operation
  -> domain service or live runtime
```

MCP becomes a transport adapter. Business validation and resource authority
remain in the domain service.

Effective authority is the intersection of stored PAT grants, current role,
PAT profile, server policy, and active feature gates.

The stable capabilities are:

```text
tasks:read
tasks:write
sessions:read
sessions:write
questions:resolve
permissions:resolve
configuration:read
configuration:write
```

A new PAT uses the supervisor profile or the operator profile. It cannot
combine both profiles.

## Naming schema

The proposed schema is `<verb>_<resource>_kandev`.

| Verb | Use |
| --- | --- |
| `list` | Return a collection of one resource type. |
| `get` | Return one resource or one aggregate read model. |
| `create` | Create a persistent resource. |
| `update` | Apply a partial resource change. |
| `delete` | Permanently remove a resource. |
| `archive` | Hide a resource without permanent removal. |
| `move` | Change workflow placement. |
| `start` and `stop` | Change runtime lifecycle. |
| `send` | Create a message for an exact target. |
| `resolve` | Complete a pending decision. |
| `import`, `export`, and `reorder` | Keep their specific domain meanings. |

Additional rules:

- A `list` tool uses a plural resource name.
- A `get` tool uses a singular resource name.
- A name does not hide two resource types.
- Generic IDs become qualified for resource types that share one ID name.
- Operation IDs carry versions, such as `sessions.message@v1`.
- Tool names do not gain a version suffix unless two breaking majors coexist.
- The `_kandev` suffix remains on built-in tools.
- Existing `config` identifiers remain technical identifiers.

## Recommended renames

These renames remove real ambiguity. Each old name can remain an alias during
the migration window.

| Current or earlier draft | Recommended target | Reason |
| --- | --- | --- |
| `list_agents_kandev` | `list_agent_definitions_kandev` | The current result mixes agent definitions and profiles. |
| `update_agent_kandev` | `update_agent_definition_kandev` | The name now matches the definition query. |
| `list_executors_kandev` | `list_executor_types_kandev` | The resource is an executor type. The current result also embeds profiles. |
| `get_mcp_config_kandev` | `get_agent_profile_mcp_config_kandev` | MCP configuration belongs to one agent profile. |
| `update_mcp_config_kandev` | `update_agent_profile_mcp_config_kandev` | The target resource becomes explicit. |
| `update_task_state_kandev` | `update_task_kandev` | State is one part of the task resource. |
| `answer_question_kandev` | `resolve_clarification_kandev` | One call answers or rejects a bundle with multiple questions. |
| `get_task_conversation_kandev` | `get_task_session_conversation_kandev` | Conversation content belongs to one task session. |
| `list_task_create_options_kandev` | `get_task_creation_options_kandev` | The result is one aggregate, not one collection. |

The conversation rename is the largest naming choice. It also makes
`session_id` required for the v2 tool. The legacy alias can keep primary-session
fallback during migration.

## Argument naming changes

These changes make generic IDs consistent across the catalog.

| Current argument | Target argument | Applies to |
| --- | --- | --- |
| `step_id` | `workflow_step_id` | Update and delete workflow step |
| `step_ids` | `workflow_step_ids` | Reorder workflow steps |
| `profile_id` | `agent_profile_id` | Agent profile and profile MCP tools |
| `profile_id` | `executor_profile_id` | Executor profile tools |

Established task arguments remain unchanged. Examples include `parent_id`,
`blocked_by`, and `external_id`. Their migration cost is larger than their
naming benefit.

## Argument notation

- `name: type` is required.
- `name?: type` is optional.
- `T[]` is an array.
- `object` is a typed JSON object in the final schema.
- The current column describes the source at the baseline commit.

## Current tool migration matrix

### Workflow configuration tools (1 through 13)

| # | Current tool and arguments | Proposed target | Change |
| ---: | --- | --- | --- |
| 1 | `list_workspaces_kandev()` | Same name and arguments | **Keep.** Shared by supervisor and operator catalogs. One canonical definition replaces duplicate registrations. |
| 2 | `list_workflows_kandev(workspace_id: string)` | Same name and arguments | **Keep.** Shared by supervisor and operator catalogs. One canonical definition replaces duplicate registrations. |
| 3 | `list_repositories_kandev(workspace_id: string)` | Same name and arguments | **Keep in operator.** Remove from the common supervisor. The safe creation-options tool replaces it there. |
| 4 | `create_workflow_kandev(workspace_id: string, name: string, description?: string)` | Same name and arguments | **Keep in operator.** Add structured output, capability policy, and risk metadata. |
| 5 | `update_workflow_kandev(workflow_id: string, name?: string, description?: string)` | Same name and arguments | **Keep in operator.** Use one canonical partial-update operation. |
| 6 | `delete_workflow_kandev(workflow_id: string)` | Same name and arguments | **Keep in operator.** Require admin role and `configuration:write`. Mark destructive. |
| 7 | `import_workflow_kandev(workspace_id: string, document: string)` | Same name and arguments | **Keep in operator.** Preserve the version 1 portable document. Add structured output. |
| 8 | `export_workflow_kandev(workflow_id: string)` | Same name and arguments | **Keep in operator.** Preserve the version 1 portable document and 1 MiB import compatibility. |
| 9 | `list_workflow_steps_kandev(workflow_id: string)` | Same name and arguments | **Keep in operator.** Remove from the common supervisor. |
| 10 | `create_workflow_step_kandev(CreateWorkflowStepInput)` | Same name and arguments | **Keep in operator.** Add typed event schemas and structured output. |
| 11 | `update_workflow_step_kandev(UpdateWorkflowStepInput)` | `update_workflow_step_kandev(UpdateWorkflowStepInputV2)` | **Change argument.** Rename `step_id` to `workflow_step_id`. Keep the old argument in a compatibility mapper. |
| 12 | `delete_workflow_step_kandev(step_id: string)` | `delete_workflow_step_kandev(workflow_step_id: string)` | **Change argument.** Qualify the ID. Keep the old argument during migration. |
| 13 | `reorder_workflow_steps_kandev(workflow_id: string, step_ids: string[])` | `reorder_workflow_steps_kandev(workflow_id: string, workflow_step_ids: string[])` | **Change argument.** Qualify the array element type. |

Current `CreateWorkflowStepInput`:

```text
workflow_id: string
name: string
position?: number
color?: string
prompt?: string
is_start_step?: boolean
allow_manual_move?: boolean
show_in_command_panel?: boolean
auto_advance_requires_signal?: boolean
cancel_triggers_turn_complete?: boolean
wip_limit?: number
pull_from_step_id?: string
events?: object
```

Current `UpdateWorkflowStepInput`:

```text
step_id: string
name?: string
color?: string
prompt?: string
is_start_step?: boolean
allow_manual_move?: boolean
show_in_command_panel?: boolean
auto_archive_after_hours?: number
auto_advance_requires_signal?: boolean
cancel_triggers_turn_complete?: boolean
wip_limit?: number
pull_from_step_id?: string
events?: object
```

`UpdateWorkflowStepInputV2` has the same fields. It replaces `step_id` with
`workflow_step_id`.

### Agent and agent-profile tools (14 through 21)

| # | Current tool and arguments | Proposed target | Change |
| ---: | --- | --- | --- |
| 14 | `list_agents_kandev()` | `list_agent_definitions_kandev()` | **Rename and narrow result.** Return agent definitions only. Use `list_agent_profiles_kandev` for profiles. |
| 15 | `update_agent_kandev(agent_id: string, supports_mcp?: boolean, mcp_config_path?: string)` | `update_agent_definition_kandev(agent_id: string, supports_mcp?: boolean, mcp_config_path?: string)` | **Rename.** Arguments stay unchanged. Operator catalog only. |
| 16 | `create_agent_profile_kandev(agent_id: string, name: string, model: string, auto_approve?: boolean)` | Same name and arguments | **Keep and correct behavior.** Apply `auto_approve` instead of discarding it. |
| 17 | `delete_agent_profile_kandev(profile_id: string)` | `delete_agent_profile_kandev(agent_profile_id: string)` | **Change argument.** Qualify the profile ID. |
| 18 | `list_agent_profiles_kandev(agent_id: string)` | Same name and arguments | **Keep in operator.** Return a redacted external profile object. |
| 19 | `update_agent_profile_kandev(profile_id: string, name?: string, model?: string, auto_approve?: boolean)` | `update_agent_profile_kandev(agent_profile_id: string, name?: string, model?: string, auto_approve?: boolean)` | **Change argument and correct behavior.** Apply `auto_approve`. |
| 20 | `get_mcp_config_kandev(profile_id: string)` | `get_agent_profile_mcp_config_kandev(agent_profile_id: string)` | **Rename, change argument, and redact.** Never return raw environment, header, secret, or secret-reference values. |
| 21 | `update_mcp_config_kandev(profile_id: string, enabled?: boolean, servers?: object)` | `update_agent_profile_mcp_config_kandev(agent_profile_id: string, enabled?: boolean, servers?: MCPServerMapPatch)` | **Rename and change write semantics.** Sensitive fields use explicit `keep`, `replace`, or `clear`. |

`MCPServerMapPatch` is a typed server map. Environment and header values use
the sensitive patch contract below.

### Executor tools (22 through 26)

| # | Current tool and arguments | Proposed target | Change |
| ---: | --- | --- | --- |
| 22 | `list_executors_kandev()` | `list_executor_types_kandev()` | **Rename and narrow result.** Return executor types only. Do not embed profiles. |
| 23 | `list_executor_profiles_kandev(executor_id: string)` | Same name and arguments | **Keep in operator.** Use an external DTO. Omit raw environment values and secret-reference IDs. |
| 24 | `create_executor_profile_kandev(executor_id: string, name: string, mcp_policy?: string, config?: object, prepare_script?: string, cleanup_script?: string)` | Same name and arguments | **Keep in operator.** Treat sensitive inputs as write-only. Return a redacted profile. |
| 25 | `update_executor_profile_kandev(profile_id: string, name?: string, mcp_policy?: string, config?: object, prepare_script?: string, cleanup_script?: string)` | `update_executor_profile_kandev(executor_profile_id: string, name?: string, mcp_policy?: string, config?: SensitiveMapPatch, prepare_script?: SensitivePatch<string>, cleanup_script?: SensitivePatch<string>)` | **Change argument and patch semantics.** Omitted values stay unchanged. Explicit actions replace or clear sensitive values. |
| 26 | `delete_executor_profile_kandev(profile_id: string)` | `delete_executor_profile_kandev(executor_profile_id: string)` | **Change argument.** Qualify the profile ID. Operator catalog only. |

The proposed sensitive value shape is:

```text
SensitivePatch<T> =
  { action: "keep" }
  | { action: "replace", value: T }
  | { action: "clear" }
```

`SensitiveMapPatch` is `map<string, SensitivePatch<unknown>>`.

Create operations accept direct write-only values. Update operations use the
explicit patch shape.

### Task tools (27 through 36)

| # | Current tool and arguments | Proposed target | Change |
| ---: | --- | --- | --- |
| 27 | `list_tasks_kandev(workflow_id: string)` | `list_tasks_kandev(workflow_id?: string, task_id?: string)` | **Change arguments and result.** Require at least one filter. Add dependencies and a compact pending-action summary. |
| 28 | `move_task_kandev(task_id: string, workflow_id: string, workflow_step_id: string, position?: number, prompt?: string)` | Same name and arguments | **Keep in supervisor.** Preserve its distinct workflow concurrency rules. |
| 29 | `delete_task_kandev(task_id: string)` | Same name and arguments | **Remove from common supervisor.** Keep in a server-owned destructive group. |
| 30 | `archive_task_kandev(task_id: string)` | Same name and arguments | **Keep in supervisor.** Preserve idempotent archive behavior. |
| 31 | `update_task_state_kandev(task_id: string, state: string)` | `update_task_kandev(task_id: string, title?: string, description?: string, state?: TaskState, deferred_launch_prompt?: string)` | **Replace and deprecate old name.** State becomes one task field. |
| 32 | `get_task_conversation_kandev(task_id: string, session_id?: string, limit?: number, before?: string, after?: string, sort?: string, message_types?: string[])` | `get_task_session_conversation_kandev(task_id: string, session_id: string, limit?: number, before?: string, after?: string, sort?: "asc" \| "desc", message_types?: string[])` | **Rename and require exact session.** The old alias can keep primary-session fallback. |
| 33 | `list_task_sessions_kandev(task_id: string)` | Same name and arguments | **Keep in supervisor.** Add compact pending state to each session. |
| 34 | `create_task_kandev(CreateTaskInput)` | Same name and arguments | **Keep in supervisor.** Add structured output and capability policy. Preserve `external_id` idempotency. |
| 35 | `add_task_dependency_kandev(task_id?: string, depends_on_task_id: string)` | `add_task_dependency_kandev(task_id: string, depends_on_task_id: string)` | **Make `task_id` required for External MCP.** Move the tool to an optional dependency group. |
| 36 | `remove_task_dependency_kandev(task_id?: string, depends_on_task_id: string)` | `remove_task_dependency_kandev(task_id: string, depends_on_task_id: string)` | **Make `task_id` required for External MCP.** Move the tool to an optional dependency group. |

Current `CreateTaskInput`:

```text
parent_id?: string
workspace_id?: string
workflow_id?: string
workflow_step_id?: string
workspace_mode?: string
title: string
prompt?: string
autopilot?: boolean
agent_profile_id?: string
executor_profile_id?: string
start_agent?: boolean
repository_id?: string
local_path?: string
repository_url?: string
base_branch?: string
external_id?: string
blocked_by?: string[]
start_when_unblocked?: boolean
```

External mode does not accept `parent_id: "self"`. It requires the exact parent
task ID.

Target `TaskState` values are:

```text
CREATED
TODO
IN_PROGRESS
REVIEW
BLOCKED
WAITING_FOR_INPUT
COMPLETED
FAILED
CANCELLED
```

### Clarification and permission tools (37 through 40)

| # | Current tool and arguments | Proposed target | Change |
| ---: | --- | --- | --- |
| 37 | `list_pending_questions_kandev(workspace_id?: string, created_since?: string, cursor?: string, limit?: number)` | `list_pending_actions_kandev(workspace_id?: string, task_id?: string, session_id?: string, kind?: "clarification", created_since?: string, cursor?: string, limit?: number)` | **Replace with unified discovery.** Keep the old name as a clarification-only alias. |
| 38 | `answer_question_kandev(pending_id: string, answers?: QuestionAnswer[], rejected?: boolean, reject_reason?: string)` | `resolve_clarification_kandev(pending_id: string, answers?: QuestionAnswer[], rejected?: boolean, reject_reason?: string)` | **Rename.** Arguments and first-write-wins behavior stay unchanged. |
| 39 | `list_pending_agent_permissions_kandev(task_id: string, session_id?: string)` | `list_pending_actions_kandev(workspace_id?: string, task_id?: string, session_id?: string, kind?: "agent_permission", created_since?: string, cursor?: string, limit?: number)` | **Replace with unified discovery.** Keep the old name as a permission-only alias. |
| 40 | `resolve_agent_permission_kandev(task_id: string, session_id: string, request_id: string, pending_id: string, option_id: string)` | Same name and arguments | **Keep in supervisor.** Preserve live agentctl authority and exact immutable IDs. |

Current `QuestionAnswer`:

```text
question_id: string
selected_options?: string[]
custom_text?: string
```

`resolve_clarification_kandev` keeps `pending_id`. This ID is the durable
Resolver identity. Renaming it adds translation without improving authority.

## New canonical tools

These tools do not have a one-to-one current External MCP equivalent.

| New tool | Arguments | Purpose |
| --- | --- | --- |
| `get_task_creation_options_kandev` | `workspace_id?: string`, `workflow_id?: string`, `parent_id?: string` | Return safe repositories, workflows, agent profiles, and executor profiles for task creation. |
| `start_task_session_kandev` | `task_id: string`, `prompt: string`, `agent_profile_id?: string`, `name?: string`, `idempotency_key: string` | Start one additional session as an external user. |
| `send_task_session_message_kandev` | `task_id: string`, `session_id: string`, `prompt: string`, `delivery_mode: "queued" \| "interrupt"`, `idempotency_key: string` | Send one message to an exact session. |
| `stop_task_session_kandev` | `task_id: string`, `session_id: string` | Stop one exact session without stopping siblings. |
| `list_pending_actions_kandev` | `workspace_id?: string`, `task_id?: string`, `session_id?: string`, `kind?: "clarification" \| "agent_permission"`, `created_since?: string`, `cursor?: string`, `limit?: number` | Return one typed queue for human decisions. |

`get_task_creation_options_kandev` requires `workspace_id`, `parent_id`, or
both. A supplied workflow must belong to the effective workspace.

Session start and message use a 30-day idempotency window. Stop is naturally
idempotent for a terminal session.

`list_pending_actions_kandev` unifies discovery only. Clarification and
permission resolution remain separate operations.

## Recommended final supervisor catalog

| # | Tool |
| ---: | --- |
| 1 | `list_workspaces_kandev` |
| 2 | `list_workflows_kandev` |
| 3 | `list_tasks_kandev` |
| 4 | `get_task_creation_options_kandev` |
| 5 | `create_task_kandev` |
| 6 | `update_task_kandev` |
| 7 | `move_task_kandev` |
| 8 | `archive_task_kandev` |
| 9 | `list_task_sessions_kandev` |
| 10 | `get_task_session_conversation_kandev` |
| 11 | `start_task_session_kandev` |
| 12 | `send_task_session_message_kandev` |
| 13 | `stop_task_session_kandev` |
| 14 | `list_pending_actions_kandev` |
| 15 | `resolve_clarification_kandev` |
| 16 | `resolve_agent_permission_kandev` |

## Main breaking changes

| Area | Before | After | Required client change |
| --- | --- | --- | --- |
| Catalog | Every PAT gets the same 40 tools. | New PATs get one purpose-specific catalog. | Use separate supervisor and operator PATs. |
| Authentication | A browser session can authenticate `/mcp*`. | External MCP accepts PAT authentication only. | Configure a PAT in the MCP client. |
| Authentication disabled | Remote unauthenticated access is open. | The default is strict loopback. | Enable authentication or select remote access explicitly. |
| Configuration authority | Any authenticated identity reaches configuration handlers. | Configuration requires admin role and operator capabilities. | Use an admin operator PAT. |
| Configuration reads | Results can contain raw environment, header, script, and profile data. | External DTOs redact secret-like values. Lifecycle scripts remain operator-only. | Treat secret-like values as write-only. |
| Configuration writes | Some updates replace full objects. | Sensitive fields use `keep`, `replace`, or `clear`. | Send explicit patch actions. |
| Task state | State has a separate update tool. | `update_task_kandev` owns task state and metadata. | Replace `update_task_state_kandev`. |
| Conversation | Session is optional and can default to primary. | The canonical v2 read uses an exact session. | List sessions and send `session_id`. |
| Session changes | External MCP cannot start, message, or stop a session. | Three exact user-owned commands are available. | Use exact task and session IDs. |
| Pending discovery | Questions and permissions use separate list tools. | One discriminated union returns both kinds. | Branch on `kind`. |
| Results | Tools usually return JSON as MCP text. | Tools return `structuredContent` with `outputSchema`. | Read and validate the structured object. |
| Errors | Adapter errors become strings. | Errors keep `{code, message, retryable, details}`. | Branch on `code`, not message text. |
| MCP session | One fixed server handles every PAT. | A session binds to token, profile, catalog, and capability fingerprint. | Reconnect after token or role changes. |

Security changes apply to legacy aliases immediately. Compatibility never
preserves unauthorized configuration access or raw secret output.

## Compatibility rules

- Existing PATs receive `legacy_v1` and explicit migrated grants.
- A member legacy PAT loses configuration operations.
- An admin legacy PAT keeps authorized, redacted configuration operations.
- Old tool names call the same canonical operation as new names.
- Old argument names remain accepted during the compatibility window.
- A request cannot send both old and new names for the same argument.
- JSON text can mirror `structuredContent` during migration.
- Alias telemetry excludes arguments, results, prompts, and credentials.

Normal alias removal requires all these conditions:

- Public deprecation notice exists.
- No supported client depends on the alias.
- Observed use is zero for at least 90 days.
- Observed use is zero across two stable releases.

## Stable contracts

- Streamable HTTP remains at `/mcp`.
- SSE remains at `/mcp/sse` and `/mcp/message`.
- Workflow export remains `kandev_workflow` version 1.
- The backend continues to own catalog composition.
- Clarification remains atomic and first-write-wins.
- Permission authority remains in the live agentctl runtime.
- GitHub and GitLab tools remain provider-specific.
- Dynamic plugin tools remain outside External MCP.

## Open naming decisions

1. Is `get_task_session_conversation_kandev` clearer than the shorter current name?
2. Is exact `session_id` acceptable for every canonical conversation read?
3. Is `resolve_clarification_kandev` the correct name for answer and reject?
4. Are `agent_definition` and `executor_type` the correct resource terms?
5. Is `get_task_creation_options_kandev` clearer than a `list_*` name?
6. Do qualified profile and workflow-step IDs justify their migration cost?

## Proposed decision

Use the migration matrix as the contract review baseline. Agree on the rename
set before implementation starts.

After agreement, update the requirements and system designs with the selected
canonical names. Keep every rejected name out of the implementation plan.

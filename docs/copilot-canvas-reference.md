# GitHub Copilot App Canvas reference

**Research date:** 2026-08-25

This note records the external model that informed Kandev's collaborative
canvas design. It separates documented GitHub behavior from conclusions based
on the public sample. This distinction matters because the sample is not a
product contract.

## What a Copilot canvas is

GitHub describes Canvas as a shared interactive surface where a person and an
agent work on the same artifact. Example artifacts include plans, triage
boards, browser sessions, release checklists, dashboards, incident workspaces,
documents, and spreadsheets.

The useful concept is not the visual layout by itself. A canvas combines:

- persistent state for a work artifact
- controls that a person can use
- actions that an agent can call
- one state model behind both paths
- a surface that stays useful across turns and handoffs.

This makes a canvas a bidirectional work surface. The agent can create or
change structure, and the person can inspect or change the result without
translating every action back into chat.

## Extension shape

The official guide documents two extension scopes:

- Project scope stores an extension under `.github/extensions`. The repository
  shares the extension definition with the team.
- User scope stores an extension under `~/.copilot/extensions`. It remains
  personal to that user.

A typical extension contains `package.json`, `extension.mjs`, and optional JSON
artifacts. Users ask Copilot to create one with `/create-canvas`.

The official guide says that project extensions are team-shared. This means
the extension code travels through the repository. It does not state that
several people can edit one live canvas instance at the same time.

## Public sample runtime

The `leestott/copilot-canvas-runtime` sample demonstrates one possible runtime:

1. An extension registers a canvas and a closed set of actions.
2. Opening the canvas starts a loopback HTTP server for that instance.
3. An iframe loads the local URL.
4. Human controls send HTTP commands to the extension.
5. Agent calls invoke the same action handlers through the Canvas SDK.
6. Server-sent events send state changes to the iframe.
7. Closing the instance stops its server and deletes its in-memory state.

The sample stores state in an in-memory map. It includes actions for system
decomposition, workflow execution, validation, design updates, state tracking,
failure injection, and pause or resume. Its scenario file presents
repository-scoped multi-participant use as future work.

The sample proves the shared-action model. It does not prove durable storage,
multi-user authorization, conflict handling, or production isolation.

## Canvas is not a general UI builder

The Microsoft article presents Canvas as a development runtime and control
plane for agent workflows. Its example makes task flow, validation, state, and
human controls visible. It explicitly warns against treating Canvas as a
production application builder.

That framing is useful for Kandev. A canvas must help people direct, inspect,
and verify agent work. It must not become an unrestricted way for an agent to
ship HTML, JavaScript, or a remote application inside Kandev.

## Definition sharing and instance sharing

These are different capabilities:

| Capability | Copilot material | Kandev interpretation |
| --- | --- | --- |
| Share a canvas definition | Commit a project extension to the repository. | A future template or plugin can define reusable canvas types. |
| Share one live canvas instance | Not documented by the supplied Canvas guide. | Not included in Kandev version 1. |
| Share an agent session | GitHub supports view-only session sharing with repository collaborators. | This does not grant canvas edit access. |
| Edit together | Human and agent share one action model in the sample. | Humans and agents use one Kandev command service with actor attribution. |
| Move a canvas between users or instances | Not defined by the supplied Canvas guide. | Export and import one inert `.kandev-canvas` snapshot. |

Kandev version 1 does not implement live instance sharing. A portable export
creates an independent canvas when another user or instance imports it.

## Features worth carrying into Kandev

- A person and an agent act on the same durable artifact.
- Actions use explicit names and JSON-shaped inputs.
- The surface shows progress and validation outside the chat stream.
- The state survives turns. Portable files support asynchronous handoffs.
- A closed action model keeps human and agent behavior consistent.
- The canvas is a work surface, not a replacement application platform.

## Features not safe to copy directly

- Per-instance loopback servers do not fit a shared hosted service.
- In-memory state cannot support reload, restart, or user handoff.
- Arbitrary repository JavaScript creates a large execution and isolation
  boundary.
- An iframe does not provide Kandev's native desktop and mobile behavior.
- Repository access does not equal canvas access.
- The sample has no concurrency or conflict contract.

## Kandev version 1 scope

One user owns each canvas in one workspace. Trusted task or Office agents can
update the canvas through the shared command model. Other users cannot read or
edit it.

The owner can export the current snapshot as one `.kandev-canvas` JSON file.
An import validates the full file, assigns new identifiers, and creates a local
fork. The file contains no users, task links, events, server addresses, files,
repositories, or secrets.

## Sources

- [GitHub Docs: Working with Canvas extensions](https://docs.github.com/en/copilot/how-tos/github-copilot-app/working-with-canvas-extensions)
- [GitHub Docs: GitHub Copilot app](https://docs.github.com/en/copilot/concepts/agents/github-copilot-app)
- [GitHub Docs: Manage and track Copilot coding agent sessions](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents)
- [Microsoft: GitHub Copilot App - Canvas is not a UI builder](https://techcommunity.microsoft.com/blog/azuredevcommunityblog/github-copilot-app---canvas-is-not-a-ui-builder/4531451)
- [Public Canvas runtime sample](https://github.com/leestott/copilot-canvas-runtime)
- [Sample extension source](https://github.com/leestott/copilot-canvas-runtime/blob/main/.github/extensions/multi-agent-dev/extension.mjs)
- [Sample scenario](https://github.com/leestott/copilot-canvas-runtime/blob/main/scenario.md)

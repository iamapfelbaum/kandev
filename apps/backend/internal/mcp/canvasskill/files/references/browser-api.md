# Canvas browser API

The host exposes the Kandev canvas contract below the relative
`./_kandev/v1` base path. Resolve URLs relative to the application document;
do not use a host URL or a hard-coded port.

Use the read endpoints for domain data and the action endpoints for user
operations. Send JSON with `Content-Type: application/json` and handle a
non-2xx response as an application error. Do not retry a mutation unless the
operation is documented as idempotent.

The host can end a request when the task or canvas is no longer available.
Abort fetches during teardown and show a retry action for transient reads.
The exact endpoint details are returned by the canvas instance contract and
must be treated as authoritative for that release.

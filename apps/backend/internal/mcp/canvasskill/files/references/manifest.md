# Canvas manifest

Publish a manifest at the generated manifest path. Keep it small and use
relative asset paths.

The manifest identifies the application entry document, display metadata, and
the Kandev API contract version. A minimal shape is:

```json
{
  "manifest_version": 1,
  "name": "example-canvas",
  "title": "Example canvas",
  "entry": "index.html",
  "api_version": "v1"
}
```

The validator is authoritative for field names, path limits, and allowed
permissions. Do not request permissions that the application does not use.
Do not include absolute paths, parent-directory segments, symlinks, or build
outputs that are not referenced by the entry document.

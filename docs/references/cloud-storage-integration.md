# Cloud storage integration boundary

Novelist's current sync engine is a WebDAV protocol implementation. It relies on strong ETags, conditional PUT/DELETE, depth-one PROPFIND listings, and an account lease that keeps credentials out of project files.

OneDrive and Google Drive private storage require provider-specific OAuth and APIs:

- OneDrive uses Microsoft Graph drive-item paths and OAuth scopes such as `Files.ReadWrite.AppFolder` or `Files.ReadWrite`.
- Google Drive uses Drive v3 file IDs, `files.list` with an app-folder scope, and revision or generation validators rather than WebDAV ETags.

They cannot be safely enabled by accepting their home-page URLs as WebDAV endpoints. A complete adapter needs an OAuth redirect or device-code flow, refresh-token storage in the platform credential vault, provider-specific listing and conditional-write semantics, and an application registration for each provider. The current repository has none of those prerequisites, so the UI continues to expose the tested WebDAV path and does not claim unsupported cloud providers are connected.

The config clipboard format is provider-neutral and versioned. Once adapters are added, their non-secret account identifiers can be included in the same payload while refresh tokens remain in the platform vault.

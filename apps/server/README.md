# Catamorphic stock server

## Credential vault and provider setup

The stock server creates an AES-256-GCM credential vault under
`CATAMORPHIC_DATA_DIR/credentials`. The key and encrypted records use
owner-only permissions. Back up the key with the data volume. Losing it makes
provider connections unrecoverable.

Rotate a service credential with the authenticated
`PUT /connections/:connectionId/credential` endpoint. Rotation writes a new
encrypted record, atomically advances the connection revision, deletes the old
record, and wakes workflow calls parked on that connection. Keep old vault
wrapping keys available until all stored records have been re-encrypted.

Provider drivers and OAuth application details are deployment configuration.
The stock image does not ship a shared Slack or Google OAuth identity. Register
your own provider applications, configure their HTTPS callback URLs, and inject
their connection providers when embedding `buildStockServer`. Service accounts
are explicit project or tenant service connections and are never inferred from
a member login. Unattended workflows accept service connections only.

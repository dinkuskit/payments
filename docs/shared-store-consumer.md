# Payments Registry v2 consumer

The Registry connection is an explicit, server-owned Payments consent flow.
The default plugin uses the server-owned Payments status origin
`https://payments.dinkuskit.com/v1/status`. It never guesses a host or accepts
a browser-supplied endpoint.

Connect starts protocol v2 with the registered Payments client and service,
freezes the canonical site identity and PKCE transaction, and exposes only a
redacted, short-lived public proof receipt during consent. The receipt is
removed after completion or failure. The access token is validated against the
Registry issuer, Payments audience, canonical site ID, expiry, and
`payments:admin` scope before it is stored in the encrypted
`registry_session` setting. It is never stored in ordinary KV or rendered.

Configured status transport sends the validated token and
`X-Dinkus-Site` from the saved session to the injected endpoint. A grant alone
does not claim that a processor account is connected. The setup screen remains
**Not ready to sell** until the existing strict Payments status contract and a
Commerce TEST order are separately satisfied.

The PKCE verifier and access token are serialized into a declared EmDash secret
setting. The host must provision its encryption key. Ordinary plugin KV holds
only the transaction receipt, caller and origin binding, canonical authority,
phase, expiry and a digest of the private state. Editing the secret setting
does not establish a connection. Atomic revisions fence concurrent requests;
a lost exchange response requires a fresh explicit Connect. Canonical identity
and organization authority survive reconnect, which never silently remaps them.

The server-owned factory accepts an explicit test-only loopback configuration
for a separate local proof build. Account API and JWKS URLs remain canonical;
the proof host routes those exact requests to the real local website handler.
Operators packaging the plugin for another Payments service must override the
endpoint at build time:

```ts
createPaymentsPlugin({ endpoint: { status: "https://payments.example/v1/status" } });
```

The default export never reads an endpoint from settings, request input or
environment variables. The override is not a browser- or site-selectable
fallback; it is an explicit operator-owned build configuration.

This slice does not initiate processor setup, issue checkout grants, create
payments, verify a Commerce TEST order, or activate live service. The hosted
Payments verifier checks the signed five-minute token; it has no online grant
revocation lookup. Website revocation blocks new issuance, while an already
issued token remains usable until expiry.

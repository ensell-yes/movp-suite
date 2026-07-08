# Security Policy

MOVP is pre-1.0. Security fixes should target the current `main` branch unless a released
version policy is added later.

## Reporting

Do not open public issues containing exploit details, credentials, raw tokens, webhook
secrets, recipient emails, or private customer data. Use the maintainer's private security
contact until a public disclosure address is configured.

## Expectations

Please include:

- affected component;
- reproduction steps;
- expected impact;
- whether secrets or personal data are involved.

## Authentication Notes

The Astro template uses verified link-based authentication and stores the access token in
an httpOnly `sb-access-token` cookie. Opening a valid login link can switch the current
browser session after the token is verified, so users should only open login links they
requested.

## Secret Handling

Repository tests and docs must not contain real service-role keys, API tokens, webhook
secrets, npm tokens, or production credentials.

# Security Policy

Resili is a TypeScript resilience toolkit. Security reports are taken seriously,
especially issues that could affect cancellation, retries, failure isolation,
resource exhaustion, dependency handling, or package integrity.

## Supported Versions

There is no stable `1.0` line. Security fixes are handled on `main`. Published
packages are Beta 1 on npm `latest` / `beta` and RC2 on npm `next`.

| Version                                                                        | Supported                                                  |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `@resili/core@0.2.0-rc.2` and the matching RC2 HTTP and LLM packages on `next` | Current candidate. Report issues against this line.        |
| `@resili/core@0.2.0-beta.1` and the matching Beta 1 LLM packages on `latest`   | Default install. Fixes may land only in a newer candidate. |
| Older alpha and RC1 versions                                                   | Not a maintained security line.                            |

## Reporting a Vulnerability

Please do not disclose suspected vulnerabilities publicly before maintainers have
had a reasonable opportunity to investigate and respond.

Report vulnerabilities privately by contacting the maintainers through the
project's GitHub security advisory flow when available. If that is unavailable,
open a minimal public issue asking for a private security contact without
including exploit details.

## What to Include

A useful report should include:

- Affected package and version or commit SHA.
- A clear description of the vulnerability.
- Steps to reproduce or a minimal proof of concept.
- Expected impact and realistic attack scenario.
- Whether the issue is exploitable remotely or requires local access.
- Any known mitigations or configuration workarounds.

Please avoid including sensitive production data, credentials, tokens, or private
customer information in reports or reproductions.

## Response Expectations

Maintainers will aim to:

- Acknowledge receipt within 5 business days.
- Triage severity and reproducibility as soon as practical.
- Keep the reporter informed when there is meaningful progress.
- Coordinate disclosure timing for confirmed vulnerabilities.
- Credit reporters when requested and appropriate.

Response times may vary while the project is in early development, but verified
security issues will be prioritized over routine feature work.

## Responsible Disclosure

Please give maintainers time to investigate, prepare a fix, and publish guidance
before public disclosure. Do not use a vulnerability to access data, disrupt
services, or attack systems you do not own or have permission to test.

After a fix or mitigation is available, maintainers may publish an advisory with
affected versions, impact, remediation steps, and credit.

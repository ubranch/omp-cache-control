# Security and private reporting

[← README](README.md) · [Safety and compatibility](docs/safety-and-compatibility.md)

## Report privately

Use [GitHub private vulnerability reporting](https://github.com/ubranch/omp-cache-control/security/advisories/new) for credential disclosure, private-prompt persistence, unsafe replay/tool execution, billing that bypasses off/idle guards, or a similar security defect.

If GitHub's report form is unavailable, contact the [maintainer](https://github.com/ubranch) privately through a contact method they publish before sending sensitive details. Keep exploit details out of public issues. Ordinary sanitized bugs can use [issues](https://github.com/ubranch/omp-cache-control/issues).

Include the extension/OMP/Bun versions, API/model identifier, affected lifecycle/command, expected versus actual behavior, and a **redacted minimal reproduction**. Never include API keys, authentication headers, full private prompts, user config, session transcripts, or raw diagnostic captures. Describe sensitive evidence first and agree on a safe transfer method if it is needed.

## Immediate containment

1. Run `/cache off` to hide status, cancel active maintenance, and suspend future extension refreshes in the current process.
2. Fully exit OMP if there is uncertainty about an in-flight request. Already-sent provider work or charges cannot be undone.
3. Uninstall the plugin before future launches if persistent disablement is needed. Removing it restores OMP's own native warmer policy; review that policy separately.
4. Rotate compromised credentials at the provider if they were exposed, and review that provider's request/billing records.

## Scope and expectations

This repository distributes a trusted local OMP extension, not a sandbox. It sends eligible captured prefixes to the configured provider for maintenance, whose privacy/billing policy still applies. Snapshots stay in memory and warm replies do not enter chat history, but unrelated extensions and native foreground logging can affect the broader environment.

Security corrections target the current release line. No response-time SLA, bounty, or support for every historic host/provider version is promised. Keep a report private until a fix and disclosure plan are agreed.

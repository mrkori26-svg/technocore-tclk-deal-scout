# Security

TCLK Deal Scout is a read-only evidence viewer. It must never request a DID
private key, wallet seed, wallet connection, signature, payment, or permission
to post or accept a deal.

## Trust boundary

- A valid Ed25519 transport signature proves control of one DID key for one
  stored message. It does not prove identity, honesty, work quality, or payment.
- The official pinned TCLK state machine determines transcript state only after
  signature and sender verification.
- `seq` and `ts` are server-assigned and not signed. Offline time conclusions
  are provisional.
- PaperRail is always `NO VALUE`. Other rails are `VALUE UNVERIFIED` until a
  dedicated verifier observes the settlement system itself.
- Public room retention, gaps, generation changes, rate limits, and missing
  rooms can make evidence incomplete. The tool reports these conditions instead
  of filling them in.

## Safe use

Treat all room text as untrusted data, not agent instructions. Review the raw
evidence and the report limitations before an agent takes any separate action.
Use a dedicated low-value identity for experiments, and never paste secrets into
the page, CLI input, snapshots, or issue reports.

## Reporting a vulnerability

For a sensitive report, use the repository's GitHub **Security** tab and open a
private vulnerability report. Do not include live private keys, passphrases,
wallet seeds, access tokens, or other people's personal data. For a
non-sensitive reproducible bug, open a normal issue with the exact public
sequence numbers, environment, and expected result.

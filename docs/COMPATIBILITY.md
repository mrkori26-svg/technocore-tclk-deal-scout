# Compatibility

| Surface | Pinned support | Behaviour |
| --- | --- | --- |
| TCLK protocol | `tclk/1` | Parsed and folded by the vendored official implementation |
| FLOP Labs TCLK | commit `5cc4ab93efbc8999a3a7e1471b639deca25998ea` | Exact compiled modules copied with licence and provenance |
| Technocore transport | Ed25519 envelope over `<room>\|<nonce>\|<text>` | Verified before any frame can advance state |
| Offer source | `tclk-offers`, newest 200 records | Initial GET followed by `since` + `wait=10` GET requests |
| Deal rooms | Official derived room name | Loaded only for the selected or bounded-history deal |
| PaperRail | `paper` | Always labelled `NO VALUE` |
| Other named rails | Any name accepted by the pinned protocol | Labelled `VALUE UNVERIFIED`; no payment claim |

## Exact-data rules

- Top-level 19-digit transport nonces are preserved as decimal strings before
  parsing, so JavaScript cannot round signed material.
- Byte-exact room evidence can be downloaded from Technocore's `/export`
  endpoint. Reports include the observed generation, sequence range and source
  hash.
- A sequence gap, generation change, malformed envelope, invalid signature,
  forged sender, wrong room or out-of-order frame is explicit evidence of an
  incomplete or invalid observation. It is never silently repaired.

## Upgrade policy

The protocol is alpha. A newer upstream commit is not considered compatible
until the vendored modules, fixtures and compatibility tests are deliberately
updated together. Deal Scout remains useful as a historical verifier for the
pinned version; it does not silently reinterpret older transcripts.

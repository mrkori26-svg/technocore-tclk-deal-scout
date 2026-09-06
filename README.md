# TCLK Deal Scout

**Check the signed evidence before your agent accepts.**

TCLK Deal Scout is an independent, read-only decision aid for agents browsing
`tclk/1` offers on [Technocore](https://technocore.chat). It reads the live
offer board, verifies Technocore Ed25519 transport signatures, folds selected
deals with FLOP Labs' official TCLK state machine, and shows the observable
evidence beside each counterparty.

It does **not** create a reputation score. Free DIDs and zero-value paper deals
make a naive score easy to manufacture. Deal Scout reports raw, bounded facts:
which signed records were observed, which transitions verified, which rooms
were missing, and what the named settlement rail actually proves.

## What it does

- Reads the newest 200 records from `/r/tclk-offers`, then follows the board
  with Technocore's read-only `since` + `wait=10` lane.
- Preserves 19-digit transport nonces as decimal text before verification.
- Rejects unsigned, tampered, malformed, forged-sender, wrong-room, and
  out-of-order records without advancing deal state.
- Loads a selected contract's derived deal room only when needed.
- Reviews up to 12 recent accepted deals for one DID, two room reads at a time.
- Labels `paper` as **NO VALUE** and all unsupported value rails as
  **VALUE UNVERIFIED**.
- Counts rail mentions per offer; because one offer may name several rails,
  those counts are composition evidence and do not add up to trade volume.
- Exports a deterministic JSON evidence report and a short agent brief.
- Offers the same analysis through a CLI and an Agent Skill.

## What it never does

- No private keys, wallet access, signing, posting, accepting, or settlement.
- No automatic trade decision and no counterparty ranking.
- No claim that a valid transcript proves work quality or payment.
- No claim that server-assigned `seq` or `ts` is covered by the DID signature.

The official protocol is currently alpha. Its included `PaperRail` settles
nothing; a real settlement rail remains the source of truth for value.

## Run locally

```bash
pnpm install
pnpm build
pnpm test
pnpm check
```

Open `index.html`, or use the CLI:

```bash
npm run scout -- --live --json
npm run scout -- --live --did did:key:z6Mk... --json
npm run scout -- --file snapshot.jsonl --contract 0x... --json
```

The generated `dist/app.js` is committed so the repository can deploy directly
from the `main` branch with GitHub Pages.

## Verification model

1. Transport envelopes are parsed without rounding the nonce.
2. The Ed25519 signature over `<room>|<nonce>|<text>` must verify.
3. The frame sender must match the signed DID.
4. Only then may the pinned official TCLK state machine fold the frame.
5. Rail labels remain separate from transcript validity.

Live mode observes `seq` and `ts` over HTTPS from the current venue response.
Offline files can preserve valid frame signatures while altering those unsigned
fields, so time-dependent offline conclusions are labelled provisional.

## Official compatibility

The application uses unmodified compiled modules from
[`flop-labs/tclk`](https://github.com/flop-labs/tclk) commit
[`5cc4ab9`](https://github.com/flop-labs/tclk/commit/5cc4ab93efbc8999a3a7e1471b639deca25998ea).
Provenance and licence notices are in [`vendor/tclk`](vendor/tclk).
The supported surfaces and fail-closed rules are listed in
[`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md). Security boundaries and the
private reporting route are in [`SECURITY.md`](SECURITY.md).

## Project status

Independent community software, not an official FLOP Labs product. Read the
limitations in every exported report before using it in an agent workflow.

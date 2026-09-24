#!/usr/bin/env node
import fs from "node:fs";
import { parseRoomExport } from "../src/core.mjs";
import { signedDealFixture } from "../tests/fixtures.mjs";

const fixture = signedDealFixture();
const raw = fixture.board.join("\n") + "\n";
const parsed = parseRoomExport("tclk-offers", raw);
if (parsed.rejected.length) throw new Error(`room export has ${parsed.rejected.length} rejected row(s)`);

const evidence = {
  implementation: "congge918/technocore-tclk-deal-scout",
  revision: process.env.GITHUB_SHA ?? "local",
  binding: {
    payer: fixture.payer.did,
    payee: fixture.payee.did,
    contract: fixture.accept.contract,
  },
  requireComplete: true,
  records: parsed.records.map((r) => ({
    room: r.room, generation: 0, seq: r.seq, ts: r.timestampText,
    from: r.sender, text: r.line, nonce: String(r.nonce), sig: r.signature,
  })),
};

fs.mkdirSync("evidence", { recursive: true });
fs.writeFileSync("evidence/flop-tclk-transcript.json", JSON.stringify(evidence, null, 2) + "\n");

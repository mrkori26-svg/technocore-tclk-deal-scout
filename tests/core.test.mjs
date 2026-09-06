import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeBoard,
  compileCounterpartyEvidence,
  createReport,
  inspectCandidate,
  parseRoomExport,
} from "../src/core.mjs";
import { LARGE_NONCE, signedDealFixture } from "./fixtures.mjs";

test("preserves and verifies a signed 19-digit transport nonce", () => {
  const fixture = signedDealFixture();
  const parsed = parseRoomExport("tclk-offers", fixture.board.join("\n"));
  const board = analyzeBoard(parsed.records, parsed.rejected);

  assert.equal(parsed.records[0].nonce, LARGE_NONCE);
  assert.equal(board.summary.transportVerified, 2);
  assert.equal(board.summary.invalid, 0);
  assert.equal(board.candidates[0].status, "accepted");
});

test("folds a selected signed deal and never treats PaperRail as value", () => {
  const fixture = signedDealFixture();
  const boardParsed = parseRoomExport("tclk-offers", fixture.board.join("\n"));
  const detailParsed = parseRoomExport(fixture.room, fixture.details.join("\n"));
  const board = analyzeBoard(boardParsed.records);
  const inspection = inspectCandidate(board.candidates[0], detailParsed.records, {
    detailLoaded: true,
    sourceMode: "live",
  });

  assert.equal(inspection.status, "claimed");
  assert.equal(inspection.rail.status, "NO_VALUE");
  assert.deepEqual(inspection.events.map((event) => event.ok), [true, true, true, true, true]);
});

test("tampering with signed text cannot advance state", () => {
  const fixture = signedDealFixture();
  const tampered = fixture.board[0].replace("2500000", "2500001");
  const parsed = parseRoomExport("tclk-offers", `${tampered}\n${fixture.board[1]}`);
  const board = analyzeBoard(parsed.records);

  assert.equal(board.summary.offers, 0);
  assert.ok(board.findings.some((finding) => /signature does not verify/.test(finding.reason)));
});

test("counterparty evidence reports raw role-specific counts without a score", () => {
  const fixture = signedDealFixture();
  const boardParsed = parseRoomExport("tclk-offers", fixture.board.join("\n"));
  const detailParsed = parseRoomExport(fixture.room, fixture.details.join("\n"));
  const board = analyzeBoard(boardParsed.records);
  const details = new Map([[fixture.room, { records: detailParsed.records, loaded: true, missing: false }]]);
  const evidence = compileCounterpartyEvidence(board.candidates, fixture.payer.did, details);

  assert.equal(evidence.acceptedAsPayer, 1);
  assert.equal(evidence.payerLocksObserved, 1);
  assert.equal(evidence.terminalDealsObserved, 1);
  assert.equal("score" in evidence, false);
});

test("report id is deterministic for the same snapshot", async () => {
  const fixture = signedDealFixture();
  const parsed = parseRoomExport("tclk-offers", fixture.board.join("\n"));
  const board = analyzeBoard(parsed.records);
  const source = { ...parsed.source, mode: "file", baseUrl: null };
  const first = await createReport({ board, source });
  const second = await createReport({ board, source });

  assert.equal(first.reportId, second.reportId);
  assert.equal(first.source.snapshotSha256, second.source.snapshotSha256);
  assert.ok(first.limitations.some((item) => /Offline timestamp-dependent state is provisional/.test(item)));
});


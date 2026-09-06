#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import {
  OFFER_ROOM,
  analyzeBoard,
  compileCounterpartyEvidence,
  createAgentBrief,
  createReport,
  inspectCandidate,
  isContract,
  isDid,
  parseOfflineInput,
} from "../src/core.mjs";
import { fetchRoomExport, fetchRoomWindow, mapWithConcurrency } from "../src/client.mjs";

const args = parseArgs(process.argv.slice(2));
if (args.help || (!args.live && !args.file)) {
  printHelp();
  process.exit(args.help ? 0 : 1);
}

try {
  const parsed = args.live
    ? await fetchRoomWindow(OFFER_ROOM, { limit: 200, baseUrl: args.baseUrl })
    : parseOfflineInput(await readFile(args.file, "utf8"), OFFER_ROOM);
  const boardRecords = parsed.records.filter((record) => record.room === OFFER_ROOM);
  const board = analyzeBoard(boardRecords, parsed.rejected);
  const detailByRoom = new Map();

  if (!args.live) {
    for (const record of parsed.records) {
      if (record.room === OFFER_ROOM) continue;
      const detail = detailByRoom.get(record.room) ?? { records: [], loaded: true, missing: false };
      detail.records.push(record);
      detailByRoom.set(record.room, detail);
    }
  }

  let candidate = null;
  if (args.contract) {
    if (!isContract(args.contract)) throw new Error("--contract must be 0x plus 64 lowercase hex characters");
    candidate = board.candidates.find((item) => item.contractId === args.contract || item.offerId === args.contract) ?? null;
    if (!candidate) throw new Error("Contract or offer was not found in the current board window");
  }

  if (args.live && candidate?.dealRoom) {
    detailByRoom.set(candidate.dealRoom, await loadRoom(candidate.dealRoom, args.baseUrl));
  }

  let evidence = null;
  if (args.did) {
    if (!isDid(args.did)) throw new Error("--did must be an Ed25519 did:key");
    const related = board.candidates
      .filter((item) => item.acceptRow && (item.payerDid === args.did || item.payeeDid === args.did))
      .slice(0, 12);
    if (args.live) {
      const missing = related.filter((item) => !detailByRoom.has(item.dealRoom));
      const loaded = await mapWithConcurrency(missing, 2, (item) => loadRoom(item.dealRoom, args.baseUrl));
      loaded.forEach((result, index) => {
        const room = missing[index].dealRoom;
        detailByRoom.set(room, result.ok
          ? result.value
          : { records: [], loaded: true, missing: true, error: result.error?.message ?? "read failed" });
      });
    }
    evidence = compileCounterpartyEvidence(board.candidates, args.did, detailByRoom, {
      sourceMode: args.live ? "live" : "file",
    });
  }

  const inspection = candidate
    ? inspectCandidate(candidate, detailByRoom.get(candidate.dealRoom)?.records ?? [], {
      detailLoaded: candidate.dealRoom ? detailByRoom.has(candidate.dealRoom) : true,
      sourceMode: args.live ? "live" : "file",
    })
    : null;
  const source = {
    ...parsed.source,
    mode: args.live ? "live" : "file",
    baseUrl: args.live ? (args.baseUrl ?? "https://technocore.chat") : null,
  };
  const report = await createReport({ board, source, candidate, inspection, evidence });

  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printHuman(board, inspection, evidence);
} catch (error) {
  console.error(`Deal Scout: ${error instanceof Error ? error.message : "unknown failure"}`);
  process.exit(1);
}

async function loadRoom(room, baseUrl) {
  const result = await fetchRoomExport(room, { baseUrl });
  return {
    records: result.records,
    loaded: true,
    missing: result.records.length === 0,
    generation: result.source.generation,
  };
}

function parseArgs(values) {
  const parsed = { live: false, json: false, file: null, did: null, contract: null, baseUrl: undefined, help: false };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--live") parsed.live = true;
    else if (value === "--json") parsed.json = true;
    else if (value === "--help" || value === "-h") parsed.help = true;
    else if (["--file", "--did", "--contract", "--base-url"].includes(value)) {
      const next = values[index + 1];
      if (!next) throw new Error(`${value} requires a value`);
      index += 1;
      if (value === "--file") parsed.file = next;
      if (value === "--did") parsed.did = next;
      if (value === "--contract") parsed.contract = next;
      if (value === "--base-url") parsed.baseUrl = next;
    } else throw new Error(`Unknown argument: ${value}`);
  }
  if (parsed.live && parsed.file) throw new Error("Use either --live or --file, not both");
  return parsed;
}

function printHuman(board, inspection, evidence) {
  console.log(`TCLK Deal Scout: ${board.summary.offers} offers, ${board.summary.accepted} accepted, ${board.summary.invalid} findings`);
  console.log(`Rail mentions (offers may list more than one): ${Object.entries(board.summary.rails).map(([rail, count]) => `${rail}=${count}`).join(", ") || "none"}`);
  if (inspection) console.log(`\n${createAgentBrief(inspection, evidence)}`);
  else if (evidence) console.log(`\nObserved ${evidence.observedAcceptedDeals} accepted deals for ${evidence.did}; ${evidence.terminalDealsObserved} terminal, ${evidence.missingRooms} rooms missing.`);
  else console.log("Pass --contract or --did for a focused evidence report.");
}

function printHelp() {
  console.log(`TCLK Deal Scout (read-only)\n\nUsage:\n  npm run scout -- --live [--did <did:key>] [--contract <0x...>] [--json]\n  npm run scout -- --file <snapshot> [--did <did:key>] [--contract <0x...>] [--json]\n\nOptions:\n  --base-url <https://...>  Alternate Technocore-compatible venue\n  --help                    Show this help\n\nThe command never signs, posts, accepts, or settles a deal.`);
}

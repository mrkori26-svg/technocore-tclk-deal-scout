import {
  decodeFrame,
  dealRoom,
  foldTranscript,
  transcriptRecord,
  verifyTranscriptRecord,
} from "../vendor/tclk/index.js";

export const REPORT_SCHEMA = "technocore.tclk.deal-scout.v1";
export const TCLK_UPSTREAM_COMMIT = "5cc4ab93efbc8999a3a7e1471b639deca25998ea";
export const OFFER_ROOM = "tclk-offers";
export const MAX_HISTORY_ROOMS = 12;

const TERMINAL = new Set(["claimed", "refunded", "cancelled"]);
const ACTIVE = new Set(["proposed", "accepted", "locked"]);
const ROOM = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const CONTRACT = /^0x[0-9a-f]{64}$/;
const DID = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{43,44}$/;

/**
 * Technocore permits a 19-digit nonce, which JSON.parse rounds above 2^53.
 * In a venue response, message.text escapes its inner JSON quotes, so this
 * pattern reaches envelope nonce values without rewriting a TCLK frame body.
 */
export function parseLosslessJson(raw) {
  const protectedNonce = String(raw).replace(
    /("nonce"\s*:\s*)([0-9]{1,19})(?=\s*[,}])/g,
    '$1"$2"',
  );
  return JSON.parse(protectedNonce);
}

export function parseRoomWindow(room, raw, options = {}) {
  requireRoom(room);
  const value = parseLosslessJson(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Technocore response is not an object");
  }
  if (!Array.isArray(value.messages)) {
    throw new Error("Technocore response has no messages array");
  }

  const rejected = [];
  const records = [];
  value.messages.forEach((message, index) => {
    try {
      records.push(recordFromEnvelope(room, message));
    } catch (error) {
      rejected.push({
        room,
        seq: safeSeq(message?.seq),
        reason: cleanError(error),
        stage: "ENVELOPE",
        index,
      });
    }
  });

  const firstSeq = safeSeq(value.first_seq) ?? records[0]?.seq ?? null;
  const lastSeq = safeSeq(value.last_seq) ?? records.at(-1)?.seq ?? 0;
  const gaps = [];
  if (
    Number.isSafeInteger(options.expectedSince)
    && firstSeq !== null
    && firstSeq > options.expectedSince + 1
  ) {
    gaps.push(`Expected sequence ${options.expectedSince + 1}, received ${firstSeq}.`);
  }

  return {
    records,
    rejected,
    source: {
      room,
      generation: value.generation ?? options.generation ?? null,
      firstSeq,
      lastSeq,
      gaps,
      waitHeld: value.wait_held ?? null,
      snapshotText: records.map((record) => record.sourceLine).join("\n"),
    },
  };
}

export function parseRoomExport(room, raw, options = {}) {
  requireRoom(room);
  const records = [];
  const rejected = [];

  String(raw).split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const envelope = parseLosslessJson(line);
      records.push(recordFromEnvelope(room, envelope, line));
    } catch (error) {
      rejected.push({
        room,
        seq: index + 1,
        reason: cleanError(error),
        stage: "ENVELOPE",
        index,
      });
    }
  });

  return {
    records,
    rejected,
    source: {
      room,
      generation: options.generation ?? null,
      firstSeq: records[0]?.seq ?? null,
      lastSeq: records.at(-1)?.seq ?? null,
      gaps: sequenceGaps(records),
      waitHeld: null,
      snapshotText: String(raw).replace(/\r\n/g, "\n").replace(/\n$/, ""),
    },
  };
}

export function parseOfflineInput(raw, defaultRoom = OFFER_ROOM) {
  const text = String(raw);
  const trimmed = text.trim();
  if (!trimmed) return parseRoomExport(defaultRoom, "");

  try {
    const value = parseLosslessJson(trimmed);
    if (value && typeof value === "object" && Array.isArray(value.messages)) {
      return parseRoomWindow(value.room ?? defaultRoom, trimmed);
    }
  } catch {
    // A complete JSON object is optional; continue with JSONL/mixed-room parsing.
  }

  let room = defaultRoom;
  const records = [];
  const rejected = [];
  const sourceLines = [];
  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;
    const header = line.match(/^#\s*room:\s*([a-z0-9][a-z0-9_-]{0,47})$/i);
    if (header) {
      room = header[1].toLowerCase();
      sourceLines.push(`# room:${room}`);
      return;
    }
    try {
      const envelope = parseLosslessJson(line);
      const envelopeRoom = envelope.room ?? room;
      const record = recordFromEnvelope(envelopeRoom, envelope, line);
      records.push(record);
      sourceLines.push(line);
    } catch (error) {
      rejected.push({
        room,
        seq: index + 1,
        reason: cleanError(error),
        stage: "ENVELOPE",
        index,
      });
    }
  });

  return {
    records,
    rejected,
    source: {
      room: defaultRoom,
      generation: null,
      firstSeq: records[0]?.seq ?? null,
      lastSeq: records.at(-1)?.seq ?? null,
      gaps: [],
      waitHeld: null,
      snapshotText: sourceLines.join("\n"),
    },
  };
}

export function mergeRecordWindows(current, incoming, limit = 200) {
  const byKey = new Map();
  [...current, ...incoming].forEach((record) => {
    byKey.set(`${record.room}:${record.seq}`, record);
  });
  return [...byKey.values()]
    .sort((a, b) => a.seq - b.seq)
    .slice(-limit);
}

export function analyzeBoard(records, envelopeFindings = [], options = {}) {
  const rows = records.map((record, index) => authenticate(record, index));
  const findings = [
    ...envelopeFindings,
    ...rows.filter((row) => !row.ok).map((row) => toFinding(row)),
  ];
  const candidates = [];
  const byOffer = new Map();

  for (const row of rows) {
    if (!row.ok) continue;
    if (row.record.room !== OFFER_ROOM) {
      findings.push(toFinding(row, `Board scan ignores records outside ${OFFER_ROOM}.`));
      continue;
    }
    if (row.frame.type === "offer") {
      if (byOffer.has(row.frame.id)) {
        findings.push(toFinding(row, "Duplicate offer id; first authenticated offer retained."));
        continue;
      }
      const candidate = candidateFromOffer(row, options.nowMs ?? Date.now());
      candidates.push(candidate);
      byOffer.set(row.frame.id, candidate);
      continue;
    }
    if (row.frame.type === "accept") {
      const candidate = byOffer.get(row.frame.ref);
      if (!candidate) {
        findings.push(toFinding(row, "Accept has no preceding authenticated offer in this window."));
        continue;
      }
      if (candidate.acceptRow) {
        findings.push(toFinding(row, "Additional accept was not selected by append order."));
        continue;
      }
      const folded = foldTranscript([candidate.offerRow.record, row.record]);
      if (!folded.steps[1]?.ok) {
        findings.push(toFinding(row, folded.steps[1]?.reason ?? "Accept did not fold."));
        continue;
      }
      candidate.acceptRow = row;
      candidate.contractId = row.frame.contract;
      candidate.dealRoom = dealRoom(row.frame.contract);
      candidate.status = "accepted";
      candidate.payerDid = folded.state?.payerDid ?? null;
      candidate.payeeDid = folded.state?.payeeDid ?? null;
      continue;
    }

    const candidate = row.frame.contract
      ? candidates.find((item) => item.contractId === row.frame.contract)
      : null;
    if (candidate) candidate.boardExtras.push(row);
    findings.push(toFinding(
      row,
      `${row.frame.type} is in ${OFFER_ROOM}; the pinned tclk/1 fold expects post-accept frames in the derived deal room.`,
    ));
  }

  candidates.sort((a, b) => b.offerRow.record.seq - a.offerRow.record.seq);
  const railCounts = {};
  candidates.forEach((candidate) => {
    candidate.offer.rails.forEach((rail) => {
      railCounts[rail] = (railCounts[rail] ?? 0) + 1;
    });
  });

  return {
    candidates,
    findings,
    rows,
    summary: {
      records: records.length + envelopeFindings.length,
      transportVerified: rows.filter((row) => row.ok).length,
      offers: candidates.length,
      open: candidates.filter((candidate) => candidate.status === "proposed").length,
      accepted: candidates.filter((candidate) => candidate.status === "accepted").length,
      invalid: findings.length,
      rails: railCounts,
    },
  };
}

export function inspectCandidate(candidate, dealRecords = [], options = {}) {
  if (!candidate) return null;
  const detailRows = dealRecords.map((record, index) => authenticate(record, index));
  const relevant = [candidate.offerRow, candidate.acceptRow]
    .filter(Boolean)
    .concat(detailRows.filter((row) => row.ok && row.frame.contract === candidate.contractId));
  const findings = detailRows
    .filter((row) => !row.ok || row.frame.contract !== candidate.contractId)
    .map((row) => row.ok
      ? toFinding(row, "Frame names a different contract.")
      : toFinding(row));

  const folded = foldTranscript(relevant.map((row) => row.record));
  const events = folded.steps.map((step, index) => {
    const row = relevant[index];
    if (!step.ok) findings.push(toFinding(row, step.reason));
    return {
      type: step.type ?? row?.frame?.type ?? "record",
      ok: step.ok,
      reason: step.reason ?? null,
      room: step.room,
      seq: step.seq,
      did: row?.record?.sender ?? null,
      timestamp: row?.record?.timestampText ?? null,
      timestampTrust: options.sourceMode === "file" ? "UNSIGNED_PROVISIONAL" : "VENUE_OBSERVED_UNSIGNED",
    };
  });

  const state = folded.state;
  const status = state?.status ?? "invalid";
  return {
    offerId: candidate.offerId,
    contractId: state?.contract ?? candidate.contractId,
    dealRoom: candidate.dealRoom,
    status,
    active: ACTIVE.has(status),
    terminal: TERMINAL.has(status),
    nextAction: nextAction(status),
    payerDid: state?.payerDid ?? candidate.payerDid,
    payeeDid: state?.payeeDid ?? candidate.payeeDid,
    offer: publicOffer(candidate.offer),
    accept: candidate.acceptRow?.frame ?? null,
    rail: railVerdict(state?.rail ?? null, candidate.offer.rails),
    detailLoaded: Boolean(options.detailLoaded),
    detailRecordCount: dealRecords.length,
    events,
    findings,
    timeBasis: options.sourceMode === "file" ? "UNSIGNED_PROVISIONAL" : "VENUE_OBSERVED_UNSIGNED",
  };
}

export function acceptedCandidatesForDid(candidates, did, limit = MAX_HISTORY_ROOMS) {
  if (!isDid(did)) return [];
  return candidates
    .filter((candidate) => candidate.acceptRow && (candidate.payerDid === did || candidate.payeeDid === did))
    .sort((a, b) => b.acceptRow.record.seq - a.acceptRow.record.seq)
    .slice(0, limit);
}

export function compileCounterpartyEvidence(candidates, did, detailByRoom, options = {}) {
  const observed = acceptedCandidatesForDid(candidates, did, options.limit ?? MAX_HISTORY_ROOMS);
  const deals = observed.map((candidate) => {
    const detail = detailByRoom.get(candidate.dealRoom);
    const inspection = inspectCandidate(candidate, detail?.records ?? [], {
      detailLoaded: detail?.loaded ?? false,
      sourceMode: options.sourceMode ?? "live",
    });
    const acceptedAs = candidate.payerDid === did ? "payer" : "payee";
    const acceptedEvents = inspection.events.filter((event) => event.ok);
    return {
      offerId: candidate.offerId,
      contractId: candidate.contractId,
      room: candidate.dealRoom,
      role: acceptedAs,
      status: inspection.status,
      roomLoaded: detail?.loaded ?? false,
      roomMissing: detail?.missing ?? false,
      lockObserved: acceptedEvents.some((event) => event.type === "lock" && event.did === did),
      revealObserved: acceptedEvents.some((event) => event.type === "reveal" && event.did === did),
      receiptObserved: acceptedEvents.some((event) => event.type === "receipt" && event.did === did),
      findings: inspection.findings.length,
    };
  });

  return {
    did,
    observedAcceptedDeals: deals.length,
    acceptedAsPayer: deals.filter((deal) => deal.role === "payer").length,
    payerLocksObserved: deals.filter((deal) => deal.role === "payer" && deal.lockObserved).length,
    acceptedAsPayee: deals.filter((deal) => deal.role === "payee").length,
    payeeRevealsObserved: deals.filter((deal) => deal.role === "payee" && deal.revealObserved).length,
    receiptsByDidObserved: deals.filter((deal) => deal.receiptObserved).length,
    terminalDealsObserved: deals.filter((deal) => TERMINAL.has(deal.status)).length,
    missingRooms: deals.filter((deal) => deal.roomMissing).length,
    unqueriedRooms: deals.filter((deal) => !deal.roomLoaded).length,
    deals,
    interpretation: "Raw observations from the supplied retention window. No reputation score is produced.",
  };
}

export async function createReport({ board, source, candidate = null, inspection = null, evidence = null }) {
  const snapshotText = source.snapshotText ?? "";
  const snapshotSha256 = await sha256Hex(snapshotText);
  const deterministic = {
    schema: REPORT_SCHEMA,
    protocol: { name: "tclk/1", upstreamCommit: TCLK_UPSTREAM_COMMIT },
    source: {
      mode: source.mode ?? "file",
      baseUrl: source.baseUrl ?? null,
      room: source.room ?? OFFER_ROOM,
      generation: source.generation ?? null,
      firstSeq: source.firstSeq ?? null,
      lastSeq: source.lastSeq ?? null,
      snapshotSha256,
      recordCount: board.summary.records,
      gaps: source.gaps ?? [],
    },
    summary: board.summary,
    deal: inspection ? sanitizeInspection(inspection) : candidate ? {
      offerId: candidate.offerId,
      contractId: candidate.contractId,
      status: candidate.status,
    } : null,
    evidence,
    limitations: reportLimitations(source, inspection, evidence),
  };
  const reportId = `sha256:${await sha256Hex(stableStringify(deterministic))}`;
  return {
    ...deterministic,
    reportId,
    generatedAt: new Date().toISOString(),
  };
}

export function createAgentBrief(inspection, evidence = null) {
  if (!inspection) return "No TCLK deal is selected.";
  const lines = [
    `TCLK DEAL SCOUT | ${inspection.status.toUpperCase()} | ${inspection.offerId}`,
    `Contract: ${inspection.contractId ?? "pending"}`,
    `Rail: ${inspection.rail.status} (${inspection.rail.detail})`,
    `Transport/state events accepted: ${inspection.events.filter((event) => event.ok).length}/${inspection.events.length}`,
    `Next protocol action: ${inspection.nextAction}`,
  ];
  if (evidence) {
    lines.push(
      `Counterparty evidence: ${evidence.terminalDealsObserved} terminal of ${evidence.observedAcceptedDeals} observed accepted deals; ${evidence.missingRooms} rooms missing.`,
    );
  }
  lines.push("This is bounded read-only evidence, not a reputation score or payment proof.");
  return lines.join("\n");
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map(
    (key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`,
  ).join(",")}}`;
}

export async function sha256Hex(value) {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(value)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function isDid(value) {
  return typeof value === "string" && DID.test(value);
}

export function isContract(value) {
  return typeof value === "string" && CONTRACT.test(value);
}

function recordFromEnvelope(room, envelope, sourceLine = null) {
  const value = { ...envelope };
  delete value.room;
  const record = transcriptRecord(room, value);
  return {
    ...record,
    timestampText: value.ts,
    sourceLine: sourceLine ?? stableStringify(value),
  };
}

function authenticate(record, index) {
  const verification = verifyTranscriptRecord(record);
  if (!verification.ok) {
    return { index, record, frame: null, ok: false, reason: verification.reason, stage: "SIGNATURE" };
  }
  let frame;
  try {
    frame = decodeFrame(record.line);
  } catch (error) {
    return { index, record, frame: null, ok: false, reason: cleanError(error), stage: "FRAME" };
  }
  if (frame.from !== record.sender) {
    return {
      index,
      record,
      frame,
      ok: false,
      reason: `${frame.type}.from does not match the signed DID.`,
      stage: "ATTRIBUTION",
    };
  }
  return { index, record, frame, ok: true, reason: null, stage: "VERIFIED" };
}

function candidateFromOffer(row, nowMs) {
  const offer = row.frame;
  return {
    offerId: offer.id,
    contractId: null,
    dealRoom: null,
    status: "proposed",
    deadline: nowMs >= offer.expiresMs ? "PAST_LOCAL_DEADLINE" : "OPEN_BY_LOCAL_CLOCK",
    payerDid: offer.role === "payer" ? offer.from : null,
    payeeDid: offer.role === "payee" ? offer.from : null,
    offer,
    offerRow: row,
    acceptRow: null,
    boardExtras: [],
  };
}

function publicOffer(offer) {
  return {
    id: offer.id,
    from: offer.from,
    role: offer.role,
    amount: offer.amount,
    asset: offer.asset,
    lock: offer.lock,
    rails: offer.rails,
    job: offer.job ?? null,
    expiresMs: offer.expiresMs,
    claimByMs: offer.claimByMs,
    refundAfterMs: offer.refundAfterMs,
  };
}

function railVerdict(selectedRail, offeredRails) {
  if (selectedRail === "paper") {
    return { id: "paper", status: "NO_VALUE", detail: "PaperRail rehearses the protocol and settles nothing." };
  }
  if (selectedRail) {
    return { id: selectedRail, status: "VALUE_UNVERIFIED", detail: "The coordination record names this rail; Deal Scout does not verify its value state." };
  }
  const onlyPaper = offeredRails.length > 0 && offeredRails.every((rail) => rail === "paper");
  return onlyPaper
    ? { id: null, status: "NO_VALUE", detail: "The offer lists only PaperRail, which settles nothing." }
    : { id: null, status: "NOT_LOCKED", detail: "No rail lock is established. Offered non-paper rails remain unverified." };
}

function nextAction(status) {
  const actions = {
    proposed: "A counterparty may review and accept before the offer deadline.",
    accepted: "The payer must establish and announce a lock on an offered rail.",
    locked: "The payee may reveal before refundAfterMs; otherwise the payer waits to refund.",
    claimed: "The coordination transcript reached claimed; verify the rail separately.",
    refunded: "The coordination transcript reached refunded; verify the rail separately.",
    cancelled: "The coordination transcript ended before a lock was established.",
  };
  return actions[status] ?? "The authenticated records did not establish a valid TCLK state.";
}

function sanitizeInspection(inspection) {
  return {
    offerId: inspection.offerId,
    contractId: inspection.contractId,
    dealRoom: inspection.dealRoom,
    status: inspection.status,
    payerDid: inspection.payerDid,
    payeeDid: inspection.payeeDid,
    offer: inspection.offer,
    rail: inspection.rail,
    timeBasis: inspection.timeBasis,
    events: inspection.events,
    findings: inspection.findings,
  };
}

function reportLimitations(source, inspection, evidence) {
  const limitations = [
    "A valid Technocore signature proves control of a DID key for one stored message, not identity, honesty, work quality, or payment.",
    "PaperRail is a no-value rehearsal rail. Other rails are not value-verified by this version.",
    "Counts cover only records retained and fetched from the stated source window; they are not global reputation.",
    "Technocore seq and ts are server-assigned and are not covered by the DID signature.",
  ];
  if ((source.gaps ?? []).length) limitations.push("The source contains a detected sequence gap.");
  if (source.mode === "file") limitations.push("Offline timestamp-dependent state is provisional because the timestamp can be edited without invalidating the frame signature.");
  if (inspection && !inspection.detailLoaded && inspection.contractId) limitations.push("The derived deal room was not loaded, so post-accept state may be incomplete.");
  if (evidence?.missingRooms) limitations.push(`${evidence.missingRooms} observed deal rooms were empty or no longer retained.`);
  return limitations;
}

function sequenceGaps(records) {
  const gaps = [];
  for (let index = 1; index < records.length; index += 1) {
    if (records[index].seq > records[index - 1].seq + 1) {
      gaps.push(`Sequence ${records[index - 1].seq + 1}..${records[index].seq - 1} is absent.`);
    }
  }
  return gaps;
}

function toFinding(row, override) {
  return {
    stage: row.stage ?? "STATE",
    reason: override ?? row.reason ?? "Record rejected.",
    room: row.record?.room ?? "input",
    seq: row.record?.seq ?? row.seq ?? row.index + 1,
    did: row.record?.sender ?? null,
    type: row.frame?.type ?? null,
  };
}

function safeSeq(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function requireRoom(room) {
  if (!ROOM.test(room)) throw new Error(`Invalid room name: ${room}`);
}

function cleanError(error) {
  return error instanceof Error ? error.message.replace(/^tclk:\s*/, "") : "Invalid input";
}

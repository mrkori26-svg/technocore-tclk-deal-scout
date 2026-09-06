import {
  OFFER_ROOM,
  acceptedCandidatesForDid,
  analyzeBoard,
  compileCounterpartyEvidence,
  createAgentBrief,
  createReport,
  inspectCandidate,
  mergeRecordWindows,
  parseOfflineInput,
} from "./core.mjs";
import { fetchRoomExport, fetchRoomWindow, mapWithConcurrency } from "./client.mjs";

const elements = Object.fromEntries([
  "connection", "connectionText", "errorBanner", "refreshButton", "archiveButton", "fileInput",
  "sourceNote", "snapshotMeta", "signalRail", "statOffers", "statOpen", "statAccepted",
  "statInvalid", "statRails", "statusFilter", "roleFilter", "railFilter", "protoFilter",
  "textFilter", "offerCount", "offerList", "detailEmpty", "detailContent", "detailTitle",
  "detailId", "detailStatus", "detailRail", "factGrid", "detailRoomState", "timeline",
  "nextAction", "railCallout", "counterpartyDid", "historyButton", "historyStats",
  "historyList", "findingSection", "findingCount", "findingList", "reportButton", "briefButton",
].map((id) => [id, document.querySelector(`#${id}`)]));

let state = emptyState();
let liveController = null;

elements.refreshButton.addEventListener("click", loadLive);
elements.archiveButton.addEventListener("click", archiveBoard);
elements.fileInput.addEventListener("change", openSnapshot);
elements.offerList.addEventListener("click", (event) => {
  const card = event.target.closest("[data-offer-id]");
  if (card) selectOffer(card.dataset.offerId);
});
[elements.statusFilter, elements.roleFilter, elements.railFilter, elements.protoFilter, elements.textFilter]
  .forEach((input) => input.addEventListener("input", renderOffers));
elements.historyButton.addEventListener("click", scanHistory);
elements.reportButton.addEventListener("click", downloadReport);
elements.briefButton.addEventListener("click", copyBrief);
window.addEventListener("beforeunload", () => liveController?.abort());

loadLive();

async function loadLive() {
  liveController?.abort();
  const controller = new AbortController();
  liveController = controller;
  setError(null);
  setConnection("loading", "Reading the public TCLK board…");
  elements.refreshButton.disabled = true;

  try {
    const result = await fetchRoomWindow(OFFER_ROOM, { limit: 200, signal: controller.signal });
    if (controller.signal.aborted) return;
    state = {
      ...emptyState(),
      mode: "live",
      records: result.records,
      envelopeFindings: result.rejected,
      source: { ...result.source, mode: "live" },
    };
    rebuildBoard();
    setConnection("live", "Live · signatures checked locally");
    render();
    pollLive(controller);
  } catch (error) {
    if (controller.signal.aborted) return;
    setConnection("error", "Live board unavailable");
    setError(`${message(error)} Open a saved Technocore snapshot to continue offline.`);
    render();
  } finally {
    elements.refreshButton.disabled = false;
  }
}

async function pollLive(controller) {
  while (!controller.signal.aborted && state.mode === "live") {
    const expectedSince = state.source.lastSeq;
    try {
      const update = await fetchRoomWindow(OFFER_ROOM, {
        since: expectedSince,
        wait: 10,
        limit: 200,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const currentGeneration = String(state.source.generation ?? "");
      const nextGeneration = String(update.source.generation ?? "");
      if (currentGeneration && nextGeneration && currentGeneration !== nextGeneration) {
        setError("The room generation changed. Reloading a clean board window.");
        await delay(800, controller.signal);
        if (!controller.signal.aborted) loadLive();
        return;
      }

      state.records = mergeRecordWindows(state.records, update.records, 200);
      state.envelopeFindings = [...state.envelopeFindings, ...update.rejected].slice(-200);
      state.source = {
        ...state.source,
        lastSeq: Math.max(state.source.lastSeq ?? 0, update.source.lastSeq ?? 0),
        firstSeq: state.records[0]?.seq ?? state.source.firstSeq,
        generation: update.source.generation ?? state.source.generation,
        gaps: [...new Set([...(state.source.gaps ?? []), ...(update.source.gaps ?? [])])],
        snapshotText: state.records.map((record) => record.sourceLine).join("\n"),
      };
      rebuildBoard();
      setConnection("live", "Live · signatures checked locally");
      render();
      if (update.source.waitHeld === false) await delay(10_000, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return;
      setConnection("error", "Live retry pending");
      setError(`${message(error)} The last verified window remains on screen; retrying read-only access.`);
      await delay(4_000, controller.signal);
    }
  }
}

async function openSnapshot(event) {
  const [file] = event.target.files;
  if (!file) return;
  liveController?.abort();
  setError(null);

  try {
    const raw = await file.text();
    const parsed = parseOfflineInput(raw, OFFER_ROOM);
    const detailByRoom = new Map();
    parsed.records.filter((record) => record.room !== OFFER_ROOM).forEach((record) => {
      const detail = detailByRoom.get(record.room) ?? { records: [], loaded: true, missing: false };
      detail.records.push(record);
      detailByRoom.set(record.room, detail);
    });
    state = {
      ...emptyState(),
      mode: "file",
      records: parsed.records.filter((record) => record.room === OFFER_ROOM),
      envelopeFindings: parsed.rejected,
      source: { ...parsed.source, mode: "file", baseUrl: null },
      detailByRoom,
    };
    rebuildBoard();
    setConnection("error", `Offline snapshot · ${file.name}`);
    render();
  } catch (error) {
    setError(`Snapshot rejected: ${message(error)}`);
  } finally {
    event.target.value = "";
  }
}

function rebuildBoard() {
  state.board = analyzeBoard(state.records, state.envelopeFindings);
  if (state.selectedId && !state.board.candidates.some((candidate) => candidate.offerId === state.selectedId)) {
    state.selectedId = null;
    state.evidence = null;
    state.evidenceDid = null;
  }
}

function render() {
  renderSource();
  renderTape();
  renderStats();
  renderOffers();
  renderDetail();
}

function renderSource() {
  if (!state.board) {
    elements.sourceNote.textContent = "No public data loaded.";
    elements.snapshotMeta.textContent = "SEQ — / GEN —";
    return;
  }
  const gaps = state.source.gaps?.length ?? 0;
  elements.sourceNote.textContent = state.mode === "live"
    ? `Direct GET from ${state.source.baseUrl}. ${gaps ? `${gaps} sequence gap warning(s).` : "No gap detected in this session."}`
    : `Local file review. Time-dependent conclusions are provisional. ${gaps ? `${gaps} gap warning(s).` : ""}`;
  elements.snapshotMeta.textContent = `SEQ ${state.source.firstSeq ?? "—"}→${state.source.lastSeq ?? "—"} / GEN ${state.source.generation ?? "—"}`;
}

function renderTape() {
  if (!state.board?.rows.length) {
    elements.signalRail.innerHTML = Array.from({ length: 48 }, () => '<span class="signal-block" data-valid="false"></span>').join("");
    return;
  }
  const rows = state.board.rows.slice(-48);
  const padding = Array.from({ length: 48 - rows.length }, () => '<span class="signal-block" data-valid="false"></span>');
  const blocks = rows.map((row) => `<span class="signal-block" data-type="${escapeHtml(row.frame?.type ?? "invalid")}" data-valid="${row.ok}" title="${escapeHtml(row.ok ? `${row.frame.type} · verified` : row.reason)}"></span>`);
  elements.signalRail.innerHTML = [...padding, ...blocks].join("");
}

function renderStats() {
  const summary = state.board?.summary;
  elements.statOffers.textContent = summary?.offers ?? "—";
  elements.statOpen.textContent = summary?.open ?? "—";
  elements.statAccepted.textContent = summary?.accepted ?? "—";
  elements.statInvalid.textContent = summary?.invalid ?? "—";
  elements.statRails.textContent = summary
    ? Object.entries(summary.rails).sort((a, b) => b[1] - a[1]).map(([rail, count]) => `${rail} ${count}`).join(" · ") || "none"
    : "—";
}

function renderOffers() {
  if (!state.board) {
    elements.offerList.innerHTML = '<p class="empty-list">The live board has not loaded.</p>';
    elements.offerCount.textContent = "No offers loaded.";
    return;
  }
  const filters = {
    status: elements.statusFilter.value,
    role: elements.roleFilter.value,
    rail: elements.railFilter.value,
    proto: elements.protoFilter.value.trim().toLowerCase(),
    text: elements.textFilter.value.trim().toLowerCase(),
  };
  const filtered = state.board.candidates.filter((candidate) => matchesFilters(candidate, filters));
  elements.offerCount.textContent = `${filtered.length} of ${state.board.candidates.length} verified offers shown`;
  if (!filtered.length) {
    elements.offerList.innerHTML = '<p class="empty-list">No verified offer matches these filters.</p>';
    return;
  }

  elements.offerList.innerHTML = filtered.map((candidate) => {
    const inspection = currentInspection(candidate);
    const status = inspection.status;
    const job = candidate.offer.job;
    const rails = candidate.offer.rails.map((rail) => `<span class="tag ${rail === "paper" ? "no-value" : "unverified"}">${escapeHtml(rail)} · ${rail === "paper" ? "no value" : "unverified"}</span>`).join("");
    return `<button class="offer-card" type="button" data-offer-id="${escapeHtml(candidate.offerId)}" aria-pressed="${candidate.offerId === state.selectedId}">
      <div class="offer-top">
        <div>
          <span class="eyebrow">${escapeHtml(status)} · ${escapeHtml(candidate.offer.role)} offer</span>
          <h3>${escapeHtml(job ? `${job.proto} / ${job.id}` : shortHex(candidate.offerId))}</h3>
        </div>
        <span class="amount">${escapeHtml(candidate.offer.amount)} ${escapeHtml(candidate.offer.asset)}</span>
      </div>
      <div class="offer-meta">
        <span>${escapeHtml(shortDid(candidate.offer.from))}</span>
        <span>#${candidate.offerRow.record.seq}</span>
      </div>
      <div class="tag-row">${rails}<span class="tag deadline">${escapeHtml(candidate.deadline.replaceAll("_", " "))}</span></div>
    </button>`;
  }).join("");
}

function matchesFilters(candidate, filters) {
  const inspection = currentInspection(candidate);
  if (filters.status === "terminal" && !inspection.terminal) return false;
  if (!["all", "terminal"].includes(filters.status) && inspection.status !== filters.status) return false;
  if (filters.role !== "all" && candidate.offer.role !== filters.role) return false;
  if (filters.rail === "paper" && !candidate.offer.rails.includes("paper")) return false;
  if (filters.rail === "non-paper" && !candidate.offer.rails.some((rail) => rail !== "paper")) return false;
  if (filters.proto && !candidate.offer.job?.proto?.toLowerCase().includes(filters.proto)) return false;
  if (filters.text) {
    const haystack = [candidate.offerId, candidate.contractId, candidate.offer.from, candidate.offer.job?.id, candidate.offer.job?.proto].filter(Boolean).join(" ").toLowerCase();
    if (!haystack.includes(filters.text)) return false;
  }
  return true;
}

async function selectOffer(offerId) {
  state.selectedId = offerId;
  state.evidence = null;
  state.evidenceDid = null;
  renderOffers();
  renderDetail();
  const candidate = selectedCandidate();
  if (!candidate?.dealRoom || state.detailByRoom.has(candidate.dealRoom) || state.mode !== "live") return;

  elements.detailRoomState.textContent = "Loading derived room…";
  try {
    const detail = await fetchRoomExport(candidate.dealRoom);
    state.detailByRoom.set(candidate.dealRoom, {
      records: detail.records,
      loaded: true,
      missing: detail.records.length === 0,
      generation: detail.source.generation,
      rejected: detail.rejected,
    });
  } catch (error) {
    state.detailByRoom.set(candidate.dealRoom, {
      records: [], loaded: true, missing: true, error: message(error), rejected: [],
    });
  }
  render();
}

function renderDetail() {
  const candidate = selectedCandidate();
  if (!candidate) {
    elements.detailEmpty.hidden = false;
    elements.detailContent.hidden = true;
    return;
  }
  elements.detailEmpty.hidden = true;
  elements.detailContent.hidden = false;

  const inspection = currentInspection(candidate);
  const detail = candidate.dealRoom ? state.detailByRoom.get(candidate.dealRoom) : null;
  elements.detailTitle.textContent = candidate.offer.job ? `${candidate.offer.job.proto} / ${candidate.offer.job.id}` : "TCLK offer";
  elements.detailId.textContent = candidate.contractId ?? candidate.offerId;
  elements.detailStatus.textContent = inspection.status;
  elements.detailStatus.dataset.tone = inspection.terminal ? "valid" : inspection.active ? "warn" : "invalid";
  elements.detailRail.textContent = inspection.rail.status.replaceAll("_", " ");
  elements.detailRail.dataset.tone = inspection.rail.status === "NO_VALUE" ? "no-value" : "unverified";
  elements.detailRoomState.textContent = candidate.dealRoom
    ? detail?.error ? "Room read failed" : detail?.missing ? "Room empty / not retained" : detail?.loaded ? `${detail.records.length} room records loaded` : "Room not loaded"
    : "Contract pending";

  elements.factGrid.innerHTML = [
    ["Offer signer", shortDid(candidate.offer.from), candidate.offer.from],
    ["Payer", shortDid(inspection.payerDid), inspection.payerDid],
    ["Payee", shortDid(inspection.payeeDid), inspection.payeeDid],
    ["Terms", `${candidate.offer.amount} ${candidate.offer.asset}`, ""],
    ["Lock", candidate.offer.lock, ""],
    ["Offered rails", candidate.offer.rails.join(", "), ""],
    ["Offer deadline", formatDate(candidate.offer.expiresMs), ""],
    ["Claim by", formatDate(candidate.offer.claimByMs), ""],
    ["Refund after", formatDate(candidate.offer.refundAfterMs), ""],
  ].map(([label, value, title]) => `<div class="fact"><span>${escapeHtml(label)}</span><b title="${escapeHtml(title ?? "")}">${escapeHtml(value ?? "not established")}</b></div>`).join("");

  elements.timeline.innerHTML = inspection.events.map((event) => `<li data-valid="${event.ok}">
    <strong>${escapeHtml(event.type)} · ${event.ok ? "verified" : "rejected"}</strong>
    <p>${escapeHtml(shortDid(event.did))} · ${escapeHtml(event.room)} #${event.seq}${event.reason ? ` · ${escapeHtml(event.reason)}` : ""}</p>
    <span>${escapeHtml(event.timestamp ? formatDate(Date.parse(event.timestamp)) : "time unavailable")}</span>
  </li>`).join("") || '<li data-valid="false"><strong>No state</strong><p>No authenticated event opened this deal.</p><span>—</span></li>';
  elements.nextAction.textContent = inspection.nextAction;
  elements.railCallout.dataset.tone = inspection.rail.status === "NO_VALUE" ? "no-value" : "unverified";
  elements.railCallout.innerHTML = `<b>${escapeHtml(inspection.rail.status.replaceAll("_", " "))}</b><p>${escapeHtml(inspection.rail.detail)}</p>`;

  const counterparty = candidate.offer.from;
  elements.counterpartyDid.textContent = counterparty;
  elements.historyButton.textContent = state.mode === "live" ? "Check recent rooms" : "Review included rooms";
  renderHistory(counterparty);

  const relatedFindings = [
    ...inspection.findings,
    ...(detail?.rejected ?? []),
    ...(state.source.gaps ?? []).map((reason) => ({ reason, room: OFFER_ROOM, seq: "gap" })),
  ];
  elements.findingCount.textContent = `${relatedFindings.length} finding${relatedFindings.length === 1 ? "" : "s"}`;
  elements.findingList.innerHTML = relatedFindings.length
    ? relatedFindings.map((finding) => `<li><b>${escapeHtml(finding.room ?? "input")} #${escapeHtml(finding.seq ?? "—")}</b> — ${escapeHtml(finding.reason)}</li>`).join("")
    : "<li>No rejected record or sequence gap was observed for this selected deal.</li>";
}

async function scanHistory() {
  const candidate = selectedCandidate();
  if (!candidate) return;
  const did = candidate.offer.from;
  const related = acceptedCandidatesForDid(state.board.candidates, did);
  elements.historyButton.disabled = true;
  elements.historyButton.textContent = `Checking 0/${related.length}…`;

  if (state.mode === "live") {
    const missing = related.filter((item) => item.dealRoom && !state.detailByRoom.has(item.dealRoom));
    let completed = 0;
    const results = await mapWithConcurrency(missing, 2, async (item) => {
      const result = await fetchRoomExport(item.dealRoom);
      completed += 1;
      elements.historyButton.textContent = `Checking ${completed}/${missing.length}…`;
      return {
        records: result.records,
        loaded: true,
        missing: result.records.length === 0,
        generation: result.source.generation,
        rejected: result.rejected,
      };
    });
    results.forEach((result, index) => {
      const room = missing[index].dealRoom;
      state.detailByRoom.set(room, result.ok
        ? result.value
        : { records: [], loaded: true, missing: true, error: message(result.error), rejected: [] });
    });
  }

  state.evidence = compileCounterpartyEvidence(state.board.candidates, did, state.detailByRoom, {
    sourceMode: state.mode,
  });
  state.evidenceDid = did;
  elements.historyButton.disabled = false;
  renderDetail();
}

function renderHistory(did) {
  const evidence = state.evidenceDid === did ? state.evidence : null;
  if (!evidence) {
    elements.historyStats.innerHTML = "<p>No history scan has been run for this DID.</p>";
    elements.historyList.innerHTML = "";
    return;
  }
  elements.historyStats.innerHTML = [
    [evidence.observedAcceptedDeals, "Accepted deals observed"],
    [evidence.payerLocksObserved, `Payer locks / ${evidence.acceptedAsPayer}`],
    [evidence.payeeRevealsObserved, `Payee reveals / ${evidence.acceptedAsPayee}`],
    [evidence.missingRooms, "Missing retained rooms"],
  ].map(([value, label]) => `<article><strong>${value}</strong><span>${escapeHtml(label)}</span></article>`).join("");
  elements.historyList.innerHTML = evidence.deals.map((deal) => `<div class="history-row">
    <b>${escapeHtml(deal.role)}</b>
    <span title="${escapeHtml(deal.contractId)}">${escapeHtml(shortHex(deal.contractId))} · ${escapeHtml(deal.room)}</span>
    <b>${escapeHtml(deal.roomMissing ? "missing" : deal.status)}</b>
  </div>`).join("") || '<p class="bounded-note">No accepted deal involving this DID appears in the retained board window.</p>';
}

async function archiveBoard() {
  setError(null);
  elements.archiveButton.disabled = true;
  try {
    if (state.mode === "live") {
      const result = await fetchRoomExport(OFFER_ROOM);
      downloadText(result.raw, `tclk-offers-gen-${result.source.generation ?? "unknown"}.jsonl`, "application/x-ndjson");
    } else {
      downloadText(state.source.snapshotText ?? "", "tclk-offers-offline-snapshot.jsonl", "application/x-ndjson");
    }
  } catch (error) {
    setError(`Archive failed: ${message(error)}`);
  } finally {
    elements.archiveButton.disabled = false;
  }
}

async function downloadReport() {
  const candidate = selectedCandidate();
  if (!candidate) return;
  elements.reportButton.disabled = true;
  try {
    const inspection = currentInspection(candidate);
    const report = await createReport({
      board: state.board,
      source: {
        ...state.source,
        snapshotText: state.records.map((record) => record.sourceLine).join("\n"),
      },
      candidate,
      inspection,
      evidence: state.evidenceDid === candidate.offer.from ? state.evidence : null,
    });
    downloadText(`${JSON.stringify(report, null, 2)}\n`, `deal-scout-${shortHex(candidate.contractId ?? candidate.offerId)}.json`, "application/json");
  } catch (error) {
    setError(`Report failed: ${message(error)}`);
  } finally {
    elements.reportButton.disabled = false;
  }
}

async function copyBrief() {
  const candidate = selectedCandidate();
  if (!candidate) return;
  try {
    const brief = createAgentBrief(currentInspection(candidate), state.evidenceDid === candidate.offer.from ? state.evidence : null);
    await navigator.clipboard.writeText(brief);
    const previous = elements.briefButton.textContent;
    elements.briefButton.textContent = "Agent brief copied";
    setTimeout(() => { elements.briefButton.textContent = previous; }, 1800);
  } catch (error) {
    setError(`Copy failed: ${message(error)}`);
  }
}

function currentInspection(candidate) {
  const detail = candidate.dealRoom ? state.detailByRoom.get(candidate.dealRoom) : null;
  return inspectCandidate(candidate, detail?.records ?? [], {
    detailLoaded: candidate.dealRoom ? detail?.loaded ?? false : true,
    sourceMode: state.mode,
  });
}

function selectedCandidate() {
  return state.board?.candidates.find((candidate) => candidate.offerId === state.selectedId) ?? null;
}

function emptyState() {
  return {
    mode: "live",
    records: [],
    envelopeFindings: [],
    source: { mode: "live", room: OFFER_ROOM, firstSeq: null, lastSeq: null, generation: null, gaps: [], snapshotText: "" },
    board: null,
    selectedId: null,
    detailByRoom: new Map(),
    evidence: null,
    evidenceDid: null,
  };
}

function setConnection(tone, text) {
  elements.connection.dataset.tone = tone;
  elements.connectionText.textContent = text;
}

function setError(value) {
  elements.errorBanner.hidden = !value;
  elements.errorBanner.textContent = value ?? "";
}

function downloadText(text, filename, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function shortDid(did) {
  if (!did) return "not established";
  return did.length > 22 ? `${did.slice(0, 13)}…${did.slice(-7)}` : did;
}

function shortHex(value) {
  if (!value) return "pending";
  return value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value;
}

function formatDate(ms) {
  if (!Number.isFinite(ms)) return "invalid time";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium", timeStyle: "medium", timeZone: "UTC",
  }).format(ms).replace(" at ", " · ") + " UTC";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function message(error) {
  return error instanceof Error ? error.message : "Unknown error";
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

import test from "node:test";
import assert from "node:assert/strict";
import { fetchRoomWindow, getWithRetry } from "../src/client.mjs";
import { signedDealFixture } from "./fixtures.mjs";

test("network helper uses GET and retries transient 429 and 503 responses", async () => {
  let calls = 0;
  const methods = [];
  const fetchImpl = async (_url, init) => {
    calls += 1;
    methods.push(init.method);
    if (calls === 1) return new Response("rate limited", { status: 429 });
    if (calls === 2) return new Response("busy", { status: 503 });
    return new Response("ok", { status: 200 });
  };

  const response = await getWithRetry("https://technocore.chat/r/tclk-offers", { fetchImpl, attempts: 3 });
  assert.equal(await response.text(), "ok");
  assert.equal(calls, 3);
  assert.deepEqual(methods, ["GET", "GET", "GET"]);
});

test("window parser detects a sequence gap", async () => {
  const fixture = signedDealFixture();
  const messages = fixture.board.map((line) => JSON.parse(line.replace(/("nonce"\s*:\s*)([0-9]{16,19})/, '$1"$2"')));
  const raw = JSON.stringify({ room: "tclk-offers", count: 2, first_seq: 101, last_seq: 102, messages });
  const fetchImpl = async () => new Response(raw, {
    status: 200,
    headers: { "content-type": "application/json", "x-room-generation": "7" },
  });
  const result = await fetchRoomWindow("tclk-offers", { fetchImpl, since: 50, wait: 0 });

  assert.equal(result.source.generation, "7");
  assert.equal(result.source.gaps.length, 1);
  assert.equal(result.records[0].nonce, "9223372036854775807");
});

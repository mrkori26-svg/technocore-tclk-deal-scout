import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64urlnopad } from "@scure/base";
import {
  encodeFrame,
  hashLockFromPreimage,
  makeAccept,
  makeOffer,
} from "../vendor/tclk/index.js";

export const FIXED_NOW = Date.parse("2026-09-06T09:00:00.000Z");
export const LARGE_NONCE = "9223372036854775807";
export const SECRET = `0x${"42".repeat(32)}`;

export function identity(byte) {
  const secret = new Uint8Array(32).fill(byte);
  const publicKey = ed25519.getPublicKey(secret);
  const tagged = new Uint8Array(34);
  tagged.set([0xed, 0x01]);
  tagged.set(publicKey, 2);
  return { secret, did: `did:key:z${base58.encode(tagged)}` };
}

export function signedDealFixture() {
  const payer = identity(7);
  const payee = identity(9);
  const lock = hashLockFromPreimage(SECRET);
  const offer = makeOffer({
    from: payer.did,
    role: "payer",
    amount: "2500000",
    asset: "FLOP",
    lock: "hash",
    rails: ["paper"],
    expiresMs: FIXED_NOW + 60_000,
    claimByMs: FIXED_NOW + 120_000,
    refundAfterMs: FIXED_NOW + 180_000,
    nonce: "0011223344556677",
    job: { proto: "a2a", id: "deal-scout-test" },
  });
  const accept = makeAccept(offer, {
    from: payee.did,
    statement: lock.hash,
    nonce: "8899aabbccddeeff",
  });
  const room = `mb-p-tclk-${accept.contract.slice(2, 18)}`;
  const board = [
    signEnvelope("tclk-offers", 101, "2026-09-06T09:00:10.000Z", payer, encodeFrame(offer), LARGE_NONCE, true),
    signEnvelope("tclk-offers", 102, "2026-09-06T09:00:20.000Z", payee, encodeFrame(accept), "9223372036854775806", true),
  ];
  const details = [
    signEnvelope(room, 1, "2026-09-06T09:00:30.000Z", payer, encodeFrame({
      type: "lock", from: payer.did, contract: accept.contract, rail: "paper", ref: "paper-test-1",
    }), "7001"),
    signEnvelope(room, 2, "2026-09-06T09:00:40.000Z", payee, encodeFrame({
      type: "reveal", from: payee.did, contract: accept.contract, ref: "paper-test-1", secret: SECRET,
    }), "7002"),
    signEnvelope(room, 3, "2026-09-06T09:00:50.000Z", payer, encodeFrame({
      type: "receipt", from: payer.did, contract: accept.contract, outcome: "claimed", rail: "paper", ref: "paper-test-1",
    }), "7003"),
  ];
  return { payer, payee, offer, accept, room, board, details };
}

export function signEnvelope(room, seq, ts, signer, text, nonce, numericNonce = false) {
  const canonical = `${room}|${nonce}|${text}`;
  const sig = base64urlnopad.encode(ed25519.sign(new TextEncoder().encode(canonical), signer.secret));
  const nonceJson = numericNonce ? nonce : JSON.stringify(nonce);
  return `{"seq":${seq},"ts":${JSON.stringify(ts)},"from":${JSON.stringify(signer.did)},"text":${JSON.stringify(text)},"nonce":${nonceJson},"sig":${JSON.stringify(sig)}}`;
}


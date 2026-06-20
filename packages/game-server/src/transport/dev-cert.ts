// Self-signed ECDSA P-256 dev certificate for WebTransport. The browser/Node WT
// client trusts it via serverCertificateHashes (SHA-256 of the DER) — no CA needed.
// Cert is cached under ./.wt-dev-cert and regenerated before its 13-day expiry.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface DevCert {
  cert: string; // PEM
  privKey: string; // PEM
  hashHex: string; // sha-256 of DER, hex
  hashBytes: Uint8Array;
}

const DIR = resolve(process.cwd(), ".wt-dev-cert");
const CERT = resolve(DIR, "cert.pem");
const KEY = resolve(DIR, "key.pem");
const HASH = resolve(DIR, "hash.txt");

/**
 * Prefer a real OpenSSL — QUIC/BoringSSL rejects certs minted by macOS's bundled
 * LibreSSL. Env OPENSSL overrides. Falls back to PATH `openssl` if none found.
 */
function opensslBin(): string {
  const candidates = [
    process.env.OPENSSL,
    "/opt/homebrew/bin/openssl",
    "/usr/local/bin/openssl",
    "/opt/homebrew/opt/openssl@3/bin/openssl",
    "openssl",
  ].filter((x): x is string => Boolean(x));
  for (const bin of candidates) {
    try {
      if (execFileSync(bin, ["version"], { encoding: "utf8" }).startsWith("OpenSSL ")) return bin;
    } catch {
      /* try next */
    }
  }
  return "openssl";
}

function stale(): boolean {
  try {
    const ageDays = (Date.now() - statSync(CERT).mtimeMs) / 86_400_000;
    return ageDays > 10; // regenerate well before the 13-day validity ends
  } catch {
    return true;
  }
}

function derSha256(certPem: string): { hex: string; bytes: Uint8Array } {
  const der = Buffer.from(certPem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
  const digest = createHash("sha256").update(der).digest();
  return { hex: digest.toString("hex"), bytes: new Uint8Array(digest) };
}

export function getDevCert(): DevCert {
  if (!existsSync(CERT) || !existsSync(KEY) || stale()) {
    mkdirSync(DIR, { recursive: true });
    execFileSync(
      opensslBin(),
      [
        "req", "-x509", "-newkey", "ec",
        "-pkeyopt", "ec_paramgen_curve:prime256v1",
        "-nodes", "-keyout", KEY, "-out", CERT, "-days", "13",
        "-subj", "/CN=localhost",
        "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
  }
  const cert = readFileSync(CERT, "utf8");
  const privKey = readFileSync(KEY, "utf8");
  const { hex, bytes } = derSha256(cert);
  writeFileSync(HASH, hex); // clients read this to trust the cert
  return { cert, privKey, hashHex: hex, hashBytes: bytes };
}

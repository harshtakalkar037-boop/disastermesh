import {
  createHash,
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";

export function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

export function keyIdOf(publicKeyRaw: Uint8Array): Uint8Array {
  return sha256(publicKeyRaw).subarray(0, 8);
}

export interface Identity {
  publicKeyRaw: Uint8Array;
  sign(data: Uint8Array): Uint8Array;
}

export interface GeneratedIdentity extends Identity {
  privateKeyPem: string;
  publicKeyPem: string;
}

export function generateIdentity(): GeneratedIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKeyRaw = exportUncompressed(publicKey);
  return {
    publicKeyRaw,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    sign(data: Uint8Array) {
      return signWith(privateKey, data);
    },
  };
}

export function identityFromPkcs8(pem: string): Identity {
  const privateKey = createPrivateKey(pem);
  const publicKeyRaw = exportUncompressed(createPublicKey(privateKey));
  return {
    publicKeyRaw,
    sign(data: Uint8Array) {
      return signWith(privateKey, data);
    },
  };
}

function signWith(privateKey: KeyObject, data: Uint8Array): Uint8Array {
  const signer = createSign("SHA256");
  signer.update(data);
  signer.end();
  return derToP1363(signer.sign(privateKey));
}

/** Established ECDSA P-256 / SHA-256. Signature is IEEE P1363 r||s, 64 bytes. */
export function verifyP256(data: Uint8Array, signature: Uint8Array, publicKeyRaw: Uint8Array): boolean {
  try {
    if (signature.length !== 64 || publicKeyRaw.length !== 65 || publicKeyRaw[0] !== 0x04) return false;
    const publicKey = importUncompressed(publicKeyRaw);
    const verifier = createVerify("SHA256");
    verifier.update(data);
    verifier.end();
    return verifier.verify(publicKey, p1363ToDer(signature));
  } catch {
    return false;
  }
}

function exportUncompressed(publicKey: KeyObject): Uint8Array {
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string; y?: string };
  if (!jwk.x || !jwk.y) throw new Error("EC public key missing coordinates");
  const x = decodeB64Url(jwk.x);
  const y = decodeB64Url(jwk.y);
  if (x.length !== 32 || y.length !== 32) throw new Error("unexpected EC coordinate length");
  const out = new Uint8Array(65);
  out[0] = 0x04;
  out.set(x, 1);
  out.set(y, 33);
  return out;
}

function importUncompressed(raw: Uint8Array): KeyObject {
  const x = Buffer.from(raw.subarray(1, 33)).toString("base64url");
  const y = Buffer.from(raw.subarray(33, 65)).toString("base64url");
  return createPublicKey({ key: { kty: "EC", crv: "P-256", x, y }, format: "jwk" });
}

function decodeB64Url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

export function derToP1363(der: Uint8Array): Uint8Array {
  const buf = Buffer.from(der);
  if (buf.length < 8 || buf[0] !== 0x30) throw new Error("DER sequence expected");
  let offset = 2;
  if (buf[1] & 0x80) {
    const nbytes = buf[1] & 0x7f;
    offset = 2 + nbytes;
  }
  if (buf[offset] !== 0x02) throw new Error("DER integer r expected");
  const rLen = buf[offset + 1];
  const r = buf.subarray(offset + 2, offset + 2 + rLen);
  offset = offset + 2 + rLen;
  if (buf[offset] !== 0x02) throw new Error("DER integer s expected");
  const sLen = buf[offset + 1];
  const s = buf.subarray(offset + 2, offset + 2 + sLen);
  const out = Buffer.alloc(64);
  const rt = trimLeadingZeros(r);
  const st = trimLeadingZeros(s);
  if (rt.length > 32 || st.length > 32 || rt.length === 0 || st.length === 0) {
    throw new Error("ECDSA component length");
  }
  rt.copy(out, 32 - rt.length);
  st.copy(out, 64 - st.length);
  return new Uint8Array(out);
}

export function p1363ToDer(sig: Uint8Array): Buffer {
  if (sig.length !== 64) throw new Error("P1363 signature must be 64 bytes");
  const r = unsignedComponent(Buffer.from(sig.subarray(0, 32)));
  const s = unsignedComponent(Buffer.from(sig.subarray(32)));
  const len = 2 + r.length + 2 + s.length;
  const out = Buffer.alloc(2 + len);
  out[0] = 0x30;
  out[1] = len;
  let cursor = 2;
  out[cursor++] = 0x02;
  out[cursor++] = r.length;
  r.copy(out, cursor);
  cursor += r.length;
  out[cursor++] = 0x02;
  out[cursor++] = s.length;
  s.copy(out, cursor);
  return out;
}

function trimLeadingZeros(buf: Buffer): Buffer {
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0) i += 1;
  return buf.subarray(i);
}

function unsignedComponent(buf: Buffer): Buffer {
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0) i += 1;
  const sliced = buf.subarray(i);
  if (sliced[0] & 0x80) {
    const padded = Buffer.alloc(sliced.length + 1);
    sliced.copy(padded, 1);
    return padded;
  }
  return Buffer.from(sliced);
}

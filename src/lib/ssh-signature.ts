import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

const SSH_SIGNATURE_MAGIC = Buffer.from('SSHSIG', 'utf8');
const SIGNATURE_NAMESPACE = 'git';
const HASH_ALGORITHM = 'sha512';

function sshString(data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  return Buffer.concat([length, data]);
}

function sshMpint(data: Buffer): Buffer {
  let value = data;
  while (value.length > 1 && value[0] === 0 && (value[1]! & 0x80) === 0) {
    value = value.subarray(1);
  }
  if ((value[0]! & 0x80) !== 0) {
    value = Buffer.concat([Buffer.from([0]), value]);
  }
  return sshString(value);
}

function publicKeyBlob(publicKey: KeyObject): { algorithm: string; blob: Buffer } {
  const jwk = publicKey.export({ format: 'jwk' }) as {
    kty: string;
    crv?: string;
    x?: string;
    y?: string;
    n?: string;
    e?: string;
  };
  if (publicKey.asymmetricKeyType === 'ed25519' && jwk.x) {
    const raw = Buffer.from(jwk.x, 'base64url');
    return {
      algorithm: 'ssh-ed25519',
      blob: Buffer.concat([sshString(Buffer.from('ssh-ed25519', 'utf8')), sshString(raw)]),
    };
  }
  if (publicKey.asymmetricKeyType === 'rsa' && jwk.n && jwk.e) {
    return {
      algorithm: 'ssh-rsa',
      blob: Buffer.concat([
        sshString(Buffer.from('ssh-rsa', 'utf8')),
        sshMpint(Buffer.from(jwk.e, 'base64url')),
        sshMpint(Buffer.from(jwk.n, 'base64url')),
      ]),
    };
  }
  if (publicKey.asymmetricKeyType === 'ec' && jwk.x && jwk.y) {
    const curveName = { 'P-256': 'nistp256', 'P-384': 'nistp384', 'P-521': 'nistp521' }[jwk.crv ?? ''];
    if (!curveName) throw new Error(`Unsupported signing key curve: ${jwk.crv ?? 'unknown'}`);
    const algorithm = `ecdsa-sha2-${curveName}`;
    const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
    return {
      algorithm,
      blob: Buffer.concat([sshString(Buffer.from(algorithm, 'utf8')), sshString(Buffer.from(curveName, 'utf8')), sshString(point)]),
    };
  }
  throw new Error(`Unsupported signing key type: ${publicKey.asymmetricKeyType ?? 'unknown'}`);
}

function rawSignature(privateKey: KeyObject, algorithm: string, data: Buffer): Buffer {
  if (privateKey.asymmetricKeyType === 'ed25519') {
    return sign(null, data, privateKey);
  }
  if (privateKey.asymmetricKeyType === 'rsa') {
    return sign(HASH_ALGORITHM, data, privateKey);
  }
  if (privateKey.asymmetricKeyType === 'ec') {
    const hash = { 'ecdsa-sha2-nistp256': 'sha256', 'ecdsa-sha2-nistp384': 'sha384', 'ecdsa-sha2-nistp521': 'sha512' }[algorithm];
    if (!hash) throw new Error(`Unsupported signing key algorithm: ${algorithm}`);
    const der = sign(hash, data, privateKey);
    const fields: Buffer[] = [];
    let offset = 2;
    for (let i = 0; i < 2; i++) {
      const length = der[offset + 1]!;
      fields.push(der.subarray(offset + 2, offset + 2 + length));
      offset += 2 + length;
    }
    const size = Math.max(fields[0]!.length, fields[1]!.length);
    const raw = Buffer.alloc(size * 2);
    fields[0]!.copy(raw, size - fields[0]!.length);
    fields[1]!.copy(raw, size * 2 - fields[1]!.length);
    return raw;
  }
  throw new Error(`Unsupported signing key type: ${privateKey.asymmetricKeyType ?? 'unknown'}`);
}

function signatureAlgorithmName(privateKey: KeyObject, algorithm: string): string {
  if (privateKey.asymmetricKeyType === 'rsa') return 'rsa-sha2-512';
  return algorithm;
}

class ByteReader {
  private buffer: Buffer;
  private offset = 0;

  constructor(buffer: Buffer) {
    this.buffer = buffer;
  }

  readBytes(length: number): Buffer {
    const out = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  readUInt32(): number {
    const value = this.buffer.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  readString(): Buffer {
    const length = this.readUInt32();
    return this.readBytes(length);
  }

  readText(): string {
    return this.readString().toString('utf8');
  }
}

function unsignedBase64Url(data: Buffer): string {
  let value = data;
  while (value.length > 1 && value[0] === 0) value = value.subarray(1);
  return value.toString('base64url');
}

function parseOpenSshPrivateKey(pem: string): KeyObject {
  const match = pem.match(/-----BEGIN OPENSSH PRIVATE KEY-----([A-Za-z0-9+/=\s]+)-----END OPENSSH PRIVATE KEY-----/);
  if (!match) throw new Error('not an OpenSSH private key');
  const reader = new ByteReader(Buffer.from(match[1]!.replace(/\s+/g, ''), 'base64'));
  const magic = reader.readBytes(15).toString('latin1');
  if (magic !== 'openssh-key-v1\0') throw new Error('missing openssh-key-v1 magic');
  const cipher = reader.readText();
  if (cipher !== 'none') throw new Error('encrypted OpenSSH private keys cannot be used for SSH signing');
  reader.readString();
  reader.readString();
  reader.readUInt32();
  reader.readString();
  const block = new ByteReader(reader.readString());
  const check = block.readUInt32();
  if (block.readUInt32() !== check) throw new Error('corrupt OpenSSH private key (check values differ)');
  const keyType = block.readText();
  if (keyType === 'ssh-ed25519') {
    const publicRaw = block.readString();
    const privateRaw = block.readString();
    const seed = privateRaw.subarray(0, 32);
    return createPrivateKey({
      key: { kty: 'OKP', crv: 'Ed25519', d: seed.toString('base64url'), x: publicRaw.toString('base64url') },
      format: 'jwk',
    });
  }
  if (keyType === 'ssh-rsa') {
    const n = block.readString();
    const e = block.readString();
    const d = block.readString();
    const iqmp = block.readString();
    const p = block.readString();
    const q = block.readString();
    return createPrivateKey({
      key: {
        kty: 'RSA',
        n: unsignedBase64Url(n),
        e: unsignedBase64Url(e),
        d: unsignedBase64Url(d),
        qi: unsignedBase64Url(iqmp),
        p: unsignedBase64Url(p),
        q: unsignedBase64Url(q),
      },
      format: 'jwk',
    });
  }
  if (keyType.startsWith('ecdsa-sha2-')) {
    const curveName = block.readText();
    const point = block.readString();
    const privateRaw = block.readString();
    const crv = { nistp256: 'P-256', nistp384: 'P-384', nistp521: 'P-521' }[curveName];
    if (!crv || point[0] !== 4) throw new Error(`Unsupported signing key curve: ${curveName}`);
    const coordinateSize = (point.length - 1) / 2;
    return createPrivateKey({
      key: {
        kty: 'EC',
        crv,
        x: point.subarray(1, 1 + coordinateSize).toString('base64url'),
        y: point.subarray(1 + coordinateSize).toString('base64url'),
        d: unsignedBase64Url(privateRaw),
      },
      format: 'jwk',
    });
  }
  throw new Error(`Unsupported signing key type: ${keyType}`);
}

export function signGitPayload(payload: string, privateKeyPem: string): string {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(privateKeyPem);
  } catch {
    try {
      privateKey = parseOpenSshPrivateKey(privateKeyPem);
    } catch (error) {
      throw new Error(
        `The signing key could not be parsed as an SSH private key: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  const { algorithm, blob } = publicKeyBlob(createPublicKey(privateKey));
  const payloadBytes = Buffer.from(payload, 'utf8');
  const hashed = createHash(HASH_ALGORITHM).update(payloadBytes).digest();
  const signedData = Buffer.concat([
    SSH_SIGNATURE_MAGIC,
    sshString(Buffer.from(SIGNATURE_NAMESPACE, 'utf8')),
    sshString(Buffer.alloc(0)),
    sshString(Buffer.from(HASH_ALGORITHM, 'utf8')),
    sshString(hashed),
  ]);
  const signature = rawSignature(privateKey, algorithm, signedData);
  const signatureBlob = Buffer.concat([
    sshString(Buffer.from(signatureAlgorithmName(privateKey, algorithm), 'utf8')),
    sshString(signature),
  ]);
  const version = Buffer.alloc(4);
  version.writeUInt32BE(1, 0);
  const armored = Buffer.concat([
    SSH_SIGNATURE_MAGIC,
    version,
    sshString(blob),
    sshString(Buffer.from(SIGNATURE_NAMESPACE, 'utf8')),
    sshString(Buffer.alloc(0)),
    sshString(Buffer.from(HASH_ALGORITHM, 'utf8')),
    sshString(signatureBlob),
  ]);
  const base64 = armored.toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += 70) {
    lines.push(base64.slice(i, i + 70));
  }
  return ['-----BEGIN SSH SIGNATURE-----', ...lines, '-----END SSH SIGNATURE-----'].join('\n');
}

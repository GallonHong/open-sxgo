import { assert } from '../../domain/src/index';
export const utf8 = (s: string) => new TextEncoder().encode(s);
export const hex = (b: ArrayBuffer | Uint8Array) =>
  Array.from(b instanceof Uint8Array ? b : new Uint8Array(b), (x) =>
    x.toString(16).padStart(2, '0'),
  ).join('');
export function unhex(s: string) {
  assert(/^(?:[a-f0-9]{2})+$/i.test(s), 'INVALID_HEX');
  return Uint8Array.from(s.match(/../g)!, (x) => parseInt(x, 16));
}
export async function hash(bytes: Uint8Array) {
  return hex(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
}
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number') {
    assert(Number.isSafeInteger(value), 'NON_INTEGER');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  assert(typeof value === 'object' && value !== null, 'INVALID_JSON');
  return (
    '{' +
    Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k]))
      .join(',') +
    '}'
  );
}
// TUF uses its canonical JSON representation, distinct from business-object JCS.
export function tufCanonical(value: unknown): string {
  if (typeof value === 'string')
    return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  if (Array.isArray(value)) return '[' + value.map(tufCanonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => tufCanonical(k) + ':' + tufCanonical((value as Record<string, unknown>)[k]))
        .join(',') +
      '}'
    );
  return canonical(value);
}
export function strictJSON(raw: string): unknown {
  let i = 0;
  const ws = () => {
    while (/[ \t\r\n]/.test(raw[i] ?? '') && i < raw.length) i++;
  };
  function value(depth = 0): unknown {
    assert(depth < 64, 'JSON_TOO_DEEP');
    ws();
    const ch = raw[i];
    if (ch === '"') {
      const start = i++;
      while (i < raw.length) {
        if (raw[i] === '\\') {
          i += 2;
          continue;
        }
        if (raw[i++] === '"') return JSON.parse(raw.slice(start, i));
      }
      throw Error('INVALID_JSON');
    }
    if (ch === '{') {
      i++;
      const o: Record<string, unknown> = Object.create(null);
      ws();
      if (raw[i] === '}') {
        i++;
        return o;
      }
      while (true) {
        ws();
        assert(raw[i] === '"', 'INVALID_JSON');
        const k = value() as string;
        assert(!Object.hasOwn(o, k), 'DUPLICATE_KEY');
        ws();
        assert(raw[i++] === ':', 'INVALID_JSON');
        o[k] = value(depth + 1);
        ws();
        const end = raw[i++];
        if (end === '}') return o;
        assert(end === ',', 'INVALID_JSON');
      }
    }
    if (ch === '[') {
      i++;
      const a: unknown[] = [];
      ws();
      if (raw[i] === ']') {
        i++;
        return a;
      }
      while (true) {
        a.push(value(depth + 1));
        ws();
        const end = raw[i++];
        if (end === ']') return a;
        assert(end === ',', 'INVALID_JSON');
      }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      raw.slice(i),
    );
    assert(match, 'INVALID_JSON');
    i += match[0].length;
    const v = JSON.parse(match[0]);
    assert(typeof v !== 'number' || Number.isSafeInteger(v), 'NON_INTEGER');
    return v;
  }
  const out = value();
  ws();
  assert(i === raw.length, 'INVALID_JSON');
  return out;
}
export async function sign(payload: unknown, key: CryptoKey, business = false) {
  return hex(
    await crypto.subtle.sign(
      'Ed25519',
      key,
      utf8(business ? 'WFD-SIGNED-OBJECT-v1\n' + canonical(payload) : tufCanonical(payload)),
    ),
  );
}
export async function verify(payload: unknown, signature: string, key: string, business = false) {
  try {
    const pub = await crypto.subtle.importKey('raw', unhex(key), 'Ed25519', false, ['verify']);
    return await crypto.subtle.verify(
      'Ed25519',
      pub,
      unhex(signature),
      utf8(business ? 'WFD-SIGNED-OBJECT-v1\n' + canonical(payload) : tufCanonical(payload)),
    );
  } catch {
    return false;
  }
}
/** TUF key adapter; unsupported schemes fail closed without rejecting unrelated keys. */
export async function verifyTufKey(
  payload: unknown,
  signature: string,
  key: { keytype: string; scheme: string; keyval: { public: string } },
) {
  if (key.keytype === 'ed25519' && key.scheme === 'ed25519')
    return verify(payload, signature, key.keyval.public);
  try {
    const pem = key.keyval.public.replace(
      /-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g,
      '',
    );
    const spki = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
    const message = utf8(tufCanonical(payload));
    if (
      key.keytype === 'ecdsa' &&
      ['ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384'].includes(key.scheme)
    ) {
      const size = key.scheme.endsWith('256') ? 32 : 48;
      const der = unhex(signature);
      let offset = 0;
      const length = () => {
        let n = der[offset++];
        if (n & 128) {
          const count = n & 127;
          assert(count > 0 && count <= 2, 'INVALID_DER');
          n = 0;
          for (let i = 0; i < count; i++) n = n * 256 + der[offset++];
        }
        return n;
      };
      assert(der[offset++] === 0x30, 'INVALID_DER');
      assert(length() === der.length - offset, 'INVALID_DER');
      const raw = new Uint8Array(size * 2);
      for (let part = 0; part < 2; part++) {
        assert(der[offset++] === 2, 'INVALID_DER');
        const len = length();
        let value = der.slice(offset, offset + len);
        offset += len;
        assert(value.length === len && len > 0 && !(value[0] & 128), 'INVALID_DER');
        if (value.length > size) {
          assert(value.length === size + 1 && value[0] === 0, 'INVALID_DER');
          value = value.slice(1);
        }
        raw.set(value, (part + 1) * size - value.length);
      }
      assert(offset === der.length, 'INVALID_DER');
      const publicKey = await crypto.subtle.importKey(
        'spki',
        spki,
        { name: 'ECDSA', namedCurve: size === 32 ? 'P-256' : 'P-384' },
        false,
        ['verify'],
      );
      return await crypto.subtle.verify(
        { name: 'ECDSA', hash: size === 32 ? 'SHA-256' : 'SHA-384' },
        publicKey,
        raw,
        message,
      );
    }
    if (key.keytype === 'rsa' && /^rsassa-(?:pss|pkcs1v15)-sha(?:256|384|512)$/.test(key.scheme)) {
      const bits = Number(key.scheme.slice(-3)),
        name = key.scheme.includes('-pss-') ? 'RSA-PSS' : 'RSASSA-PKCS1-v1_5',
        publicKey = await crypto.subtle.importKey(
          'spki',
          spki,
          { name, hash: 'SHA-' + bits },
          false,
          ['verify'],
        );
      return await crypto.subtle.verify(
        name === 'RSA-PSS' ? { name, saltLength: bits / 8 } : { name },
        publicKey,
        unhex(signature),
        message,
      );
    }
  } catch {
    return false;
  }
  return false;
}

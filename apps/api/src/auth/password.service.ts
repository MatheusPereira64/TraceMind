import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const KEY_LENGTH = 64;
const SALT_BYTES = 16;
export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/**
 * One of the OWASP-recommended equivalent scrypt configurations (N=2^15, r=8, p=3). It costs
 * ~32 MiB per hash instead of ~128 MiB for N=2^17/p=1, which matters on small containers that
 * may hash several passwords concurrently.
 */
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 2 ** 15, r: 8, p: 3 };
export const SCRYPT_PARAMS = Symbol('SCRYPT_PARAMS');

function scryptAsync(password: string, salt: Buffer, params: ScryptParams) {
  const options: ScryptOptions = { ...params, maxmem: 256 * params.N * params.r };
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, options, (error, derived) =>
      error ? reject(error) : resolve(derived),
    );
  });
}

/**
 * Password hashing with Node's built-in scrypt (memory-hard KDF). Chosen over argon2 to avoid a
 * native addon in the container image; parameters are encoded in the hash so they can be raised
 * later without invalidating existing hashes.
 *
 * Format: `scrypt$N$r$p$<salt b64>$<hash b64>`
 */
@Injectable()
export class PasswordService {
  private readonly params: ScryptParams;

  constructor(@Optional() @Inject(SCRYPT_PARAMS) params?: ScryptParams) {
    this.params = params ?? DEFAULT_SCRYPT_PARAMS;
  }

  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES);
    const derived = await scryptAsync(password, salt, this.params);
    const { N, r, p } = this.params;
    return ['scrypt', N, r, p, salt.toString('base64'), derived.toString('base64')].join('$');
  }

  async verify(password: string, encoded: string): Promise<boolean> {
    const parts = encoded.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
    const expected = Buffer.from(hashB64, 'base64');
    const derived = await scryptAsync(password, Buffer.from(saltB64, 'base64'), {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  }

  /** True when a stored hash uses weaker parameters than the current ones. */
  needsRehash(encoded: string): boolean {
    const [, n, r, p] = encoded.split('$');
    return Number(n) < this.params.N || Number(r) < this.params.r || Number(p) < this.params.p;
  }
}

import { PasswordService } from './password.service.js';

const FAST = { N: 2 ** 10, r: 8, p: 1 };

describe('PasswordService', () => {
  const service = new PasswordService(FAST);

  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await service.hash('correct horse battery staple');
    expect(await service.verify('correct horse battery staple', hash)).toBe(true);
    expect(await service.verify('correct horse battery stapl', hash)).toBe(false);
  });

  it('salts every hash', async () => {
    const [a, b] = await Promise.all([
      service.hash('same-password'),
      service.hash('same-password'),
    ]);
    expect(a).not.toBe(b);
  });

  it('encodes parameters so they can be raised later', async () => {
    const hash = await service.hash('password-123');
    expect(hash.startsWith(`scrypt$${FAST.N}$${FAST.r}$${FAST.p}$`)).toBe(true);
    expect(new PasswordService({ N: 2 ** 12, r: 8, p: 1 }).needsRehash(hash)).toBe(true);
    expect(service.needsRehash(hash)).toBe(false);
  });

  it('verifies hashes created with older parameters', async () => {
    const legacy = await service.hash('password-123');
    const stronger = new PasswordService({ N: 2 ** 11, r: 8, p: 1 });
    expect(await stronger.verify('password-123', legacy)).toBe(true);
  });

  it('rejects malformed hashes instead of throwing', async () => {
    expect(await service.verify('x', 'not-a-hash')).toBe(false);
    expect(await service.verify('x', 'bcrypt$1$2$3$4$5')).toBe(false);
  });

  it('normalizes unicode so equivalent inputs match', async () => {
    const composed = 'café-password';
    const decomposed = 'café-password';
    const hash = await service.hash(composed);
    expect(await service.verify(decomposed, hash)).toBe(true);
  });
});

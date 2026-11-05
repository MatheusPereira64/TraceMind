import { ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { LoginInput, MeDto, RegisterInput, SessionDto } from '@tracemind/shared';
import { eq } from 'drizzle-orm';
import { toUserDto } from '../common/serializers.js';
import { ENV, type Env } from '../config/env.js';
import { DATABASE, type Database } from '../database/database.module.js';
import { users, type User } from '../database/schema.js';
import { OrganizationsService } from '../organizations/organizations.service.js';
import { PasswordService } from './password.service.js';
import type { SessionTokenPayload } from './auth.types.js';

@Injectable()
export class AuthService {
  /** Hash of a random password, used to keep login timing constant for unknown emails. */
  private dummyHash: Promise<string> | undefined;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly jwt: JwtService,
    private readonly passwords: PasswordService,
    private readonly organizationsService: OrganizationsService,
  ) {}

  async register(input: RegisterInput): Promise<SessionDto> {
    const passwordHash = await this.passwords.hash(input.password);

    const user = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(users)
        .values({ email: input.email, name: input.name, passwordHash })
        .onConflictDoNothing({ target: users.email })
        .returning();
      if (!created) throw new ConflictException('An account with this email already exists');

      await this.organizationsService.createWithOwner(tx, created.id, {
        name: input.organizationName,
      });
      return created;
    });

    return this.issueSession(user);
  }

  async login(input: LoginInput): Promise<SessionDto> {
    const user = await this.db.query.users.findFirst({ where: eq(users.email, input.email) });

    if (!user) {
      // Spend the same time as a real verification to avoid account enumeration by timing.
      await this.passwords.verify(input.password, await this.getDummyHash());
      throw new UnauthorizedException('Invalid email or password');
    }

    const valid = await this.passwords.verify(input.password, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Invalid email or password');

    if (this.passwords.needsRehash(user.passwordHash)) {
      const passwordHash = await this.passwords.hash(input.password);
      await this.db.update(users).set({ passwordHash }).where(eq(users.id, user.id));
    }

    return this.issueSession(user);
  }

  async me(userId: string): Promise<MeDto> {
    const user = await this.db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) throw new UnauthorizedException();
    return {
      user: toUserDto(user),
      organizations: await this.organizationsService.listForUser(user.id),
    };
  }

  private async issueSession(user: User): Promise<SessionDto> {
    const payload: SessionTokenPayload = { sub: user.id };
    const accessToken = await this.jwt.signAsync(payload);
    const expiresAt = new Date(Date.now() + this.env.JWT_TTL_SECONDS * 1000).toISOString();
    return {
      user: toUserDto(user),
      organizations: await this.organizationsService.listForUser(user.id),
      accessToken,
      expiresAt,
    };
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= this.passwords.hash(`dummy-${Math.random()}`);
    return this.dummyHash;
  }
}

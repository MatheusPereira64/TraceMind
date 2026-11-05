import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ENV, type Env } from '../config/env.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { DEFAULT_SCRYPT_PARAMS, PasswordService, SCRYPT_PARAMS } from './password.service.js';
import { SessionGuard } from './session.guard.js';

@Module({
  imports: [
    OrganizationsModule,
    JwtModule.registerAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        secret: env.JWT_SECRET,
        signOptions: { algorithm: 'HS256', expiresIn: env.JWT_TTL_SECONDS, issuer: 'tracemind' },
        verifyOptions: { algorithms: ['HS256'], issuer: 'tracemind' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    { provide: SCRYPT_PARAMS, useValue: DEFAULT_SCRYPT_PARAMS },
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
  exports: [PasswordService],
})
export class AuthModule {}

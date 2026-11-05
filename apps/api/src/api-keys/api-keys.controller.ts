import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  createApiKeySchema,
  type ApiKeyDto,
  type CreatedApiKeyDto,
  type Environment,
} from '@tracemind/shared';
import type { ApiKeyPrincipal, AuthenticatedUser } from '../auth/auth.types.js';
import { ApiKeyAuth, CurrentApiKey, CurrentUser } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ApiKeyGuard } from './api-key.guard.js';
import { ApiKeysService } from './api-keys.service.js';

const uuid = new ParseUUIDPipe({ version: '4' });

@Controller('v1')
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  @Get('projects/:projectId/api-keys')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', uuid) projectId: string,
  ): Promise<ApiKeyDto[]> {
    return this.apiKeys.list(user.id, projectId);
  }

  /** The plaintext key is returned only in this response. */
  @Post('projects/:projectId/api-keys')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', uuid) projectId: string,
    @Body(new ZodValidationPipe(createApiKeySchema))
    body: { name: string; environment: Environment; expiresAt?: string },
  ): Promise<CreatedApiKeyDto> {
    return this.apiKeys.create(user.id, projectId, body);
  }

  @Delete('projects/:projectId/api-keys/:keyId')
  revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', uuid) projectId: string,
    @Param('keyId', uuid) keyId: string,
  ): Promise<ApiKeyDto> {
    return this.apiKeys.revoke(user.id, projectId, keyId);
  }

  /**
   * Lets SDKs and the CLI validate their configuration: returns the project and environment the
   * key is bound to, without exposing anything else.
   */
  @ApiKeyAuth()
  @UseGuards(ApiKeyGuard)
  @Get('ingest/whoami')
  whoami(@CurrentApiKey() principal: ApiKeyPrincipal): Omit<ApiKeyPrincipal, 'keyId'> {
    return {
      projectId: principal.projectId,
      organizationId: principal.organizationId,
      environment: principal.environment,
    };
  }
}

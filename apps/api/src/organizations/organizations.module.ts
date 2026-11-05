import { Module } from '@nestjs/common';
import { AccessService } from './access.service.js';
import { OrganizationsController } from './organizations.controller.js';
import { OrganizationsService } from './organizations.service.js';

@Module({
  controllers: [OrganizationsController],
  providers: [OrganizationsService, AccessService],
  exports: [OrganizationsService, AccessService],
})
export class OrganizationsModule {}

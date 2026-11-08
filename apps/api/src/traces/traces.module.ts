import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { TracesController } from './traces.controller.js';
import { TracesService } from './traces.service.js';

@Module({
  imports: [OrganizationsModule],
  controllers: [TracesController],
  providers: [TracesService],
  exports: [TracesService],
})
export class TracesModule {}

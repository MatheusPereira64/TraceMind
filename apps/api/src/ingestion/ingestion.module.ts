import { Module } from '@nestjs/common';
import { ApiKeysModule } from '../api-keys/api-keys.module.js';
import { IngestionController } from './ingestion.controller.js';
import { IngestionProcessor } from './ingestion.processor.js';
import { IngestionQueue } from './ingestion.queue.js';
import { IngestionService } from './ingestion.service.js';
import { PricingService } from './pricing.service.js';

@Module({
  imports: [ApiKeysModule],
  controllers: [IngestionController],
  providers: [IngestionService, IngestionQueue, IngestionProcessor, PricingService],
  exports: [IngestionService, IngestionQueue, PricingService],
})
export class IngestionModule {}

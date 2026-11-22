import { Module } from '@nestjs/common';
import { RetentionScheduler } from './retention.scheduler.js';

@Module({
  providers: [RetentionScheduler],
  exports: [RetentionScheduler],
})
export class RetentionModule {}

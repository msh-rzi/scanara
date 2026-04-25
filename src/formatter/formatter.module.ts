import { Module } from '@nestjs/common';
import { FormatterService } from './formatter.service';

@Module({
  providers: [FormatterService],
  exports: [FormatterService],
})
export class FormatterModule {}

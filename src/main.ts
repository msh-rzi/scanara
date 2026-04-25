import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as Sentry from '@sentry/nestjs';

async function bootstrap() {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
  });

  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, Context } from 'grammy';
import { parseMode } from './telegram-parse-mode';

@Injectable()
export class TelegramBotService {
  readonly bot: Bot<Context>;

  constructor(private readonly configService: ConfigService) {
    this.bot = new Bot<Context>(
      this.configService.getOrThrow<string>('BOT_TOKEN'),
    );
    this.bot.api.config.use(parseMode('HTML'));
  }
}

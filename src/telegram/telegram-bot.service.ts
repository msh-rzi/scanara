import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, Context } from 'grammy';

@Injectable()
export class TelegramBotService {
  readonly bot: Bot<Context>;

  constructor(private readonly configService: ConfigService) {
    this.bot = new Bot<Context>(
      this.configService.getOrThrow<string>('BOT_TOKEN'),
    );
  }
}

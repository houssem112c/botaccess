import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { DiscordBotService } from './discord-bot.service.js';
import { PrismaService } from './prisma.service.js';

@Module({
  imports: [],
  controllers: [AppController],
  providers: [AppService, PrismaService, DiscordBotService],
})
export class AppModule {}

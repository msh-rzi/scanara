import { Injectable } from '@nestjs/common';
import { User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

function isSameUtcDay(left: Date, right: Date): boolean {
  return (
    left.getUTCFullYear() === right.getUTCFullYear() &&
    left.getUTCMonth() === right.getUTCMonth() &&
    left.getUTCDate() === right.getUTCDate()
  );
}

@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

  async findOrCreate(telegramId: bigint, username?: string): Promise<User> {
    const existingUser = await this.prisma.user.findUnique({
      where: {
        telegramId,
      },
    });

    if (existingUser) {
      if (username !== existingUser.username) {
        return this.prisma.user.update({
          where: {
            id: existingUser.id,
          },
          data: {
            username,
          },
        });
      }

      return existingUser;
    }

    return this.prisma.user.create({
      data: {
        telegramId,
        username,
      },
    });
  }

  async canScan(userId: number): Promise<boolean> {
    const user = await this.getUserWithDailyReset(userId);

    return user.isPremium || user.scansToday < 3;
  }

  async recordScan(userId: number): Promise<void> {
    await this.getUserWithDailyReset(userId);
    await this.prisma.user.update({
      where: {
        id: userId,
      },
      data: {
        scansToday: {
          increment: 1,
        },
        lastScanAt: new Date(),
      },
    });
  }

  private async getUserWithDailyReset(userId: number): Promise<User> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: {
        id: userId,
      },
    });

    if (user.lastScanAt && !isSameUtcDay(user.lastScanAt, new Date())) {
      return this.prisma.user.update({
        where: {
          id: userId,
        },
        data: {
          scansToday: 0,
          lastScanAt: null,
        },
      });
    }

    return user;
  }
}

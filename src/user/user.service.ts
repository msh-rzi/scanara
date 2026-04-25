import { Injectable } from '@nestjs/common';
import { Prisma, User } from '@prisma/client';
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

  async canUsePremium(userId: number): Promise<boolean> {
    const user = await this.getUserWithDailyReset(userId);
    return user.isPremium;
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

  async activatePremium(userId: number, premiumUntil?: Date | null): Promise<User> {
    return this.prisma.user.update({
      where: {
        id: userId,
      },
      data: {
        isPremium: true,
        premiumUntil: premiumUntil ?? null,
      },
    });
  }

  async getScanHistory(userId: number, page = 1, limit = 10): Promise<any[]> {
    const offset = (page - 1) * limit;
    return this.prisma.scan.findMany({
      where: {
        userId,
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: limit,
      skip: offset,
    });
  }

  private async getUserWithDailyReset(userId: number): Promise<User> {
    const now = new Date();
    const user = await this.prisma.user.findUniqueOrThrow({
      where: {
        id: userId,
      },
    });

    const updates: Prisma.UserUpdateInput = {};

    if (user.lastScanAt && !isSameUtcDay(user.lastScanAt, now)) {
      updates.scansToday = 0;
      updates.lastScanAt = null;
    }

    if (user.premiumUntil && user.premiumUntil <= now) {
      updates.isPremium = false;
    }

    if (Object.keys(updates).length > 0) {
      return this.prisma.user.update({
        where: {
          id: userId,
        },
        data: updates,
      });
    }

    return user;
  }
}

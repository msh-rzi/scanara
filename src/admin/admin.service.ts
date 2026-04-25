import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async getStats() {
    const totalUsers = await this.prisma.user.count();
    const premiumUsers = await this.prisma.user.count({
      where: {
        isPremium: true,
      },
    });
    const freeUsers = totalUsers - premiumUsers;
    const totalScans = await this.prisma.scan.count();
    const scansToday = await this.prisma.scan.count({
      where: {
        createdAt: {
          gte: new Date(new Date().setHours(0, 0, 0, 0)),
        },
      },
    });

    const topScannedTokens = await this.prisma.scan.groupBy({
      by: ['mintAddress'],
      _count: {
        mintAddress: true,
      },
      orderBy: {
        _count: {
          mintAddress: 'desc',
        },
      },
      take: 5,
    });

    const conversionRate = totalUsers > 0 ? ((premiumUsers / totalUsers) * 100).toFixed(1) : '0.0';

    return {
      totalUsers,
      premiumUsers,
      freeUsers,
      totalScans,
      scansToday,
      topScannedTokens: topScannedTokens.map((item) => ({
        address: item.mintAddress,
        scans: item._count.mintAddress,
      })),
      conversionRate,
    };
  }
}
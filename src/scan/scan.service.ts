import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ScanResult } from '../scanner/scanner.types';

function toJsonResult(result: ScanResult): Prisma.InputJsonValue {
  return {
    ...result,
    scannedAt: result.scannedAt,
    checks: {
      ...result.checks,
      topHolderConcentration: {
        ...result.checks.topHolderConcentration,
        holders: result.checks.topHolderConcentration.holders.map((holder) => ({
          ...holder,
        })),
      },
    },
    metadata: {
      ...result.metadata,
    },
  };
}

@Injectable()
export class ScanService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: number, mintAddress: string, result: ScanResult) {
    return this.prisma.scan.create({
      data: {
        userId,
        mintAddress,
        score: result.score,
        result: toJsonResult(result),
      },
    });
  }
}

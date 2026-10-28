import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '../../generated/prisma/client';
import { QuoteEstimatesService } from './quote-estimates.service';

describe('QuoteEstimatesService manager access', () => {
  const prisma = {
    company: { findFirst: jest.fn() },
  };
  const service = new QuoteEstimatesService(
    prisma as any,
    {} as any,
    {} as any,
  );

  beforeEach(() => jest.clearAllMocks());

  it('accepts only a company or project assignment for a manager', async () => {
    prisma.company.findFirst.mockResolvedValue({ id: 'company-1' });

    await (service as any).assertCompany(
      'company-1',
      'manager-1',
      UserRole.manager,
    );

    expect(prisma.company.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'company-1',
        isActive: true,
        OR: [
          { members: { some: { userId: 'manager-1' } } },
          {
            projects: {
              some: { teamMembers: { some: { userId: 'manager-1' } } },
            },
          },
        ],
      },
      select: { id: true },
    });
  });

  it('removes financial fields from manager responses', () => {
    const result = (service as any).serialize(
      {
        subtotal: 100,
        discountAmount: 5,
        taxAmount: 10,
        totalAmount: 105,
        pricingConfig: { internal: true },
        tasks: [{ title: 'Work', quantity: 1, unitPrice: 100, totalPrice: 100 }],
      },
      UserRole.manager,
    );

    expect(result).toEqual({
      tasks: [{ title: 'Work', quantity: 1, estimatedHours: undefined }],
    });
  });

  it('rejects workers from quote author routes', () => {
    expect(() =>
      (service as any).assertQuoteAuthor(UserRole.worker),
    ).toThrow(ForbiddenException);
  });
});

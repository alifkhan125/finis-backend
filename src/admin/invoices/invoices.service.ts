import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import PDFDocument from 'pdfkit';
import {
  PaymentMethod,
  PaymentStatus,
  Prisma,
  ProjectFinancialStatus,
  ProjectInvoiceStatus,
  UserRole,
} from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AllocatePaymentDto,
  BillableTasksFilterDto,
  CreateProjectInvoiceDto,
  ListProjectInvoicesDto,
  RecordPaymentDto,
  UpdateInvoiceStatusDto,
} from './dto/invoice.dto';

@Injectable()
export class ProjectInvoicesService {
  constructor(private prisma: PrismaService) {}

  private assertAdminBillingAccess(userRole: string) {
    if (userRole !== UserRole.admin && userRole !== UserRole.super_admin) {
      throw new ForbiddenException('Only admin can access project invoices');
    }
  }

  private getDateRange(startDate: string, endDate: string) {
    const start = new Date(startDate);
    const end = new Date(endDate);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new BadRequestException('Invalid invoice date range');
    }

    end.setHours(23, 59, 59, 999);

    if (start > end) {
      throw new BadRequestException('Start date must be before end date');
    }

    return { start, end };
  }

  private roundMoney(value: number) {
    return Math.round(value * 100) / 100;
  }

  private async assertProjectAccess(
    projectId: string,
    userId: string,
    userRole: string,
  ) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        name: true,
        companyId: true,
        company: { select: { id: true, name: true, ownerId: true } },
      },
    });

    if (!project) throw new NotFoundException('Project not found');
    if (userRole === UserRole.super_admin) return project;
    if (project.company.ownerId === userId) return project;

    const membership = await this.prisma.companyMember.findUnique({
      where: {
        companyId_userId: {
          companyId: project.companyId,
          userId,
        },
      },
      select: { role: true },
    });

    if (membership?.role === 'admin') return project;

    throw new ForbiddenException('You do not have access to this project');
  }

  private async buildInvoiceLines(
    projectId: string,
    start: Date,
    end: Date,
  ) {
    const subTasks = await this.prisma.subTask.findMany({
      where: {
        task: { projectId },
        status: 'completed',
        approvalDecision: 'approved',
        completedAt: { gte: start, lte: end },
        invoiceLines: {
          none: {
            invoice: {
              status: { not: 'voided' },
            },
          },
        },
      },
      select: {
        id: true,
        title: true,
        completedAt: true,
        price: true,
        task: { select: { id: true, title: true } },
        unit: {
          select: {
            name: true,
            floor: { select: { name: true } },
          },
        },
        taskAssignee: {
          select: {
            user: { select: { fullName: true } },
          },
        },
      },
      orderBy: { completedAt: 'asc' },
    });

    return subTasks.map((subTask) => {
      const unitValue = this.roundMoney(subTask.price ?? 0);
      return {
        subTaskId: subTask.id,
        taskId: subTask.task.id,
        taskTitle: subTask.task.title,
        title: subTask.title,
        unitName: subTask.unit?.name ?? null,
        floorName: subTask.unit?.floor?.name ?? null,
        workerName: subTask.taskAssignee?.user?.fullName ?? null,
        completedAt: subTask.completedAt ?? new Date(),
        quantity: 1,
        unitValue,
        lineTotal: unitValue,
      };
    });
  }

  private async nextInvoiceNumber() {
    const today = new Date();
    const stamp = today.toISOString().slice(0, 10).replace(/-/g, '');
    const count = await this.prisma.projectInvoice.count({
      where: {
        createdAt: {
          gte: new Date(today.getFullYear(), today.getMonth(), today.getDate()),
        },
      },
    });
    return `INV-${stamp}-${String(count + 1).padStart(4, '0')}`;
  }

  private async nextPaymentNumber(tx?: Prisma.TransactionClient) {
    const client = tx || this.prisma;
    const today = new Date();
    const stamp = today.toISOString().slice(0, 10).replace(/-/g, '');
    const count = await client.payment.count({
      where: {
        createdAt: {
          gte: new Date(today.getFullYear(), today.getMonth(), today.getDate()),
        },
      },
    });
    return `PAY-${stamp}-${String(count + 1).padStart(4, '0')}`;
  }

  async getBillableTasks(
    dto: BillableTasksFilterDto,
    userId: string,
    userRole: string,
  ) {
    this.assertAdminBillingAccess(userRole);
    await this.assertProjectAccess(dto.projectId, userId, userRole);

    let dateFilter: { completedAt?: { gte?: Date; lte?: Date } } = {};
    if (dto.startDate || dto.endDate) {
      const start = dto.startDate ? new Date(dto.startDate) : new Date(0);
      const end = dto.endDate ? new Date(dto.endDate) : new Date();
      end.setHours(23, 59, 59, 999);
      dateFilter = { completedAt: { gte: start, lte: end } };
    }

    const subTasks = await this.prisma.subTask.findMany({
      where: {
        task: { projectId: dto.projectId },
        status: 'completed',
        approvalDecision: 'approved',
        ...dateFilter,
        invoiceLines: {
          none: {
            invoice: {
              status: { not: 'voided' },
            },
          },
        },
      },
      include: {
        task: { select: { id: true, title: true } },
        unit: {
          select: {
            id: true,
            name: true,
            floor: { select: { id: true, name: true } },
          },
        },
        taskAssignee: {
          select: {
            user: { select: { id: true, fullName: true } },
          },
        },
      },
      orderBy: { completedAt: 'asc' },
    });

    const totalAmount = this.roundMoney(
      subTasks.reduce((sum, s) => sum + (s.price ?? 0), 0),
    );

    return {
      count: subTasks.length,
      totalAmount,
      items: subTasks.map((s) => ({
        subTaskId: s.id,
        taskId: s.task.id,
        taskTitle: s.task.title,
        title: s.title,
        unitName: s.unit?.name ?? null,
        floorName: s.unit?.floor?.name ?? null,
        workerName: s.taskAssignee?.user?.fullName ?? null,
        completedAt: s.completedAt,
        price: s.price,
      })),
    };
  }

  async createInvoice(
    dto: CreateProjectInvoiceDto,
    userId: string,
    userRole: string,
  ) {
    this.assertAdminBillingAccess(userRole);
    await this.assertProjectAccess(dto.projectId, userId, userRole);

    const { start, end } = this.getDateRange(dto.startDate, dto.endDate);
    const lines = await this.buildInvoiceLines(dto.projectId, start, end);

    if (lines.length === 0) {
      throw new BadRequestException(
        'No completed and approved unbilled subtasks found for this date range',
      );
    }

    const subtotal = this.roundMoney(
      lines.reduce((sum, line) => sum + line.lineTotal, 0),
    );

    const initialStatus = dto.status ?? ProjectInvoiceStatus.issued;

    return this.prisma.projectInvoice.create({
      data: {
        projectId: dto.projectId,
        createdById: userId,
        invoiceNumber: await this.nextInvoiceNumber(),
        status: initialStatus,
        startDate: start,
        endDate: end,
        billableUnits: lines.length,
        subtotal,
        total: subtotal,
        notes: dto.notes?.trim() || null,
        issuedAt:
          initialStatus === ProjectInvoiceStatus.issued ? new Date() : null,
        lines: { create: lines },
      },
      include: this.invoiceInclude(),
    });
  }

  async listInvoices(
    dto: ListProjectInvoicesDto,
    userId: string,
    userRole: string,
  ) {
    this.assertAdminBillingAccess(userRole);

    return this.prisma.projectInvoice.findMany({
      where: {
        ...(dto.projectId ? { projectId: dto.projectId } : {}),
        ...(dto.companyId
          ? { project: { companyId: dto.companyId } }
          : {}),
        ...(userRole === UserRole.admin
          ? {
              project: {
                company: {
                  OR: [
                    { ownerId: userId },
                    {
                      members: {
                        some: {
                          userId,
                          role: 'admin',
                        },
                      },
                    },
                  ],
                },
              },
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: {
        project: {
          select: {
            id: true,
            name: true,
            company: { select: { id: true, name: true } },
          },
        },
        allocations: {
          select: {
            amount: true,
          },
        },
        _count: { select: { lines: true } },
      },
    });
  }

  async getInvoice(id: string, userId: string, userRole: string) {
    this.assertAdminBillingAccess(userRole);

    const invoice = await this.prisma.projectInvoice.findUnique({
      where: { id },
      include: this.invoiceInclude(),
    });

    if (!invoice) throw new NotFoundException('Invoice not found');
    await this.assertProjectAccess(invoice.projectId, userId, userRole);
    return invoice;
  }

  async updateInvoiceStatus(
    id: string,
    dto: UpdateInvoiceStatusDto,
    userId: string,
    userRole: string,
  ) {
    this.assertAdminBillingAccess(userRole);
    const invoice = await this.getInvoice(id, userId, userRole);

    if (dto.status === ProjectInvoiceStatus.voided) {
      return this.voidInvoice(id, dto.notes, userId, userRole);
    }

    const data: Prisma.ProjectInvoiceUpdateInput = {
      status: dto.status,
      notes: dto.notes
        ? `${invoice.notes || ''}\n${dto.notes}`.trim()
        : undefined,
    };

    if (dto.status === ProjectInvoiceStatus.issued && !invoice.issuedAt) {
      data.issuedAt = new Date();
    }
    if (dto.status === ProjectInvoiceStatus.paid && !invoice.paidAt) {
      data.paidAt = new Date();
    }

    return this.prisma.projectInvoice.update({
      where: { id },
      data,
      include: this.invoiceInclude(),
    });
  }

  async voidInvoice(
    id: string,
    reason: string | undefined,
    userId: string,
    userRole: string,
  ) {
    this.assertAdminBillingAccess(userRole);
    const invoice = await this.getInvoice(id, userId, userRole);

    if (invoice.status === ProjectInvoiceStatus.voided) {
      return invoice;
    }

    return this.prisma.$transaction(async (tx) => {
      const allocations = await tx.invoicePaymentAllocation.findMany({
        where: { invoiceId: id },
      });

      for (const alloc of allocations) {
        await tx.payment.update({
          where: { id: alloc.paymentId },
          data: {
            allocatedAmount: { decrement: alloc.amount },
            unallocatedAmount: { increment: alloc.amount },
            status: PaymentStatus.partially_allocated,
          },
        });
      }

      await tx.invoicePaymentAllocation.deleteMany({
        where: { invoiceId: id },
      });

      const updatedNotes = [
        invoice.notes,
        reason
          ? `Voided on ${new Date().toISOString()}: ${reason}`
          : `Voided on ${new Date().toISOString()}`,
      ]
        .filter(Boolean)
        .join('\n');

      return tx.projectInvoice.update({
        where: { id },
        data: {
          status: ProjectInvoiceStatus.voided,
          notes: updatedNotes,
        },
        include: this.invoiceInclude(),
      });
    });
  }

  async recordPayment(
    dto: RecordPaymentDto,
    userId: string,
    userRole: string,
  ) {
    this.assertAdminBillingAccess(userRole);
    await this.assertProjectAccess(dto.projectId, userId, userRole);

    if (dto.amount <= 0) {
      throw new BadRequestException('Payment amount must be greater than 0');
    }

    const amountDecimal = new Prisma.Decimal(this.roundMoney(dto.amount));

    return this.prisma.$transaction(async (tx) => {
      const paymentNumber = await this.nextPaymentNumber(tx);

      const payment = await tx.payment.create({
        data: {
          projectId: dto.projectId,
          recordedById: userId,
          paymentNumber,
          amount: amountDecimal,
          allocatedAmount: new Prisma.Decimal(0),
          unallocatedAmount: amountDecimal,
          method: dto.method ?? PaymentMethod.other,
          status: PaymentStatus.recorded,
          paidAt: dto.paidAt ? new Date(dto.paidAt) : new Date(),
          notes: dto.notes?.trim() || null,
        },
      });

      await tx.project.update({
        where: { id: dto.projectId },
        data: {
          totalReceived: { increment: amountDecimal },
          contractBalance: { decrement: amountDecimal },
        },
      });

      const updatedProject = await tx.project.findUnique({
        where: { id: dto.projectId },
      });

      if (updatedProject) {
        const balance = Number(updatedProject.contractBalance);
        const received = Number(updatedProject.totalReceived);
        let nextStatus: ProjectFinancialStatus = ProjectFinancialStatus.unpaid;
        if (balance <= 0) {
          nextStatus = ProjectFinancialStatus.fully_paid;
        } else if (received > 0) {
          nextStatus = ProjectFinancialStatus.partially_paid;
        }

        await tx.project.update({
          where: { id: dto.projectId },
          data: { financialStatus: nextStatus },
        });
      }

      if (dto.allocateToInvoiceId) {
        const targetInvoice = await tx.projectInvoice.findUnique({
          where: { id: dto.allocateToInvoiceId },
          include: { allocations: true },
        });

        if (targetInvoice && targetInvoice.projectId === dto.projectId) {
          const currentAllocated = targetInvoice.allocations.reduce(
            (sum, a) => sum + Number(a.amount),
            0,
          );
          const remainingDue = Math.max(
            0,
            targetInvoice.total - currentAllocated,
          );
          const allocAmount = Math.min(dto.amount, remainingDue);

          if (allocAmount > 0) {
            const allocDecimal = new Prisma.Decimal(
              this.roundMoney(allocAmount),
            );
            await tx.invoicePaymentAllocation.create({
              data: {
                paymentId: payment.id,
                invoiceId: targetInvoice.id,
                amount: allocDecimal,
                notes: 'Allocated upon payment record',
              },
            });

            const nextAllocatedTotal =
              Number(payment.allocatedAmount) + allocAmount;
            const nextUnallocated = Math.max(
              0,
              Number(payment.amount) - nextAllocatedTotal,
            );

            await tx.payment.update({
              where: { id: payment.id },
              data: {
                allocatedAmount: new Prisma.Decimal(nextAllocatedTotal),
                unallocatedAmount: new Prisma.Decimal(nextUnallocated),
                status:
                  nextUnallocated === 0
                    ? PaymentStatus.allocated
                    : PaymentStatus.partially_allocated,
              },
            });

            if (currentAllocated + allocAmount >= targetInvoice.total) {
              await tx.projectInvoice.update({
                where: { id: targetInvoice.id },
                data: {
                  status: ProjectInvoiceStatus.paid,
                  paidAt: new Date(),
                },
              });
            } else {
              await tx.projectInvoice.update({
                where: { id: targetInvoice.id },
                data: {
                  status: ProjectInvoiceStatus.partially_paid,
                },
              });
            }
          }
        }
      }

      const createdPayment = await tx.payment.findUnique({
        where: { id: payment.id },
        include: {
          allocations: {
            include: { invoice: { select: { invoiceNumber: true } } },
          },
          recordedBy: { select: { fullName: true } },
        },
      });

      return createdPayment
        ? {
            ...createdPayment,
            amount: Number(createdPayment.amount || 0),
            allocatedAmount: Number(createdPayment.allocatedAmount || 0),
            unallocatedAmount: Number(createdPayment.unallocatedAmount || 0),
          }
        : null;
    });
  }

  async allocatePayment(
    dto: AllocatePaymentDto,
    userId: string,
    userRole: string,
  ) {
    this.assertAdminBillingAccess(userRole);

    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({
        where: { id: dto.paymentId },
      });
      if (!payment) throw new NotFoundException('Payment not found');
      await this.assertProjectAccess(payment.projectId, userId, userRole);

      const invoice = await tx.projectInvoice.findUnique({
        where: { id: dto.invoiceId },
        include: { allocations: true },
      });
      if (!invoice) throw new NotFoundException('Invoice not found');
      if (invoice.projectId !== payment.projectId) {
        throw new BadRequestException(
          'Payment and Invoice belong to different projects',
        );
      }
      if (invoice.status === ProjectInvoiceStatus.voided) {
        throw new BadRequestException(
          'Cannot allocate payment to a voided invoice',
        );
      }

      const availableToAllocate = Number(payment.unallocatedAmount);
      if (dto.amount > availableToAllocate) {
        throw new BadRequestException(
          `Cannot allocate $${dto.amount}. Only $${availableToAllocate.toFixed(2)} unallocated funds available.`,
        );
      }

      const currentInvoiceAllocated = invoice.allocations.reduce(
        (sum, a) => sum + Number(a.amount),
        0,
      );
      const invoiceRemainingDue = Math.max(
        0,
        invoice.total - currentInvoiceAllocated,
      );
      if (dto.amount > invoiceRemainingDue) {
        throw new BadRequestException(
          `Allocation amount $${dto.amount} exceeds remaining invoice balance of $${invoiceRemainingDue.toFixed(2)}`,
        );
      }

      const allocDecimal = new Prisma.Decimal(this.roundMoney(dto.amount));

      await tx.invoicePaymentAllocation.upsert({
        where: {
          paymentId_invoiceId: {
            paymentId: dto.paymentId,
            invoiceId: dto.invoiceId,
          },
        },
        create: {
          paymentId: dto.paymentId,
          invoiceId: dto.invoiceId,
          amount: allocDecimal,
          notes: dto.notes,
        },
        update: {
          amount: { increment: allocDecimal },
          notes: dto.notes,
        },
      });

      const nextAllocated = Number(payment.allocatedAmount) + dto.amount;
      const nextUnallocated = Number(payment.unallocatedAmount) - dto.amount;

      await tx.payment.update({
        where: { id: dto.paymentId },
        data: {
          allocatedAmount: new Prisma.Decimal(nextAllocated),
          unallocatedAmount: new Prisma.Decimal(nextUnallocated),
          status:
            nextUnallocated <= 0
              ? PaymentStatus.allocated
              : PaymentStatus.partially_allocated,
        },
      });

      const newTotalAllocatedOnInvoice = currentInvoiceAllocated + dto.amount;
      if (newTotalAllocatedOnInvoice >= invoice.total) {
        await tx.projectInvoice.update({
          where: { id: dto.invoiceId },
          data: {
            status: ProjectInvoiceStatus.paid,
            paidAt: new Date(),
          },
        });
      } else {
        await tx.projectInvoice.update({
          where: { id: dto.invoiceId },
          data: {
            status: ProjectInvoiceStatus.partially_paid,
          },
        });
      }

      return {
        message: 'Payment allocated successfully',
        allocatedAmount: dto.amount,
        remainingInvoiceDue: Math.max(
          0,
          invoice.total - newTotalAllocatedOnInvoice,
        ),
      };
    });
  }

  async listProjectPayments(
    projectId: string,
    userId: string,
    userRole: string,
  ) {
    this.assertAdminBillingAccess(userRole);
    await this.assertProjectAccess(projectId, userId, userRole);

    const payments = await this.prisma.payment.findMany({
      where: { projectId },
      orderBy: { paidAt: 'desc' },
      include: {
        allocations: {
          include: {
            invoice: {
              select: {
                id: true,
                invoiceNumber: true,
                total: true,
                status: true,
              },
            },
          },
        },
        recordedBy: {
          select: { id: true, fullName: true, email: true },
        },
      },
    });

    return payments.map((p) => ({
      ...p,
      amount: Number(p.amount || 0),
      allocatedAmount: Number(p.allocatedAmount || 0),
      unallocatedAmount: Number(p.unallocatedAmount || 0),
    }));
  }

  async voidPayment(
    paymentId: string,
    reason: string | undefined,
    userId: string,
    userRole: string,
  ) {
    this.assertAdminBillingAccess(userRole);
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { allocations: true },
    });
    if (!payment) throw new NotFoundException('Payment not found');
    await this.assertProjectAccess(payment.projectId, userId, userRole);

    if (payment.status === PaymentStatus.voided) {
      return payment;
    }

    return this.prisma.$transaction(async (tx) => {
      for (const alloc of payment.allocations) {
        await tx.invoicePaymentAllocation.delete({
          where: { id: alloc.id },
        });

        const remainingAllocations =
          await tx.invoicePaymentAllocation.findMany({
            where: { invoiceId: alloc.invoiceId },
          });

        const currentAllocated = remainingAllocations.reduce(
          (sum, a) => sum + Number(a.amount),
          0,
        );

        const targetInvoice = await tx.projectInvoice.findUnique({
          where: { id: alloc.invoiceId },
        });

        if (
          targetInvoice &&
          targetInvoice.status !== ProjectInvoiceStatus.voided
        ) {
          if (currentAllocated >= targetInvoice.total) {
            await tx.projectInvoice.update({
              where: { id: targetInvoice.id },
              data: { status: ProjectInvoiceStatus.paid },
            });
          } else if (currentAllocated > 0) {
            await tx.projectInvoice.update({
              where: { id: targetInvoice.id },
              data: {
                status: ProjectInvoiceStatus.partially_paid,
                paidAt: null,
              },
            });
          } else {
            await tx.projectInvoice.update({
              where: { id: targetInvoice.id },
              data: { status: ProjectInvoiceStatus.issued, paidAt: null },
            });
          }
        }
      }

      await tx.project.update({
        where: { id: payment.projectId },
        data: {
          totalReceived: { decrement: payment.amount },
          contractBalance: { increment: payment.amount },
        },
      });

      const updatedProject = await tx.project.findUnique({
        where: { id: payment.projectId },
      });

      if (updatedProject) {
        const balance = Number(updatedProject.contractBalance);
        const received = Number(updatedProject.totalReceived);
        let nextStatus: ProjectFinancialStatus = ProjectFinancialStatus.unpaid;
        if (balance <= 0) {
          nextStatus = ProjectFinancialStatus.fully_paid;
        } else if (received > 0) {
          nextStatus = ProjectFinancialStatus.partially_paid;
        }

        await tx.project.update({
          where: { id: payment.projectId },
          data: { financialStatus: nextStatus },
        });
      }

      const updatedNotes = [
        payment.notes,
        reason
          ? `Voided on ${new Date().toISOString()}: ${reason}`
          : `Voided on ${new Date().toISOString()}`,
      ]
        .filter(Boolean)
        .join('\n');

      return tx.payment.update({
        where: { id: paymentId },
        data: {
          status: PaymentStatus.voided,
          allocatedAmount: new Prisma.Decimal(0),
          unallocatedAmount: new Prisma.Decimal(0),
          notes: updatedNotes,
        },
        include: {
          allocations: true,
          recordedBy: { select: { fullName: true } },
        },
      });
    });
  }

  async exportPaymentReceiptPdf(
    paymentId: string,
    userId: string,
    userRole: string,
  ) {
    this.assertAdminBillingAccess(userRole);
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        project: {
          select: {
            id: true,
            name: true,
            location: true,
            totalContractAmount: true,
            contractBalance: true,
            company: { select: { name: true } },
          },
        },
        recordedBy: { select: { fullName: true, email: true } },
        allocations: {
          include: {
            invoice: {
              select: {
                invoiceNumber: true,
                startDate: true,
                endDate: true,
                total: true,
              },
            },
          },
        },
      },
    });

    if (!payment) throw new NotFoundException('Payment not found');
    await this.assertProjectAccess(payment.projectId, userId, userRole);

    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks: Buffer[] = [];

    const buffer = await new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (chunk) =>
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
      );
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(22).font('Helvetica-Bold').text('OFFICIAL PAYMENT RECEIPT');
      doc.moveDown(0.4);
      doc
        .fontSize(10)
        .font('Helvetica')
        .fillColor('#64748B')
        .text(
          `Receipt #: ${payment.paymentNumber} | Generated: ${new Date().toLocaleDateString()}`,
        );
      doc.moveDown(0.8);

      const boxY = doc.y;
      doc.rect(40, boxY, 515, 65).fillAndStroke('#F8FAFC', '#E2E8F0');
      doc
        .fillColor('#0F172A')
        .font('Helvetica-Bold')
        .fontSize(11)
        .text(`Project: ${payment.project.name}`, 50, boxY + 10);
      doc.font('Helvetica').fontSize(9).fillColor('#475569');
      doc.text(`Company: ${payment.project.company.name}`, 50, boxY + 26);
      doc.text(
        `Payment Date: ${new Date(payment.paidAt).toLocaleDateString()}`,
        320,
        boxY + 10,
      );
      doc.text(
        `Payment Method: ${String(payment.method).toUpperCase().replace('_', ' ')}`,
        320,
        boxY + 26,
      );
      doc.text(`Received By: ${payment.recordedBy.fullName}`, 320, boxY + 42);

      doc.y = boxY + 80;
      doc.moveDown(0.8);

      const amtY = doc.y;
      doc.rect(40, amtY, 515, 50).fill('#0F172A');
      doc
        .fillColor('#94A3B8')
        .fontSize(9)
        .font('Helvetica')
        .text('TOTAL AMOUNT RECEIVED', 55, amtY + 10);
      doc
        .fillColor('#FFFFFF')
        .fontSize(20)
        .font('Helvetica-Bold')
        .text(
          `$${Number(payment.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
          55,
          amtY + 22,
        );
      doc.y = amtY + 65;
      doc.moveDown(0.8);

      doc
        .fillColor('#0F172A')
        .font('Helvetica-Bold')
        .fontSize(11)
        .text('INVOICE ALLOCATIONS');
      doc.moveDown(0.4);

      if (payment.allocations.length === 0) {
        doc
          .font('Helvetica-Oblique')
          .fontSize(9)
          .fillColor('#64748B')
          .text(
            'This payment is currently held as an unallocated deposit towards future project invoices.',
          );
      } else {
        payment.allocations.forEach((alloc, idx) => {
          const rowY = doc.y;
          if (idx % 2 === 0) {
            doc.rect(40, rowY - 2, 515, 18).fill('#F1F5F9');
          }
          doc
            .fillColor('#1E293B')
            .font('Helvetica-Bold')
            .fontSize(9)
            .text(`Invoice: ${alloc.invoice.invoiceNumber}`, 50, rowY + 2);
          doc
            .fillColor('#64748B')
            .font('Helvetica')
            .fontSize(9)
            .text(
              `Applied Date: ${new Date(alloc.allocatedAt).toLocaleDateString()}`,
              250,
              rowY + 2,
            );
          doc
            .fillColor('#0F172A')
            .font('Helvetica-Bold')
            .fontSize(9)
            .text(`$${Number(alloc.amount).toFixed(2)}`, 450, rowY + 2, {
              align: 'right',
              width: 90,
            });
          doc.y = rowY + 18;
        });
      }

      doc.moveDown(1.5);

      doc
        .fillColor('#0F172A')
        .font('Helvetica-Bold')
        .fontSize(11)
        .text('CURRENT CONTRACT SUMMARY');
      doc.moveDown(0.4);

      const balY = doc.y;
      doc.rect(40, balY, 515, 45).fillAndStroke('#F8FAFC', '#E2E8F0');
      doc.font('Helvetica').fontSize(9).fillColor('#475569');
      doc.text(
        `Unallocated Deposit Available: $${Number(payment.unallocatedAmount).toFixed(2)}`,
        50,
        balY + 10,
      );
      doc.text(
        `Remaining Contract Balance: $${Number(payment.project.contractBalance).toFixed(2)}`,
        50,
        balY + 26,
      );
      doc.text(
        `Total Contract Value: $${Number(payment.project.totalContractAmount).toFixed(2)}`,
        320,
        balY + 10,
      );

      doc.y = balY + 65;
      doc.moveDown(2);

      doc.font('Helvetica').fontSize(9).fillColor('#64748B');
      doc.text(
        'Authorized Signature: ___________________________',
        50,
        doc.y,
      );
      doc.text('Date: ___________________________', 350, doc.y);

      doc.end();
    });

    return {
      buffer,
      filename: `Receipt_${payment.paymentNumber}.pdf`,
    };
  }

  async getProjectProfitability(
    projectId: string,
    userId: string,
    userRole: string,
  ) {
    this.assertAdminBillingAccess(userRole);
    await this.assertProjectAccess(projectId, userId, userRole);

    const fullProject = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        expenses: {
          select: {
            id: true,
            totalAmount: true,
            status: true,
            category: true,
            description: true,
            date: true,
          },
        },
        reimbursementExpenses: {
          select: {
            id: true,
            totalAmount: true,
            status: true,
            title: true,
          },
        },
        changeOrders: {
          where: { status: 'approved' },
          select: { total: true },
        },
        projectInvoices: {
          where: { status: { not: 'voided' } },
          select: { total: true, status: true },
        },
        company: {
          select: { name: true },
        },
      },
    });

    if (!fullProject) throw new NotFoundException('Project not found');

    const contractAmount = Number(fullProject.totalContractAmount || 0);
    const collectedRevenue = Number(fullProject.totalReceived || 0);

    const nonRejectedExpenses = fullProject.expenses.filter(
      (e) => e.status !== 'rejected',
    );
    const expensesCost = nonRejectedExpenses.reduce(
      (sum, e) => sum + (e.totalAmount || 0),
      0,
    );

    const nonRejectedReimbursements =
      fullProject.reimbursementExpenses.filter(
        (r) => String(r.status).toLowerCase() !== 'rejected',
      );
    const reimbursementsCost = nonRejectedReimbursements.reduce(
      (sum, r) => sum + Number(r.totalAmount || 0),
      0,
    );

    const totalCosts = this.roundMoney(expensesCost + reimbursementsCost);

    const grossProfit = this.roundMoney(contractAmount - totalCosts);
    const grossMarginPercent =
      contractAmount > 0
        ? Math.round((grossProfit / contractAmount) * 1000) / 10
        : 0;

    const cashProfit = this.roundMoney(collectedRevenue - totalCosts);
    const cashMarginPercent =
      collectedRevenue > 0
        ? Math.round((cashProfit / collectedRevenue) * 1000) / 10
        : 0;

    const invoicedRevenue = fullProject.projectInvoices.reduce(
      (sum, inv) => sum + Number(inv.total || 0),
      0,
    );

    const materialCost = nonRejectedExpenses
      .filter((e) => String(e.category || '').toLowerCase().includes('material'))
      .reduce((sum, e) => sum + Number(e.totalAmount || 0), 0);

    const subCost = nonRejectedExpenses
      .filter(
        (e) =>
          String(e.category || '').toLowerCase().includes('subcontractor') ||
          String(e.category || '').toLowerCase().includes('labor'),
      )
      .reduce((sum, e) => sum + Number(e.totalAmount || 0), 0);

    const otherCost = Math.max(0, this.roundMoney(totalCosts - materialCost - subCost));

    const breakdownItems = [
      ...nonRejectedExpenses.map((e) => ({
        id: e.id,
        category: e.category || 'other',
        title: e.description || 'Project Expense',
        amount: Number(e.totalAmount || 0),
        date: e.date ? new Date(e.date).toISOString() : new Date().toISOString(),
        submittedBy: 'Admin Expense Claim',
      })),
      ...nonRejectedReimbursements.map((r) => ({
        id: r.id,
        category: 'reimbursement',
        title: r.title || 'Reimbursement Claim',
        amount: Number(r.totalAmount || 0),
        date: new Date().toISOString(),
        submittedBy: 'Field Labor Claim',
      })),
    ];

    return {
      project: {
        id: fullProject.id,
        name: fullProject.name,
        companyName: fullProject.company?.name || 'Company',
        status: fullProject.status,
        financialStatus: fullProject.financialStatus,
      },
      revenue: {
        contractAmount,
        collectedRevenue,
        totalReceived: collectedRevenue,
        invoicedRevenue,
        totalInvoiced: invoicedRevenue,
      },
      costs: {
        expensesCost,
        reimbursementsCost,
        totalCosts,
        totalExpenses: totalCosts,
        expensesCount: nonRejectedExpenses.length,
        reimbursementsCount: nonRejectedReimbursements.length,
      },
      expenses: {
        totalExpenses: totalCosts,
        byCategory: {
          material: materialCost,
          subcontractor: subCost,
          other: otherCost,
        },
        breakdown: breakdownItems,
      },
      profitability: {
        grossProfit,
        grossMarginPercent,
        cashProfit,
        cashMarginPercent,
      },
      expensesBreakdown: nonRejectedExpenses.map((e) => ({
        id: e.id,
        category: e.category,
        description: e.description,
        amount: Number(e.totalAmount || 0),
        date: e.date,
        status: e.status,
      })),
    };
  }

  async exportInvoicePdf(id: string, userId: string, userRole: string) {

    const invoice = await this.getInvoice(id, userId, userRole);
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks: Buffer[] = [];

    const buffer = await new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (chunk) =>
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
      );
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(22).font('Helvetica-Bold').text('Project Progress Invoice');
      doc.moveDown(0.5);
      doc.fontSize(11).font('Helvetica');
      doc.text(`Invoice Number: ${invoice.invoiceNumber}`);
      doc.text(`Status: ${invoice.status.toUpperCase()}`);
      doc.text(`Project: ${invoice.project.name}`);
      doc.text(`Company: ${invoice.project.company.name}`);
      doc.text(
        `Billing Period: ${new Date(invoice.startDate).toLocaleDateString()} - ${new Date(invoice.endDate).toLocaleDateString()}`,
      );
      if (invoice.issuedAt) {
        doc.text(
          `Issued Date: ${new Date(invoice.issuedAt).toLocaleDateString()}`,
        );
      }
      doc.moveDown();

      doc.font('Helvetica-Bold').text('Completed & Approved Items');
      doc.moveDown(0.5);
      invoice.lines.forEach((line, index) => {
        doc.font('Helvetica-Bold').text(`${index + 1}. ${line.title}`, {
          continued: false,
        });
        doc
          .font('Helvetica')
          .fontSize(10)
          .text(
            `${line.taskTitle} | ${line.floorName ?? 'Floor N/A'} / ${line.unitName ?? 'Unit N/A'} | Completed: ${new Date(line.completedAt).toLocaleDateString()}`,
          );
        doc.text(
          `Qty ${line.quantity} x $${line.unitValue.toFixed(2)} = $${line.lineTotal.toFixed(2)}`,
        );
        doc.moveDown(0.4);
      });

      doc.moveDown();
      doc
        .fontSize(14)
        .font('Helvetica-Bold')
        .text(`Total Billable: $${invoice.total.toFixed(2)}`, {
          align: 'right',
        });

      doc.end();
    });

    return {
      buffer,
      filename: `${invoice.invoiceNumber}.pdf`,
    };
  }

  private invoiceInclude() {
    return {
      project: {
        select: {
          id: true,
          name: true,
          company: { select: { id: true, name: true } },
        },
      },
      createdBy: { select: { id: true, fullName: true, email: true } },
      allocations: {
        include: {
          payment: {
            select: {
              paymentNumber: true,
              paidAt: true,
            },
          },
        },
      },
      lines: { orderBy: { completedAt: 'asc' as const } },
    };
  }
}

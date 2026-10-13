import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { UserRole } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateProjectInvoiceDto,
  ListProjectInvoicesDto,
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
        'No completed and approved subtasks found for this date range',
      );
    }

    const subtotal = this.roundMoney(
      lines.reduce((sum, line) => sum + line.lineTotal, 0),
    );

    return this.prisma.projectInvoice.create({
      data: {
        projectId: dto.projectId,
        createdById: userId,
        invoiceNumber: await this.nextInvoiceNumber(),
        startDate: start,
        endDate: end,
        billableUnits: lines.length,
        subtotal,
        total: subtotal,
        notes: dto.notes?.trim() || null,
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
        project: { select: { id: true, name: true, company: { select: { id: true, name: true } } } },
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

      doc.fontSize(22).font('Helvetica-Bold').text('Project Invoice');
      doc.moveDown(0.5);
      doc.fontSize(11).font('Helvetica');
      doc.text(`Invoice: ${invoice.invoiceNumber}`);
      doc.text(`Project: ${invoice.project.name}`);
      doc.text(`Company: ${invoice.project.company.name}`);
      doc.text(
        `Period: ${invoice.startDate.toLocaleDateString()} - ${invoice.endDate.toLocaleDateString()}`,
      );
      doc.moveDown();

      doc.font('Helvetica-Bold').text('Items');
      doc.moveDown(0.5);
      invoice.lines.forEach((line, index) => {
        doc.font('Helvetica-Bold').text(`${index + 1}. ${line.title}`, {
          continued: false,
        });
        doc
          .font('Helvetica')
          .fontSize(10)
          .text(
            `${line.taskTitle} | ${line.floorName ?? 'Floor N/A'} / ${line.unitName ?? 'Unit N/A'} | ${line.completedAt.toLocaleDateString()}`,
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
        .text(`Total: $${invoice.total.toFixed(2)}`, { align: 'right' });

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
      lines: { orderBy: { completedAt: 'asc' as const } },
    };
  }
}

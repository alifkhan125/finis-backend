import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { Prisma, UserRole } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ProjectStatementService {
  constructor(private prisma: PrismaService) {}

  private assertAdminBillingAccess(userRole: string) {
    if (userRole !== UserRole.admin && userRole !== UserRole.super_admin) {
      throw new ForbiddenException(
        'Only admin can access project financial statements',
      );
    }
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

  async getProjectStatement(
    projectId: string,
    userId: string,
    userRole: string,
  ) {
    this.assertAdminBillingAccess(userRole);
    await this.assertProjectAccess(projectId, userId, userRole);

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        company: { select: { id: true, name: true } },
        floors: {
          include: {
            units: true,
          },
          orderBy: { floorNumber: 'asc' },
        },
        tasks: {
          include: {
            subTasks: {
              include: {
                unit: {
                  select: {
                    id: true,
                    name: true,
                    floor: { select: { name: true } },
                  },
                },
                taskAssignee: {
                  select: { user: { select: { fullName: true } } },
                },
                invoiceLines: {
                  where: { invoice: { status: { not: 'voided' } } },
                  select: {
                    id: true,
                    invoiceId: true,
                    invoice: {
                      select: { invoiceNumber: true, status: true },
                    },
                  },
                },
              },
              orderBy: { createdAt: 'asc' },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
        changeOrders: {
          include: {
            items: true,
            createdBy: { select: { fullName: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
        projectInvoices: {
          include: {
            allocations: {
              include: {
                payment: {
                  select: { paymentNumber: true, paidAt: true },
                },
              },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
        payments: {
          include: {
            allocations: {
              include: { invoice: { select: { invoiceNumber: true } } },
            },
            recordedBy: { select: { fullName: true } },
          },
          orderBy: { paidAt: 'desc' },
        },
      },
    });

    if (!project) throw new NotFoundException('Project not found');

    const originalContract = Number(project.originalContract || 0);

    const approvedChangeOrders = project.changeOrders.filter(
      (co) => co.status === 'approved',
    );
    const changeOrdersTotal = approvedChangeOrders.reduce(
      (sum, co) => sum + Number(co.total || 0),
      0,
    );

    const totalContractAmount =
      Number(project.totalContractAmount || 0) ||
      originalContract + changeOrdersTotal;

    let completedWorkValue = 0;
    let incompleteWorkValue = 0;
    let totalSubTasksCount = 0;
    let completedSubTasksCount = 0;

    const allSubTasks: any[] = [];

    for (const task of project.tasks) {
      for (const sub of task.subTasks) {
        totalSubTasksCount++;
        const price = sub.price ?? 0;
        const isCompletedApproved =
          sub.status === 'completed' && sub.approvalDecision === 'approved';

        if (isCompletedApproved) {
          completedWorkValue += price;
          completedSubTasksCount++;
        } else {
          incompleteWorkValue += price;
        }

        allSubTasks.push({
          id: sub.id,
          taskId: task.id,
          taskTitle: task.title,
          title: sub.title,
          status: sub.status,
          approvalDecision: sub.approvalDecision,
          price,
          unitName: sub.unit?.name ?? null,
          floorName: sub.unit?.floor?.name ?? null,
          workerName: sub.taskAssignee?.user?.fullName ?? null,
          completedAt: sub.completedAt,
          isInvoiced: sub.invoiceLines.length > 0,
          invoices: sub.invoiceLines.map((il: any) => ({
            invoiceId: il.invoiceId,
            invoiceNumber: il.invoice.invoiceNumber,
            status: il.invoice.status,
          })),
        });
      }
    }

    if (
      incompleteWorkValue < totalContractAmount - completedWorkValue &&
      totalContractAmount > completedWorkValue
    ) {
      incompleteWorkValue = totalContractAmount - completedWorkValue;
    }

    const activePayments = project.payments.filter((p) => p.status !== 'voided');
    const totalReceived = activePayments.reduce(
      (sum, p) => sum + Number(p.amount || 0),
      0,
    );

    const contractBalance = Math.max(0, totalContractAmount - totalReceived);

    const nonVoidedInvoices = project.projectInvoices.filter(
      (inv) => inv.status !== 'voided',
    );
    const totalInvoiced = nonVoidedInvoices.reduce(
      (sum, inv) => sum + Number(inv.total || 0),
      0,
    );

    const unbilledCompletedValue = Math.max(
      0,
      completedWorkValue - totalInvoiced,
    );

    return {
      project: {
        id: project.id,
        name: project.name,
        companyName: project.company.name,
        location: project.location,
        description: project.description,
        startDate: project.startDate,
        endDate: project.endDate,
        status: project.status,
        financialStatus: project.financialStatus,
        progress: project.progress,
      },
      summary: {
        originalContract,
        changeOrdersCount: approvedChangeOrders.length,
        changeOrdersTotal,
        totalContractAmount,
        completedWorkValue,
        incompleteWorkValue,
        totalSubTasksCount,
        completedSubTasksCount,
        progressPercent:
          totalSubTasksCount > 0
            ? Math.round((completedSubTasksCount / totalSubTasksCount) * 100)
            : 0,
        totalInvoiced,
        unbilledCompletedValue,
        totalReceived,
        contractBalance,
        financialStatus: project.financialStatus,
      },
      subTasks: allSubTasks,
      changeOrders: project.changeOrders.map((co) => ({
        id: co.id,
        number: co.number,
        title: co.title,
        description: co.description,
        status: co.status,
        total: Number(co.total),
        approvedAt: co.approvedAt,
        createdByName: co.createdBy.fullName,
      })),
      invoices: project.projectInvoices.map((inv) => {
        const allocated = inv.allocations.reduce(
          (sum, a) => sum + Number(a.amount || 0),
          0,
        );
        return {
          id: inv.id,
          invoiceNumber: inv.invoiceNumber,
          status: inv.status,
          startDate: inv.startDate,
          endDate: inv.endDate,
          billableUnits: inv.billableUnits,
          total: Number(inv.total),
          allocated,
          due: Math.max(0, Number(inv.total) - allocated),
          issuedAt: inv.issuedAt,
          paidAt: inv.paidAt,
        };
      }),
      payments: project.payments.map((p) => ({
        id: p.id,
        paymentNumber: p.paymentNumber,
        amount: Number(p.amount),
        allocatedAmount: Number(p.allocatedAmount),
        unallocatedAmount: Number(p.unallocatedAmount),
        method: p.method,
        status: p.status,
        paidAt: p.paidAt,
        notes: p.notes,
        recordedByName: p.recordedBy.fullName,
        allocations: p.allocations.map((a) => ({
          invoiceNumber: a.invoice.invoiceNumber,
          amount: Number(a.amount),
          allocatedAt: a.allocatedAt,
        })),
      })),
    };
  }

  async exportStatementPdf(
    projectId: string,
    userId: string,
    userRole: string,
  ) {
    const data = await this.getProjectStatement(projectId, userId, userRole);
    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    const chunks: Buffer[] = [];

    const buffer = await new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (chunk) =>
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
      );
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc
        .fontSize(20)
        .font('Helvetica-Bold')
        .fillColor('#1E293B')
        .text('PROJECT STATEMENT & FINANCIAL AUDIT');
      doc
        .fontSize(10)
        .font('Helvetica')
        .fillColor('#64748B')
        .text(
          `Generated on: ${new Date().toLocaleDateString()} | Confidential`,
        );
      doc.moveDown(0.8);

      const currentY = doc.y;
      doc.rect(36, currentY, 523, 70).fillAndStroke('#F8FAFC', '#E2E8F0');
      const boxY = currentY + 8;
      doc
        .fillColor('#0F172A')
        .font('Helvetica-Bold')
        .fontSize(12)
        .text(`Project: ${data.project.name}`, 46, boxY);
      doc.font('Helvetica').fontSize(9).fillColor('#475569');
      doc.text(`Company: ${data.project.companyName}`, 46, boxY + 18);
      doc.text(`Location: ${data.project.location || 'N/A'}`, 46, boxY + 32);
      doc.text(
        `Work Status: ${String(data.project.status).toUpperCase()} (${data.summary.progressPercent}% Completed)`,
        300,
        boxY + 18,
      );
      doc.text(
        `Financial Status: ${String(data.summary.financialStatus).toUpperCase()}`,
        300,
        boxY + 32,
      );
      doc.y = boxY + 68;
      doc.moveDown(1);

      doc
        .fillColor('#0F172A')
        .font('Helvetica-Bold')
        .fontSize(13)
        .text('EXECUTIVE FINANCIAL SUMMARY');
      doc.moveDown(0.4);

      const formatMoney = (n: number) =>
        `$${n.toLocaleString('en-US', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}`;

      const metrics = [
        ['Original Contract', formatMoney(data.summary.originalContract)],
        [
          'Approved Change Orders',
          `+ ${formatMoney(data.summary.changeOrdersTotal)} (${data.summary.changeOrdersCount} items)`,
        ],
        [
          'Total Adjusted Contract',
          formatMoney(data.summary.totalContractAmount),
        ],
        ['Completed Work Value', formatMoney(data.summary.completedWorkValue)],
        [
          'Incomplete Work Value',
          formatMoney(data.summary.incompleteWorkValue),
        ],
        [
          'Total Payments Received',
          formatMoney(data.summary.totalReceived),
        ],
        [
          'Remaining Contract Balance',
          formatMoney(data.summary.contractBalance),
        ],
      ];

      metrics.forEach(([label, val], idx) => {
        const rowY = doc.y;
        if (idx % 2 === 0) {
          doc.rect(36, rowY - 2, 523, 18).fill('#F1F5F9');
        }
        doc
          .fillColor('#334155')
          .font('Helvetica-Bold')
          .fontSize(9)
          .text(label, 46, rowY + 2);
        const isBalance = label.includes('Balance');
        doc
          .fillColor(isBalance ? '#DC2626' : '#0F172A')
          .font('Helvetica-Bold')
          .fontSize(9)
          .text(val, 380, rowY + 2, { align: 'right', width: 170 });
        doc.y = rowY + 18;
      });

      doc.moveDown(1);

      doc
        .fillColor('#0F172A')
        .font('Helvetica-Bold')
        .fontSize(12)
        .text('WORK SCOPE & TASK PROGRESS');
      doc.moveDown(0.3);

      doc.fontSize(8).font('Helvetica-Bold').fillColor('#64748B');
      doc.text('ITEM / SUBTASK', 46, doc.y);
      doc.text('LOCATION', 260, doc.y - 10);
      doc.text('STATUS', 380, doc.y - 10);
      doc.text('VALUE', 480, doc.y - 10, { width: 70, align: 'right' });
      doc.moveDown(0.4);

      data.subTasks.slice(0, 35).forEach((item, index) => {
        const itemY = doc.y;
        if (itemY > 740) {
          doc.addPage();
        }
        const loc =
          [item.floorName, item.unitName].filter(Boolean).join(' / ') ||
          'General';
        const isDone = item.status === 'completed';

        doc
          .fillColor('#1E293B')
          .font('Helvetica')
          .fontSize(8)
          .text(`${index + 1}. ${item.title.substring(0, 38)}`, 46, itemY);
        doc.fillColor('#64748B').text(loc.substring(0, 22), 260, itemY);
        doc
          .fillColor(isDone ? '#16A34A' : '#D97706')
          .font('Helvetica-Bold')
          .text(isDone ? 'Completed' : 'Pending', 380, itemY);
        doc
          .fillColor('#0F172A')
          .font('Helvetica')
          .text(formatMoney(item.price), 480, itemY, {
            width: 70,
            align: 'right',
          });
        doc.y = itemY + 14;
      });

      if (data.subTasks.length > 35) {
        doc
          .font('Helvetica-Oblique')
          .fontSize(8)
          .fillColor('#64748B')
          .text(
            `... and ${data.subTasks.length - 35} more items not shown here (full breakdown visible in web dashboard).`,
            46,
            doc.y + 4,
          );
      }

      doc.end();
    });

    return {
      buffer,
      filename: `Project_Statement_${data.project.name.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`,
    };
  }
}

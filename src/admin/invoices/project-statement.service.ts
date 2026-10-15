import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { Prisma, ProjectStatus, UserRole } from '../../generated/prisma/client';
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
            unit: {
              select: {
                id: true,
                name: true,
                floor: { select: { name: true } },
              },
            },
            floor: { select: { name: true } },
            taskFloors: {
              include: { floor: { select: { name: true } } },
            },
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
            taskUnits: {
              include: {
                unit: {
                  select: {
                    id: true,
                    name: true,
                    floor: { select: { name: true } },
                  },
                },
              },
            },
            taskAssignees: {
              select: { user: { select: { fullName: true } } },
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
      totalSubTasksCount++;
      const price = task.price ?? 0;
      const isCompletedApproved =
        task.status === 'completed' && task.approvalDecision === 'approved';

      if (isCompletedApproved) {
        completedWorkValue += price;
        completedSubTasksCount++;
      } else {
        incompleteWorkValue += price;
      }

      const taskUnitLocations = task.taskUnits.map((taskUnit: any) => ({
        unitName: taskUnit.unit?.name ?? null,
        floorName: taskUnit.unit?.floor?.name ?? null,
      }));
      const fallbackLocations = [
        task.unit
          ? { unitName: task.unit.name, floorName: task.unit.floor?.name ?? task.floor?.name ?? null }
          : null,
        ...task.taskFloors.map((taskFloor: any) => ({
          unitName: null,
          floorName: taskFloor.floor?.name ?? null,
        })),
      ].filter(Boolean) as Array<{ unitName: string | null; floorName: string | null }>;
      const locations = taskUnitLocations.length ? taskUnitLocations : fallbackLocations;
      const firstLocation = locations[0];
      allSubTasks.push({
        id: task.id,
        taskId: task.id,
        taskTitle: task.title,
        title: task.title,
        status: task.status,
        approvalDecision: task.approvalDecision,
        price,
        unitName: locations.map((location) => location.unitName).filter(Boolean).join(', ') || null,
        floorName: locations.map((location) => location.floorName).filter(Boolean).filter((value, index, values) => values.indexOf(value) === index).join(', ') || firstLocation?.floorName || null,
        locationLabel: locations.map((location) => [location.floorName, location.unitName].filter(Boolean).join(' / ')).filter(Boolean).join(', ') || 'General',
        workerName: task.taskAssignees[0]?.user?.fullName ?? null,
        completedAt: task.completionReviewedAt,
        isInvoiced: false,
        invoices: [],
      });
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

    const progressPercent =
      totalSubTasksCount > 0
        ? Math.round((completedSubTasksCount / totalSubTasksCount) * 100)
        : 0;

    let derivedStatus = project.status;
    if (project.status === ProjectStatus.planning || project.status === ProjectStatus.active) {
      if (progressPercent >= 100 && totalSubTasksCount > 0) {
        derivedStatus = ProjectStatus.completed;
      } else if (progressPercent > 0 || completedSubTasksCount > 0) {
        derivedStatus = ProjectStatus.active;
      }
    }

    if (derivedStatus !== project.status) {
      await this.prisma.project.update({
        where: { id: project.id },
        data: { status: derivedStatus, progress: progressPercent },
      });
      project.status = derivedStatus;
    }

    return {
      project: {
        id: project.id,
        name: project.name,
        companyName: project.company.name,
        location: project.location,
        description: project.description,
        startDate: project.startDate,
        endDate: project.endDate,
        status: derivedStatus,
        financialStatus: project.financialStatus,
        progress: progressPercent,
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
        progressPercent,
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
    const doc = new PDFDocument({ size: 'A4', margin: 36, bufferPages: true });
    const chunks: Buffer[] = [];

    const formatMoney = (n: number | string | null | undefined) =>
      `$${Number(n || 0).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;

    const buffer = await new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (chunk) =>
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
      );
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Title & Subtitle
      doc
        .fontSize(20)
        .font('Helvetica-Bold')
        .fillColor('#1E293B')
        .text('PROJECT STATEMENT & FINANCIAL AUDIT', 46, 36);
      doc
        .fontSize(10)
        .font('Helvetica')
        .fillColor('#64748B')
        .text(
          `Generated on: ${new Date().toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
          })} | Confidential Official Document`,
          46,
          62,
        );

      // Project Info Header Box
      const boxY = 82;
      doc.rect(36, boxY, 523, 72).fillAndStroke('#F8FAFC', '#E2E8F0');
      doc
        .fillColor('#0F172A')
        .font('Helvetica-Bold')
        .fontSize(12)
        .text(`Project: ${data.project.name}`, 46, boxY + 10);
      doc.font('Helvetica').fontSize(9).fillColor('#475569');
      doc.text(`Company: ${data.project.companyName || 'N/A'}`, 46, boxY + 28);
      doc.text(`Location: ${data.project.location || 'N/A'}`, 46, boxY + 44);
      const statusLabel =
        data.project.status === ProjectStatus.active
          ? 'IN PROGRESS'
          : String(data.project.status).replace('_', ' ').toUpperCase();

      doc.text(
        `Work Status: ${statusLabel} (${data.summary.progressPercent}% Completed)`,
        300,
        boxY + 28,
      );
      doc.text(
        `Financial Status: ${String(data.summary.financialStatus).toUpperCase()}`,
        300,
        boxY + 44,
      );

      doc.y = boxY + 84;

      // Executive Financial Summary
      doc
        .fillColor('#0F172A')
        .font('Helvetica-Bold')
        .fontSize(13)
        .text('EXECUTIVE FINANCIAL SUMMARY', 46, doc.y);
      doc.moveDown(0.4);

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

      doc.moveDown(0.8);

      // Work Scope & Task Progress
      doc
        .fillColor('#0F172A')
        .font('Helvetica-Bold')
        .fontSize(12)
        .text('WORK SCOPE & TASK PROGRESS', 46, doc.y);
      doc.moveDown(0.3);

      const tableHeaderY = doc.y;
      doc.rect(36, tableHeaderY - 2, 523, 16).fill('#E2E8F0');
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#334155');
      doc.text('MAIN TASK', 46, tableHeaderY + 3);
      doc.text('LOCATION', 260, tableHeaderY + 3);
      doc.text('STATUS', 380, tableHeaderY + 3);
      doc.text('VALUE', 480, tableHeaderY + 3, { width: 70, align: 'right' });
      doc.y = tableHeaderY + 18;

      if (!data.subTasks || data.subTasks.length === 0) {
        doc
          .fillColor('#64748B')
          .font('Helvetica-Oblique')
          .fontSize(9)
          .text('No tasks or subtasks recorded yet for this project.', 46, doc.y + 4);
        doc.y += 18;
      } else {
        data.subTasks.slice(0, 30).forEach((item, index) => {
          let itemY = doc.y;
          const titleText = `${index + 1}. ${item.title}`;
          const unitText = item.unitName || 'General';
          doc.font('Helvetica').fontSize(8);
          const titleHeight = doc.heightOfString(titleText, { width: 198 });
          const unitHeight = doc.heightOfString(unitText, { width: 110 });
          const rowHeight = Math.max(16, titleHeight, unitHeight) + 4;
          if (itemY + rowHeight > 740) {
            doc.addPage();
            itemY = 46;
            // re-draw table header on new page
            doc.rect(36, itemY - 2, 523, 16).fill('#E2E8F0');
            doc.fontSize(8).font('Helvetica-Bold').fillColor('#334155');
            doc.text('MAIN TASK', 46, itemY + 3);
            doc.text('LOCATION', 260, itemY + 3);
            doc.text('STATUS', 380, itemY + 3);
            doc.text('VALUE', 480, itemY + 3, { width: 70, align: 'right' });
            itemY += 18;
          }
          const isDone = item.status === 'completed';

          if (index % 2 === 1) {
            doc.rect(36, itemY - 2, 523, rowHeight).fill('#F8FAFC');
          }

          doc
            .fillColor('#1E293B')
            .font('Helvetica')
            .fontSize(8)
            .text(titleText, 46, itemY + 2, { width: 198 });
          doc.fillColor('#64748B').text(unitText, 260, itemY + 2, { width: 110 });
          doc
            .fillColor(isDone ? '#16A34A' : '#D97706')
            .font('Helvetica-Bold')
            .text(isDone ? 'Completed' : 'Pending', 380, itemY + 2);
          doc
            .fillColor('#0F172A')
            .font('Helvetica')
            .text(formatMoney(item.price), 480, itemY + 2, {
              width: 70,
              align: 'right',
            });
          doc.y = itemY + rowHeight;
        });

        if (data.subTasks.length > 30) {
          doc
            .font('Helvetica-Oblique')
            .fontSize(8)
            .fillColor('#64748B')
            .text(
              `... and ${data.subTasks.length - 30} more subtasks not listed here (full breakdown visible in web dashboard).`,
              46,
              doc.y + 4,
            );
          doc.y += 16;
        }
      }

      // Payments section if available
      if (data.payments && data.payments.length > 0) {
        if (doc.y > 680) {
          doc.addPage();
        } else {
          doc.moveDown(0.6);
        }
        doc
          .fillColor('#0F172A')
          .font('Helvetica-Bold')
          .fontSize(12)
          .text('RECORDED PAYMENTS', 46, doc.y);
        doc.moveDown(0.3);

        const payHeaderY = doc.y;
        doc.rect(36, payHeaderY - 2, 523, 16).fill('#E2E8F0');
        doc.fontSize(8).font('Helvetica-Bold').fillColor('#334155');
        doc.text('PAYMENT # / METHOD', 46, payHeaderY + 3);
        doc.text('DATE', 260, payHeaderY + 3);
        doc.text('STATUS', 380, payHeaderY + 3);
        doc.text('AMOUNT', 480, payHeaderY + 3, { width: 70, align: 'right' });
        doc.y = payHeaderY + 18;

        data.payments.slice(0, 8).forEach((pay, idx) => {
          let payY = doc.y;
          if (payY > 740) {
            doc.addPage();
            payY = 46;
          }
          if (idx % 2 === 1) {
            doc.rect(36, payY - 2, 523, 15).fill('#F8FAFC');
          }
          const method = pay.method ? ` (${pay.method})` : '';
          doc
            .fillColor('#1E293B')
            .font('Helvetica')
            .fontSize(8)
            .text(`${pay.paymentNumber}${method}`, 46, payY + 2);
          doc
            .fillColor('#64748B')
            .font('Helvetica')
            .fontSize(8)
            .text(pay.paidAt ? new Date(pay.paidAt).toLocaleDateString() : 'N/A', 260, payY + 2);
          doc
            .fillColor('#16A34A')
            .font('Helvetica-Bold')
            .fontSize(8)
            .text('RECEIVED', 380, payY + 2);
          doc
            .fillColor('#0F172A')
            .font('Helvetica-Bold')
            .fontSize(8)
            .text(formatMoney(pay.amount), 480, payY + 2, { width: 70, align: 'right' });
          doc.y = payY + 16;
        });
      }

      // Add page numbering on all buffered pages
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        doc
          .fontSize(8)
          .font('Helvetica')
          .fillColor('#94A3B8')
          .text(
            `Page ${i + 1} of ${range.count} | FINIS Official Project Financial Statement`,
            36,
            800,
            { align: 'center', width: 523 },
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

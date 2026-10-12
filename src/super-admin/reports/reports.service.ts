import {
  Injectable,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UserRole } from '../../generated/prisma/client';
import PDFDocument from 'pdfkit';
import {
  GenerateReportDto,
  ExportReportDto,
  ReportType,
  PeriodFrequency,
} from './dto/reports.dto';

@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService) {}

  // ─── Date range helper ────────────────────────────────────────────────────
  private getDateRange(
    frequency: PeriodFrequency,
    startDate: string,
    endDate: string,
  ) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }

  private formatMoney(value: number | null | undefined) {
    return `$${(value ?? 0).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }

  private canSeeInternalBilling(userRole: string) {
    return userRole === UserRole.admin || userRole === UserRole.super_admin;
  }

  private toReportTitle(type: ReportType) {
    switch (type) {
      case ReportType.payroll:
        return 'Payroll Report';
      case ReportType.project_invoices:
        return 'Project Invoices Report';
      case ReportType.worker_performance:
        return 'Worker Performance Report';
      case ReportType.expense:
        return 'Expense Report';
      default:
        return 'Report';
    }
  }

  private async buildPdfBuffer(report: any) {
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
    const chunks: Buffer[] = [];

    const buffer = await new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      this.writeReportToPdf(doc, report);
      this.decoratePdfPages(doc);
      doc.end();
    });

    return buffer;
  }

  private decoratePdfPages(doc: any) {
    const range = doc.bufferedPageRange();

    for (let i = 0; i < range.count; i += 1) {
      doc.switchToPage(i);
      const { width, height, margins } = doc.page;
      const footerY = height - (margins.bottom ?? 40) + 10;

      doc.save();
      doc.x = margins.left;
      doc.y = margins.top ?? 40;
      doc.lineWidth(1);
      doc.strokeColor('#E5E7EB');
      doc.moveTo(margins.left, footerY - 14);
      doc.lineTo(width - (margins.right ?? 40), footerY - 14);
      doc.stroke();

      doc.fontSize(9).fillColor('#6B7280');
      doc.text('Finis Pro Reports', margins.left, footerY, {
        width: width - margins.left - (margins.right ?? 40),
        align: 'left',
        lineBreak: false,
        height: 12,
      });
      doc.text(`Page ${i + 1} of ${range.count}`, margins.left, footerY, {
        width: width - margins.left - (margins.right ?? 40),
        align: 'right',
        lineBreak: false,
        height: 12,
      });
      doc.restore();
    }
  }

  private drawHeader(doc: any, report: any) {
    const title = this.toReportTitle(report.type);
    const companyLabel =
      report.type === ReportType.project_invoices
        ? 'Company / Project Insights'
        : report.type === ReportType.payroll
          ? 'Payroll Overview'
          : report.type === ReportType.worker_performance
            ? 'Workforce Overview'
            : 'Expense Overview';

    doc.save();
    doc.roundedRect(40, 38, 515, 96, 18).fillAndStroke('#1D4F6D', '#1D4F6D');
    doc.fillColor('#FFFFFF');
    doc.fontSize(24).font('Helvetica-Bold').text('Finis Pro', 60, 54, {
      width: 360,
      align: 'left',
    });
    doc.fontSize(11).font('Helvetica').text(companyLabel, 60, 82, {
      width: 360,
      align: 'left',
    });
    doc.fontSize(18).font('Helvetica-Bold').text(title, 60, 106, {
      width: 360,
      align: 'left',
    });
    doc
      .fontSize(9)
      .font('Helvetica')
      .text(
        `Generated ${new Date(report.generatedAt ?? Date.now()).toLocaleString()}`,
        380,
        56,
        {
          width: 150,
          align: 'right',
        },
      );
    doc.restore();

    doc.y = 150;
  }

  private drawSectionTitle(doc: any, title: string, subtitle?: string) {
    doc.x = 40;
    doc.moveDown(0.15);
    doc
      .fontSize(16)
      .font('Helvetica-Bold')
      .fillColor('#111827')
      .text(title, 40, doc.y, {
        width: 515,
        align: 'left',
      });
    if (subtitle) {
      doc
        .fontSize(10)
        .font('Helvetica')
        .fillColor('#6B7280')
        .text(subtitle, 40, doc.y, {
          width: 515,
          align: 'left',
        });
    }
    doc.moveDown(0.2);
  }

  private drawMetricCard(
    doc: any,
    x: number,
    y: number,
    width: number,
    label: string,
    value: string,
    accent: string,
  ) {
    doc.save();
    doc.roundedRect(x, y, width, 58, 12).fillAndStroke('#F9FAFB', '#E5E7EB');
    doc
      .fontSize(8)
      .fillColor('#6B7280')
      .text(label.toUpperCase(), x + 12, y + 10, {
        width: width - 24,
        align: 'left',
      });
    doc
      .fontSize(15)
      .font('Helvetica-Bold')
      .fillColor(accent)
      .text(value, x + 12, y + 26, {
        width: width - 24,
        align: 'left',
      });
    doc.restore();
  }

  private ensureSpace(doc: any, heightNeeded: number) {
    const bottomLimit = doc.page.height - (doc.page.margins.bottom ?? 40) - 30;
    if (doc.y + heightNeeded > bottomLimit) {
      doc.addPage();
      doc.y = 40;
    }
  }

  private drawTable(
    doc: any,
    headers: string[],
    rows: string[][],
    widths: number[],
    options?: { rowHeight?: number },
  ) {
    const rowHeight = options?.rowHeight ?? 22;
    const startX = 40;
    const tableWidth = widths.reduce((sum, width) => sum + width, 0);

    this.ensureSpace(doc, rowHeight + 28);
    doc.x = startX;
    doc.y = Math.max(doc.y, 40);

    doc.save();
    doc.fillColor('#1D4F6D').font('Helvetica-Bold').fontSize(9);
    const headerY = doc.y;
    let x = startX;
    headers.forEach((header, index) => {
      doc.text(header.toUpperCase(), x + 6, headerY + 5, {
        width: widths[index] - 12,
        align: 'left',
        lineBreak: false,
        height: rowHeight - 8,
      });
      x += widths[index];
    });
    doc
      .moveTo(startX, headerY + rowHeight - 2)
      .lineTo(startX + tableWidth, headerY + rowHeight - 2)
      .strokeColor('#CBD5E1')
      .stroke();
    doc.restore();
    doc.y = headerY + rowHeight;

    rows.forEach((row, rowIndex) => {
      this.ensureSpace(doc, rowHeight + 6);
      const bg = rowIndex % 2 === 0 ? '#F9FAFB' : '#FFFFFF';
      const rowY = doc.y;
      doc.save();
      doc
        .rect(startX, rowY, tableWidth, rowHeight)
        .fillAndStroke(bg, '#E5E7EB');
      doc.fillColor('#111827').font('Helvetica').fontSize(9);
      let cellX = startX;
      row.forEach((cell, cellIndex) => {
        doc.text(cell, cellX + 6, rowY + 5, {
          width: widths[cellIndex] - 12,
          height: rowHeight - 8,
          ellipsis: true,
          lineBreak: false,
        });
        cellX += widths[cellIndex];
      });
      doc.restore();
      doc.y = rowY + rowHeight;
    });

    doc.y += 10;
  }

  private writeReportToPdf(doc: any, report: any) {
    this.drawHeader(doc, report);
    const periodStart = report.period?.start
      ? new Date(report.period.start).toLocaleDateString()
      : 'N/A';
    const periodEnd = report.period?.end
      ? new Date(report.period.end).toLocaleDateString()
      : 'N/A';

    doc
      .fontSize(11)
      .font('Helvetica-Bold')
      .fillColor('#6B7280')
      .text(`Period: ${periodStart} - ${periodEnd}`, 40, 164, {
        width: 515,
        align: 'left',
      });

    const summary = report.summary ?? {};
    doc.y = 194;
    this.drawSectionTitle(doc, 'Summary', 'Key metrics for the selected range');

    const summaryRows: string[][] = [];
    const summaryEntries = Object.entries(summary).filter(
      ([key]) => key !== 'byStatus' && key !== 'byCategory',
    );
    summaryEntries.slice(0, 6).forEach(([key, value]) => {
      const label = key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ');
      const displayValue =
        typeof value === 'number' ? this.formatMoney(value) : String(value);
      summaryRows.push([label, displayValue]);
    });
    if (summaryRows.length > 0) {
      this.drawTable(doc, ['Metric', 'Value'], summaryRows, [260, 255], {
        rowHeight: 24,
      });
    }

    const byStatus = summary.byStatus;
    if (
      byStatus &&
      typeof byStatus === 'object' &&
      Object.keys(byStatus).length > 0
    ) {
      this.drawSectionTitle(doc, 'Status Breakdown');
      const statusRows = Object.entries(byStatus).map(([key, value]) => [
        key,
        String(value),
      ]);
      this.drawTable(doc, ['Status', 'Count'], statusRows, [260, 255], {
        rowHeight: 22,
      });
    }

    const byCategory = summary.byCategory;
    if (
      byCategory &&
      typeof byCategory === 'object' &&
      Object.keys(byCategory).length > 0
    ) {
      this.drawSectionTitle(doc, 'Category Breakdown');
      const categoryRows = Object.entries(byCategory).map(([key, value]) => [
        key,
        this.formatMoney(Number(value)),
      ]);
      this.drawTable(doc, ['Category', 'Amount'], categoryRows, [260, 255], {
        rowHeight: 22,
      });
    }

    const payrollRows = report.type === 'payroll' ? (report.workers ?? []) : [];
    const projectRows =
      report.type === 'project_invoices' ? (report.projects ?? []) : [];
    const performanceRows =
      report.type === 'worker_performance' ? (report.workers ?? []) : [];
    const expenseRows =
      report.type === 'expense' ? (report.expenses ?? []) : [];
    const hasDetails =
      payrollRows.length > 0 ||
      projectRows.length > 0 ||
      performanceRows.length > 0 ||
      expenseRows.length > 0;

    if (hasDetails) {
      this.drawSectionTitle(
        doc,
        'Details',
        'Top items from the selected period',
      );
    }

    if (report.type === 'payroll') {
      const rows = payrollRows
        .slice(0, 12)
        .map((worker: any, index: number) => [
          `${index + 1}. ${worker.worker?.fullName ?? 'Worker'}`,
          worker.attendance?.attendanceRate ?? '0%',
          `${worker.tasks?.completed ?? 0}/${worker.tasks?.total ?? 0}`,
          worker.performanceScore ?? '0%',
          this.formatMoney(worker.totalGrossPay),
          this.formatMoney(worker.totalNetPay),
        ]);
      this.drawTable(
        doc,
        ['Worker', 'Attendance', 'Tasks', 'Score', 'Gross', 'Net'],
        rows,
        [150, 70, 75, 65, 80, 75],
        { rowHeight: 24 },
      );
    } else if (report.type === 'project_invoices') {
      const rows = projectRows
        .slice(0, 12)
        .map((project: any) => [
          project.name,
          project.company?.name ?? 'N/A',
          `${project.progress ?? 0}%`,
          String(project.billableSubTaskCount ?? 0),
          this.formatMoney(project.invoiceTotal),
          this.formatMoney(project.remaining),
        ]);
      this.drawTable(
        doc,
        ['Project', 'Company', 'Progress', 'Units', 'Invoice', 'Remaining'],
        rows,
        [140, 110, 60, 70, 70, 65],
        { rowHeight: 24 },
      );
    } else if (report.type === 'worker_performance') {
      const rows = performanceRows
        .slice(0, 12)
        .map((worker: any) => [
          worker.worker?.fullName ?? 'Worker',
          worker.attendance?.attendanceRate ?? '0%',
          `${worker.subTasks?.completed ?? 0}/${worker.subTasks?.total ?? 0}`,
          `${worker.reports?.approved ?? 0}/${worker.reports?.total ?? 0}`,
          worker.performanceScore ?? '0%',
        ]);
      this.drawTable(
        doc,
        ['Worker', 'Attendance', 'Sub-task', 'Reports', 'Score'],
        rows,
        [170, 75, 90, 90, 90],
        { rowHeight: 24 },
      );
    } else if (report.type === 'expense') {
      const rows = expenseRows
        .slice(0, 15)
        .map((expense: any) => [
          expense.description ?? 'N/A',
          expense.worker?.fullName ?? 'N/A',
          expense.project?.name ?? 'N/A',
          expense.category ?? 'N/A',
          this.formatMoney(expense.amount),
          expense.status ?? 'N/A',
        ]);
      this.drawTable(
        doc,
        ['Description', 'Worker', 'Project', 'Category', 'Amount', 'Status'],
        rows,
        [145, 100, 100, 60, 65, 45],
        { rowHeight: 24 },
      );
    }
  }

  // ─── Access filter ────────────────────────────────────────────────────────
  private async getCompanyIds(
    userId: string,
    userRole: string,
    companyId?: string,
  ) {
    // If a company is explicitly requested, verify that the caller is allowed to see it.
    if (companyId) {
      if (userRole === UserRole.super_admin) {
        return [companyId];
      }

      const company = await this.prisma.company.findFirst({
        where: {
          id: companyId,
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
        select: { id: true },
      });

      if (!company) {
        throw new ForbiddenException('You do not have access to this company');
      }

      return [company.id];
    }

    // Super admins can see every company when no company filter is supplied.
    if (userRole === UserRole.super_admin) {
      const companies = await this.prisma.company.findMany({
        select: { id: true },
      });
      return companies.map((c) => c.id);
    }

    const accessibleCompanies = await this.prisma.company.findMany({
      where: {
        OR: [
          { ownerId: userId },
          {
            members: {
              some: {
                userId,
                role: { in: ['admin', 'manager'] },
              },
            },
          },
        ],
      },
      select: { id: true },
    });

    return accessibleCompanies.map((c) => c.id);
  }

  // ─── MAIN: Generate Report ────────────────────────────────────────────────
  async generateReport(
    dto: GenerateReportDto,
    userId: string,
    userRole: string,
  ) {
    const { start, end } = this.getDateRange(
      dto.frequency,
      dto.startDate,
      dto.endDate,
    );
    // Resolve the accessible company scope first, then generate the selected report.
    const companyIds = await this.getCompanyIds(
      userId,
      userRole,
      dto.companyId,
    );

    switch (dto.type) {
      case ReportType.payroll:
        return this.generatePayrollReport(
          start,
          end,
          companyIds,
          dto,
          userId,
          userRole,
        );
      case ReportType.project_invoices:
        return this.generateProjectInvoicesReport(
          start,
          end,
          companyIds,
          dto,
          userId,
          userRole,
        );
      case ReportType.worker_performance:
        return this.generateWorkerPerformanceReport(
          start,
          end,
          companyIds,
          dto,
          userId,
          userRole,
        );
      case ReportType.expense:
        return this.generateExpenseReport(
          start,
          end,
          companyIds,
          dto,
          userId,
          userRole,
        );
      default:
        throw new BadRequestException('Invalid report type');
    }
  }

  // ─── 1. PAYROLL REPORT ────────────────────────────────────────────────────
  private async generatePayrollReport(
    start: Date,
    end: Date,
    companyIds: string[],
    dto: GenerateReportDto,
    userId: string,
    userRole: string,
  ) {
    const payrolls = await this.prisma.payroll.findMany({
      where: {
        companyId: { in: companyIds },
        payPeriodStart: { gte: start },
        payPeriodEnd: { lte: end },
      },
      include: {
        worker: {
          select: {
            id: true,
            fullName: true,
            avatarUrl: true,
            department: true,
            hourlyRate: true,
          },
        },
        company: {
          select: { id: true, name: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const paidPayrolls = payrolls.filter((p) => p.status === 'paid');
    const totalGrossPay = payrolls.reduce((s, p) => s + p.grossPay, 0);
    const totalNetPay = paidPayrolls.reduce((s, p) => s + p.grossPay, 0);
    const totalDeductions = 0;
    const totalEmployerCost = payrolls.reduce(
      (s, p) => s + (p.employerCost ?? 0),
      0,
    );
    const totalHours = payrolls.reduce(
      (s, p) => s + p.regularHours + p.overtimeHours,
      0,
    );

    const byStatus = {
      draft: payrolls.filter((p) => p.status === 'draft').length,
      approved: payrolls.filter((p) => p.status === 'approved').length,
      paid: payrolls.filter((p) => p.status === 'paid').length,
    };

    // Per worker breakdown
    const workerMap = new Map<string, any>();
    for (const p of payrolls) {
      const key = p.workerId;
      if (!workerMap.has(key)) {
        workerMap.set(key, {
          worker: p.worker,
          totalGrossPay: 0,
          totalNetPay: 0,
          totalDeductions: 0,
          totalHours: 0,
          payrolls: [],
        });
      }
      const entry = workerMap.get(key);
      entry.totalGrossPay += p.grossPay;
      entry.totalNetPay += p.status === 'paid' ? p.grossPay : 0;
      entry.totalDeductions += 0;
      entry.totalHours += p.regularHours + p.overtimeHours;
      entry.payrolls.push({
        payrollId: p.id,
        period: `${p.payPeriodStart.toLocaleDateString()} - ${p.payPeriodEnd.toLocaleDateString()}`,
        grossPay: p.grossPay,
        deductions: 0,
        netPay: p.status === 'paid' ? p.grossPay : 0,
        status: p.status,
      });
    }

    return {
      type: 'payroll',
      frequency: dto.frequency,
      period: { start, end },
      generatedAt: new Date(),
      summary: {
        totalWorkers: workerMap.size,
        totalHours: Math.round(totalHours * 100) / 100,
        totalGrossPay: Math.round(totalGrossPay * 100) / 100,
        totalDeductions: Math.round(totalDeductions * 100) / 100,
        totalNetPay: Math.round(totalNetPay * 100) / 100,
        totalEmployerCost: Math.round(totalEmployerCost * 100) / 100,
        byStatus,
      },
      workers: Array.from(workerMap.values()).map((w) => ({
        ...w,
        totalGrossPay: Math.round(w.totalGrossPay * 100) / 100,
        totalNetPay: Math.round(w.totalNetPay * 100) / 100,
        totalDeductions: Math.round(w.totalDeductions * 100) / 100,
      })),
    };
  }

  // ─── 2. PROJECT INVOICES REPORT ───────────────────────────────────────────
  private async generateProjectInvoicesReport(
    start: Date,
    end: Date,
    companyIds: string[],
    dto: GenerateReportDto,
    userId: string,
    userRole: string,
  ) {
    const projects = await this.prisma.project.findMany({
      where: {
        companyId: { in: companyIds },
        ...(dto.projectId && { id: dto.projectId }),
        ...(userRole === 'manager' && {
          teamMembers: {
            some: {
              userId,
              role: 'manager',
            },
          },
        }),
      },
      include: {
        company: { select: { id: true, name: true, logoUrl: true } },
        expenses: { select: { amount: true, status: true, category: true } },
        tasks: {
          select: {
            id: true,
            title: true,
            status: true,
            estimatedHours: true,
            actualHours: true,
            price: true,
            subTasks: {
              where: {
                status: 'completed',
                approvalDecision: 'approved',
                completedAt: { gte: start, lte: end },
              },
              select: {
                id: true,
                title: true,
                status: true,
                approvalDecision: true,
                completedAt: true,
                price: true,
                unit: {
                  select: {
                    id: true,
                    name: true,
                    floor: { select: { id: true, name: true } },
                  },
                },
                taskAssignee: {
                  select: {
                    user: {
                      select: { id: true, fullName: true },
                    },
                  },
                },
              },
            },
          },
        },
        _count: { select: { teamMembers: true, tasks: true, floors: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    const includeBilling = this.canSeeInternalBilling(userRole);

    const totalBudget = projects.reduce((s, p) => s + (p.budget ?? 0), 0);
    const totalSpent = projects.reduce((s, p) => s + (p.spent ?? 0), 0);
    const totalRemaining = projects.reduce((s, p) => s + (p.remaining ?? 0), 0);
    const totalBillableSubTasks = projects.reduce(
      (sum, project) =>
        sum +
        project.tasks.reduce(
          (taskSum, task) => taskSum + task.subTasks.length,
          0,
        ),
      0,
    );
    const totalInvoiceAmount = includeBilling
      ? projects.reduce(
          (sum, project) =>
            sum +
            project.tasks.reduce(
              (taskSum, task) =>
                taskSum +
                task.subTasks.reduce(
                  (subTaskSum, subTask) => subTaskSum + (subTask.price ?? 0),
                  0,
                ),
              0,
            ),
          0,
        )
      : 0;

    const byStatus = {
      planning: projects.filter((p) => p.status === 'planning').length,
      active: projects.filter((p) => p.status === 'active').length,
      on_hold: projects.filter((p) => p.status === 'on_hold').length,
      completed: projects.filter((p) => p.status === 'completed').length,
      cancelled: projects.filter((p) => p.status === 'cancelled').length,
    };

    return {
      type: 'project_invoices',
      frequency: dto.frequency,
      period: { start, end },
      generatedAt: new Date(),
      summary: {
        totalProjects: projects.length,
        totalBudget: Math.round(totalBudget * 100) / 100,
        totalSpent: Math.round(totalSpent * 100) / 100,
        totalRemaining: Math.round(totalRemaining * 100) / 100,
        totalBillableSubTasks,
        totalInvoiceAmount: Math.round(totalInvoiceAmount * 100) / 100,
        byStatus,
      },
      projects: projects.map((p) => {
        const approvedExpenses = p.expenses
          .filter((e) => e.status === 'approved')
          .reduce((s, e) => s + e.amount, 0);
        const completedTasks = p.tasks.filter(
          (t) => t.status === 'completed',
        ).length;
        const invoiceLines = p.tasks.flatMap((task) =>
          task.subTasks.map((subTask) => ({
            subTaskId: subTask.id,
            taskId: task.id,
            taskTitle: task.title,
            title: subTask.title,
            unit: subTask.unit
              ? {
                  id: subTask.unit.id,
                  name: subTask.unit.name,
                  floor: subTask.unit.floor,
                }
              : null,
            worker: subTask.taskAssignee?.user ?? null,
            completedAt: subTask.completedAt,
            quantity: 1,
            unitValue: includeBilling ? Math.round((subTask.price ?? 0) * 100) / 100 : 0,
            lineTotal: includeBilling ? Math.round((subTask.price ?? 0) * 100) / 100 : 0,
          })),
        );
        const invoiceTotal = includeBilling
          ? invoiceLines.reduce((sum, line) => sum + line.lineTotal, 0)
          : 0;

        return {
          id: p.id,
          name: p.name,
          company: p.company,
          status: p.status,
          progress: p.progress,
          startDate: p.startDate,
          endDate: p.endDate,
          budget: p.budget,
          spent: p.spent,
          remaining: p.remaining,
          approvedExpenses: Math.round(approvedExpenses * 100) / 100,
          billableSubTaskCount: invoiceLines.length,
          invoiceTotal: Math.round(invoiceTotal * 100) / 100,
          invoiceLines,
          taskCompletion:
            p.tasks.length > 0
              ? Math.round((completedTasks / p.tasks.length) * 100)
              : 0,
          counts: p._count,
        };
      }),
    };
  }

  // ─── 3. WORKER PERFORMANCE REPORT ────────────────────────────────────────
  private async generateWorkerPerformanceReport(
    start: Date,
    end: Date,
    companyIds: string[],
    dto: GenerateReportDto,
    userId: string,
    userRole: string,
  ) {
    if (companyIds.length === 0) {
      return {
        type: 'worker_performance',
        frequency: dto.frequency,
        period: { start, end },
        generatedAt: new Date(),
        summary: {
          totalWorkers: 0,
          avgAttendanceRate: '0%',
          avgTaskCompletion: '0%',
          topPerformer: null,
        },
        workers: [],
      };
    }

    // Company scoped worker ids from accepted invitations + active project work + payroll history
    const acceptedInvitations = await this.prisma.invitation.findMany({
      where: {
        role: 'worker',
        status: 'accepted',
        receiverId: { not: null },
      },
      select: { receiverId: true },
    });

    const workerIds = acceptedInvitations
      .map((i) => i.receiverId)
      .filter(Boolean);

    const workers = await this.prisma.user.findMany({
      where: {
        id: { in: workerIds },
        role: 'worker',
        OR: [
          {
            assignedTasks: {
              some: {
                project: {
                  companyId: { in: companyIds },
                },
              },
            },
          },
          {
            taskReports: {
              some: {
                task: {
                  project: {
                    companyId: { in: companyIds },
                  },
                },
              },
            },
          },
          {
            payrolls: {
              some: {
                companyId: { in: companyIds },
              },
            },
          },
        ],
      },
      select: {
        id: true,
        fullName: true,
        avatarUrl: true,
        department: true,
        attendances: {
          where: {
            date: { gte: start, lte: end },
          },
          select: {
            date: true,
            status: true,
            totalHours: true,
          },
        },
        assignedTasks: {
          where: {
            createdAt: { gte: start, lte: end },
            ...(userRole === 'manager' && {
              project: {
                teamMembers: {
                  some: { userId, role: 'manager' },
                },
              },
            }),
          },
          select: {
            id: true,
            status: true,
            priority: true,
            estimatedHours: true,
            actualHours: true,
            dueDate: true,
          },
        },
        taskAssignees: {
          where: {
            task: {
              project: {
                companyId: { in: companyIds },
                ...(userRole === 'manager' && {
                  teamMembers: {
                    some: { userId, role: 'manager' },
                  },
                }),
              },
            },
          },
          select: {
            subTasks: {
              where: {
                createdAt: { gte: start, lte: end },
              },
              select: {
                status: true,
              },
            },
          },
        },
        taskReports: {
          where: {
            submittedAt: { gte: start, lte: end },
          },
          select: {
            reviewDecision: true,
            submittedAt: true,
          },
        },
      },
    });

    const performanceData = workers.map((w) => {
      const totalDays = w.attendances.length;
      const presentDays = w.attendances.filter(
        (a) => a.status === 'present',
      ).length;
      const totalHours = w.attendances.reduce(
        (s, a) => s + (a.totalHours ?? 0),
        0,
      );
      const attendanceRate =
        totalDays > 0 ? Math.round((presentDays / totalDays) * 100) : 0;

      const totalTasks = w.assignedTasks.length;
      const completedTasks = w.assignedTasks.filter(
        (t) => t.status === 'completed',
      ).length;
      const inProgressTasks = w.assignedTasks.filter(
        (t) => t.status === 'in_progress',
      ).length;
      const taskCompletion =
        totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

      const allSubTasks = w.taskAssignees.flatMap(
        (assignee) => assignee.subTasks ?? [],
      );
      const totalSubTasks = allSubTasks.length;
      const completedSubTasks = allSubTasks.filter(
        (subTask) => subTask.status === 'completed',
      ).length;
      const inProgressSubTasks = allSubTasks.filter(
        (subTask) => subTask.status === 'in_progress',
      ).length;
      const subTaskCompletion =
        totalSubTasks > 0
          ? Math.round((completedSubTasks / totalSubTasks) * 100)
          : 0;

      const approvedReports = w.taskReports.filter(
        (r) => r.reviewDecision === 'approved',
      ).length;
      const reportApprovalRate =
        w.taskReports.length > 0
          ? Math.round((approvedReports / w.taskReports.length) * 100)
          : 0;

      // Overall performance score (weighted)
      const performanceScore = Math.round(
        attendanceRate * 0.4 + taskCompletion * 0.4 + reportApprovalRate * 0.2,
      );

      return {
        worker: {
          id: w.id,
          fullName: w.fullName,
          avatarUrl: w.avatarUrl,
          department: w.department,
        },
        attendance: {
          totalDays,
          presentDays,
          attendanceRate: `${attendanceRate}%`,
          totalHours: Math.round(totalHours * 100) / 100,
        },
        tasks: {
          total: totalTasks,
          completed: completedTasks,
          inProgress: inProgressTasks,
          completionRate: `${taskCompletion}%`,
        },
        subTasks: {
          total: totalSubTasks,
          completed: completedSubTasks,
          inProgress: inProgressSubTasks,
          completionRate: `${subTaskCompletion}%`,
        },
        reports: {
          total: w.taskReports.length,
          approved: approvedReports,
          approvalRate: `${reportApprovalRate}%`,
        },
        performanceScore: `${performanceScore}%`,
      };
    });

    // Sort by performance score desc
    performanceData.sort(
      (a, b) => parseInt(b.performanceScore) - parseInt(a.performanceScore),
    );

    const avgAttendance =
      performanceData.length > 0
        ? Math.round(
            performanceData.reduce(
              (s, w) => s + parseInt(w.attendance.attendanceRate),
              0,
            ) / performanceData.length,
          )
        : 0;

    const avgTaskCompletion =
      performanceData.length > 0
        ? Math.round(
            performanceData.reduce(
              (s, w) => s + parseInt(w.tasks.completionRate),
              0,
            ) / performanceData.length,
          )
        : 0;

    return {
      type: 'worker_performance',
      frequency: dto.frequency,
      period: { start, end },
      generatedAt: new Date(),
      summary: {
        totalWorkers: performanceData.length,
        avgAttendanceRate: `${avgAttendance}%`,
        avgTaskCompletion: `${avgTaskCompletion}%`,
        topPerformer: performanceData[0]?.worker ?? null,
      },
      workers: performanceData,
    };
  }

  // ─── 4. EXPENSE REPORT ────────────────────────────────────────────────────
  private async generateExpenseReport(
    start: Date,
    end: Date,
    companyIds: string[],
    dto: GenerateReportDto,
    userId: string,
    userRole: string,
  ) {
    const expenseAccessFilter =
      userRole === UserRole.super_admin
        ? {}
        : {
            OR: [
              {
                project: {
                  companyId: { in: companyIds },
                },
              },
              {
                createdBy: {
                  companyMembers: {
                    some: {
                      companyId: { in: companyIds },
                    },
                  },
                },
              },
              ...(userRole === UserRole.admin
                ? [
                    {
                      createdById: userId,
                    },
                  ]
                : []),
            ],
          };

    const expenses = await this.prisma.reimbursementExpense.findMany({
      where: {
        ...(dto.projectId && { projectId: dto.projectId }),
        ...expenseAccessFilter,
        expenseDate: { gte: start, lte: end },
      },
      include: {
        createdBy: {
          select: {
            id: true,
            fullName: true,
            avatarUrl: true,
            department: true,
          },
        },
        project: {
          select: { id: true, name: true },
        },
      },
      orderBy: { expenseDate: 'desc' },
    });

    const getExpenseTotal = (e: any) =>
      Number(e.totalAmount ?? Number(e.subtotal ?? 0) + Number(e.tax ?? 0));

    const totalAmount = expenses.reduce((s, e) => s + getExpenseTotal(e), 0);
    const approvedAmount = expenses
      .filter((e) => e.status === 'APPROVED' || e.status === 'PAID')
      .reduce((s, e) => s + getExpenseTotal(e), 0);
    const pendingAmount = expenses
      .filter((e) => e.status === 'DRAFT' || e.status === 'SUBMITTED')
      .reduce((s, e) => s + getExpenseTotal(e), 0);
    const rejectedAmount = expenses
      .filter((e) => e.status === 'REJECTED')
      .reduce((s, e) => s + getExpenseTotal(e), 0);

    // Category breakdown
    const categoryMap = new Map<string, number>();
    for (const e of expenses) {
      const cat = e.category;
      categoryMap.set(cat, (categoryMap.get(cat) ?? 0) + getExpenseTotal(e));
    }

    const byCategory = Object.fromEntries(
      Array.from(categoryMap.entries()).map(([k, v]) => [
        k,
        Math.round(v * 100) / 100,
      ]),
    );

    return {
      type: 'expense',
      frequency: dto.frequency,
      period: { start, end },
      generatedAt: new Date(),
      summary: {
        total: expenses.length,
        totalAmount: Math.round(totalAmount * 100) / 100,
        approvedAmount: Math.round(approvedAmount * 100) / 100,
        pendingAmount: Math.round(pendingAmount * 100) / 100,
        rejectedAmount: Math.round(rejectedAmount * 100) / 100,
        byCategory,
      },
      expenses: expenses.map((e) => ({
        id: e.id,
        worker: e.createdBy,
        description: e.title,
        category: e.category,
        subtotal: Number(e.subtotal ?? 0),
        tax: Number(e.tax ?? 0),
        totalAmount: getExpenseTotal(e),
        amount: getExpenseTotal(e),
        project: e.project,
        date: e.expenseDate,
        status: e.status,
        receiptUrl: e.receiptUrl,
      })),
    };
  }

  // ─── Export All Data ──────────────────────────────────────────────────────
  async exportAllData(dto: ExportReportDto, userId: string, userRole: string) {
    const start = dto.startDate
      ? new Date(dto.startDate)
      : new Date(new Date().getFullYear(), 0, 1);
    const end = dto.endDate ? new Date(dto.endDate) : new Date();

    // Reuse the normal report flow so export follows the same permissions and filters.
    const generateDto = {
      type: dto.type ?? ReportType.expense,
      frequency: 'monthly' as any,
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      companyId: dto.companyId,
      projectId: dto.projectId,
    };

    const report = await this.generateReport(generateDto, userId, userRole);

    return {
      exportedAt: new Date(),
      ...report,
    };
  }

  async exportReportPdf(
    dto: ExportReportDto,
    userId: string,
    userRole: string,
  ) {
    const report = await this.exportAllData(dto, userId, userRole);
    const buffer = await this.buildPdfBuffer(report);

    return {
      filename: `${report.type}-report-${new Date().toISOString().slice(0, 10)}.pdf`,
      buffer,
    };
  }
}

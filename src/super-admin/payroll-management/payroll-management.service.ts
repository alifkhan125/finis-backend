import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UserRole } from '../../generated/prisma/client';
import {
  UpdatePayrollConfigDto,
  PayrollManagementQueryDto,
  PayWorkerPayrollDto,
} from './dto/payroll-management.dto';

// ─── Default config values ────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  period: 'biweekly',
  cppEmployeeRate: 0.0595,
  eiEmployeeRate: 0.0166,
  federalTaxRate: 0.15,
  provincialTaxRate: 0.0505,
  cppEmployerRate: 0.0595,
  eiEmployerRate: 0.0232,
  wsibRate: 0.0142,
  vacationPayRate: 0.04,
};

@Injectable()
export class PayrollManagementService {
  constructor(private prisma: PrismaService) {}

  // ─── Config helper ────────────────────────────────────────────────────────
  private async getOrCreateConfig(companyId: string) {
    let config = await this.prisma.payrollConfig.findUnique({
      where: { companyId },
    });

    if (!config) {
      config = await this.prisma.payrollConfig.create({
        data: { companyId, ...DEFAULT_CONFIG } as any,
      });
    }

    return config;
  }

  // ─── Calculate deductions ─────────────────────────────────────────────────
  private calculateDeductions(grossPay: number, config: any) {
    const cppEmployee =
      Math.round(grossPay * (config.cppEmployeeRate ?? 0.0595) * 100) / 100;
    const eiEmployee =
      Math.round(grossPay * (config.eiEmployeeRate ?? 0.0163) * 100) / 100;
    const federalTax =
      Math.round(grossPay * (config.federalTaxRate ?? 0.15) * 100) / 100;
    const provincialTax =
      Math.round(grossPay * (config.provincialTaxRate ?? 0.0505) * 100) / 100;
    const totalDeductions =
      Math.round(
        (cppEmployee + eiEmployee + federalTax + provincialTax) * 100,
      ) / 100;
    const netPay = Math.round((grossPay - totalDeductions) * 100) / 100;

    return {
      cppEmployee,
      eiEmployee,
      federalTax,
      provincialTax,
      totalDeductions,
      netPay,
    };
  }

  // ─── Calculate employer cost ──────────────────────────────────────────────
  private calculateEmployerCost(grossPay: number, config: any) {
    const cppEmployer =
      Math.round(grossPay * config.cppEmployerRate * 100) / 100;
    const eiEmployer = Math.round(grossPay * config.eiEmployerRate * 100) / 100;
    const wsib = Math.round(grossPay * config.wsibRate * 100) / 100;
    const vacationPay =
      Math.round(grossPay * config.vacationPayRate * 100) / 100;
    const totalEmployerCost =
      grossPay + cppEmployer + eiEmployer + wsib + vacationPay;

    return { cppEmployer, eiEmployer, wsib, vacationPay, totalEmployerCost };
  }

  // ─── Get current period dates ─────────────────────────────────────────────
  private getPeriodDates(period: string, month?: string, year?: string) {
    const now = new Date();
    const m = month ? parseInt(month) - 1 : now.getMonth();
    const y = year ? parseInt(year) : now.getFullYear();

    if (period === 'weekly') {
      const startDate = new Date(y, m, now.getDate() - now.getDay());
      const endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + 6);
      return { startDate, endDate };
    }

    if (period === 'biweekly') {
      const startDate = new Date(y, m, 1);
      const endDate = new Date(y, m, 15);
      return { startDate, endDate };
    }

    // monthly
    const startDate = new Date(y, m, 1);
    const endDate = new Date(y, m + 1, 0);
    return { startDate, endDate };
  }

  // ─── IMAGE 1: Dashboard ───────────────────────────────────────────────────
  async getDashboard(
    userId: string,
    userRole: string,
    query: PayrollManagementQueryDto,
  ) {
    const { month, year } = query;

    const now = new Date();
    const m = month ? parseInt(month) - 1 : now.getMonth();
    const y = year ? parseInt(year) : now.getFullYear();

    const startDate = new Date(y, m, 1);
    const endDate = new Date(y, m + 1, 0);

    // super_admin সব company দেখবে, admin শুধু নিজের
    const companies = await this.prisma.company.findMany({
      where: userRole === UserRole.super_admin ? {} : { ownerId: userId },
      select: { id: true, name: true },
    });

    const companyIds = companies.map((c) => c.id);

    // Fetch payrolls
    const whereClause: any = {};

    if (userRole === UserRole.super_admin) {
      // super_admin sees all
    } else {
      // admin sees payrolls of their companies OR payrolls they processed
      whereClause.OR = [
        ...(companyIds.length > 0 ? [{ companyId: { in: companyIds } }] : []),
        { processedBy: userId },
      ];
    }

    if (query.month || query.year) {
      whereClause.payPeriodStart = { gte: startDate };
      whereClause.payPeriodEnd = { lte: endDate };
    }

    const payrolls = await this.prisma.payroll.findMany({
      where: whereClause,
      include: {
        worker: {
          select: {
            id: true,
            fullName: true,
            avatarUrl: true,
            department: true,
          },
        },
        company: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Config — first company এর config থেকে rates দেখাবো, or from a fetched payroll
    const targetCompanyId = companyIds[0] || payrolls[0]?.companyId;
    const config = targetCompanyId
      ? await this.getOrCreateConfig(targetCompanyId)
      : {
          period: 'biweekly',
          cppEmployeeRate: 0.0595,
          eiEmployeeRate: 0.0163,
          federalTaxRate: 0.15,
          provincialTaxRate: 0.0505,
          cppEmployerRate: 0.0595,
          eiEmployerRate: 0.0228,
          wsibRate: 0.01,
          vacationPayRate: 0.04,
        };

    const totalGrossPay = payrolls.reduce((s, p) => s + p.grossPay, 0);
    const totalDeductions = payrolls.reduce((s, p) => s + p.deductions, 0);
    const totalNetPay = payrolls.reduce((s, p) => s + p.netPay, 0);
    const totalEmployerCost = payrolls.reduce(
      (s, p) => s + (p.employerCost ?? p.grossPay * 0.13),
      0,
    );
    const pendingCount = payrolls.filter((p) => p.status === 'draft').length;
    const workersCount = new Set(payrolls.map((p) => p.workerId)).size;

    // Compute 6-month monthly trends
    const sixMonthsAgo = new Date(y, m - 5, 1);
    const trendsWhereClause: any = {
      payPeriodStart: { gte: sixMonthsAgo },
    };

    if (userRole !== UserRole.super_admin) {
      trendsWhereClause.OR = [
        ...(companyIds.length > 0 ? [{ companyId: { in: companyIds } }] : []),
        { processedBy: userId },
      ];
    }

    const trendsPayrolls = await this.prisma.payroll.findMany({
      where: trendsWhereClause,
    });

    const monthNames = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    const monthlyTrends: Array<{
      month: string;
      grossPay: number;
      deductions: number;
      netPay: number;
    }> = [];

    for (let i = 5; i >= 0; i--) {
      const targetDate = new Date(y, m - i, 1);
      const tMonth = targetDate.getMonth();
      const tYear = targetDate.getFullYear();
      const label = `${monthNames[tMonth]} '${tYear.toString().slice(-2)}`;

      const mPayrolls = trendsPayrolls.filter((p) => {
        const d = new Date(p.payPeriodStart);
        return d.getMonth() === tMonth && d.getFullYear() === tYear;
      });

      const mGross = mPayrolls.reduce((s, p) => s + p.grossPay, 0);
      const mDeductions = mPayrolls.reduce((s, p) => s + p.deductions, 0);
      const mNet = mPayrolls.reduce((s, p) => s + p.netPay, 0);

      monthlyTrends.push({
        month: label,
        grossPay: Math.round(mGross * 100) / 100,
        deductions: Math.round(mDeductions * 100) / 100,
        netPay: Math.round(mNet * 100) / 100,
      });
    }

    return {
      summary: {
        totalGrossPay: Math.round(totalGrossPay * 100) / 100,
        totalDeductions: Math.round(totalDeductions * 100) / 100,
        totalNetPay: Math.round(totalNetPay * 100) / 100,
        totalEmployerCost: Math.round(totalEmployerCost * 100) / 100,
        payrollPeriod: config.period,
      },
      monthlyTrends,
      currentPeriod: {
        period: `${startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} - ${endDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
        workers: workersCount,
        pending: pendingCount,
        status: pendingCount > 0 ? 'In Progress' : 'Completed',
      },
      deductionRates: {
        cppEmployee: `${(config.cppEmployeeRate * 100).toFixed(2)}%`,
        eiEmployee: `${(config.eiEmployeeRate * 100).toFixed(2)}%`,
        federalTax: `${(config.federalTaxRate * 100).toFixed(0)}%`,
        provincialTax: `${(config.provincialTaxRate * 100).toFixed(2)}%`,
      },
      employerRates: {
        cppEmployer: `${(config.cppEmployerRate * 100).toFixed(2)}%`,
        eiEmployer: `${(config.eiEmployerRate * 100).toFixed(2)}%`,
        wsib: `${(config.wsibRate * 100).toFixed(2)}%`,
        vacationPay: `${(config.vacationPayRate * 100).toFixed(0)}%`,
      },
      recentRecords: payrolls.slice(0, 10).map((p) => ({
        payrollId: p.id,
        company: p.company,
        worker: p.worker,
        period: `${p.payPeriodStart.toLocaleDateString()} - ${p.payPeriodEnd.toLocaleDateString()}`,
        hours: p.regularHours + p.overtimeHours,
        grossPay: p.grossPay,
        deductions: p.deductions,
        netPay: p.netPay,
        status: p.status,
      })),
    };
  }
  // ─── Get All Payroll Records ──────────────────────────────────────────────
  async getPayrollRecords(
    userId: string,
    userRole: string,
    query: PayrollManagementQueryDto,
  ) {
    const { companyId, month, year } = query;

    const now = new Date();
    const m = month ? parseInt(month) - 1 : now.getMonth();
    const y = year ? parseInt(year) : now.getFullYear();

    const startDate = new Date(y, m, 1);
    const endDate = new Date(y, m + 1, 0);

    const companies = await this.prisma.company.findMany({
      where: userRole === UserRole.super_admin ? {} : { ownerId: userId },
      select: { id: true },
    });
    const companyIds = companies.map((c) => c.id);

    const whereClause: any = {};

    if (userRole !== UserRole.super_admin) {
      whereClause.OR = [
        ...(companyIds.length > 0 ? [{ companyId: { in: companyIds } }] : []),
        { processedBy: userId },
      ];
    }

    if (companyId) {
      whereClause.companyId = companyId;
    }

    if (query.month || query.year) {
      whereClause.payPeriodStart = { gte: startDate };
      whereClause.payPeriodEnd = { lte: endDate };
    }

    const payrolls = await this.prisma.payroll.findMany({
      where: whereClause,
      include: {
        worker: {
          select: {
            id: true,
            fullName: true,
            avatarUrl: true,
            department: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      total: payrolls.length,
      records: payrolls.map((p) => ({
        payrollId: p.id,
        worker: p.worker,
        period: `${p.payPeriodStart.toLocaleDateString()} - ${p.payPeriodEnd.toLocaleDateString()}`,
        hours: p.regularHours + p.overtimeHours,
        grossPay: p.grossPay,
        deductions: p.deductions,
        netPay: p.netPay,
        status: p.status,
      })),
    };
  }

  // ─── Process Current Period ───────────────────────────────────────────────
  async processCurrentPeriod(
    userId: string,
    userRole: string,
    query: PayrollManagementQueryDto,
  ) {
    const companyId = query.companyId;
    if (!companyId) throw new NotFoundException('companyId is required');

    const config = await this.getOrCreateConfig(companyId);
    const { startDate, endDate } = this.getPeriodDates(
      config.period,
      query.month,
      query.year,
    );

    const payrolls = await this.prisma.payroll.findMany({
      where: {
        companyId,
        status: 'approved',
        payPeriodStart: { gte: startDate },
        payPeriodEnd: { lte: endDate },
      },
      include: {
        worker: {
          select: {
            id: true,
            fullName: true,
          },
        },
      },
    });

    if (payrolls.length === 0) {
      return {
        message: 'No approved payrolls found for current period',
        results: [],
      };
    }

    const results: Array<{
      payrollId: string;
      workerName: string;
      grossPay: number;
      deductions: number;
      netPay: number;
      status: 'calculated';
    }> = [];

    for (const payroll of payrolls) {
      results.push({
        payrollId: payroll.id,
        workerName: payroll.worker.fullName,
        grossPay: payroll.grossPay,
        deductions: payroll.deductions,
        netPay: payroll.netPay,
        status: 'calculated',
      });
    }

    const totalGrossPay = results.reduce((sum, item) => sum + item.grossPay, 0);
    const totalDeductions = results.reduce(
      (sum, item) => sum + item.deductions,
      0,
    );
    const totalNetPay = results.reduce((sum, item) => sum + item.netPay, 0);

    return {
      message: `Calculated: ${results.length} payroll record(s)`,
      summary: {
        totalPayrolls: results.length,
        totalGrossPay: Math.round(totalGrossPay * 100) / 100,
        totalDeductions: Math.round(totalDeductions * 100) / 100,
        totalNetPay: Math.round(totalNetPay * 100) / 100,
      },
      results,
    };
  }

  // ─── Generate Report ──────────────────────────────────────────────────────
  async generateReport(
    userId: string,
    userRole: string,
    query: PayrollManagementQueryDto,
  ) {
    let companyId = query.companyId;
    let companyName = 'Company';
    if (!companyId) {
      const firstCompany = await this.prisma.company.findFirst({
        where: userRole === UserRole.super_admin ? {} : { ownerId: userId },
        select: { id: true, name: true },
      });
      companyId = firstCompany?.id;
      if (firstCompany?.name) companyName = firstCompany.name;
    }

    if (!companyId)
      throw new NotFoundException('No company found to generate report');

    const config = await this.getOrCreateConfig(companyId);

    let filterStart: Date;
    let filterEnd: Date;

    if (query.startDate && query.endDate) {
      filterStart = new Date(query.startDate);
      filterStart.setHours(0, 0, 0, 0);

      filterEnd = new Date(query.endDate);
      filterEnd.setHours(23, 59, 59, 999);
    } else {
      const periodDates = this.getPeriodDates(
        config.period,
        query.month,
        query.year,
      );
      filterStart = periodDates.startDate;
      filterStart.setHours(0, 0, 0, 0);
      filterEnd = periodDates.endDate;
      filterEnd.setHours(23, 59, 59, 999);
    }

    const payrolls = await this.prisma.payroll.findMany({
      where: {
        companyId,
        OR: [
          {
            payPeriodStart: { lte: filterEnd },
            payPeriodEnd: { gte: filterStart },
          },
          {
            createdAt: { gte: filterStart, lte: filterEnd },
          },
        ],
      },
      include: {
        worker: {
          select: {
            id: true,
            fullName: true,
            department: true,
            hourlyRate: true,
            avatarUrl: true,
          },
        },
        company: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const totalGrossPay = payrolls.reduce((s, p) => s + p.grossPay, 0);
    const totalDeductions = payrolls.reduce((s, p) => s + p.deductions, 0);
    const totalNetPay = payrolls.reduce((s, p) => s + p.netPay, 0);
    const totalEmployerCost = payrolls.reduce(
      (s, p) => s + (p.employerCost ?? 0),
      0,
    );

    const workersList = payrolls.map((p) => {
      const cppEmp = p.grossPay * (config.cppEmployeeRate || 0.0595);
      const eiEmp = p.grossPay * (config.eiEmployeeRate || 0.0163);
      const fedTax = p.grossPay * (config.federalTaxRate || 0.15);
      const provTax = p.grossPay * (config.provincialTaxRate || 0.0505);
      const cppEmployer = p.grossPay * (config.cppEmployerRate || 0.0595);
      const eiEmployer = p.grossPay * (config.eiEmployerRate || 0.0228);
      const wsib = p.grossPay * (config.wsibRate || 0.02);
      const vacationPay = p.grossPay * (config.vacationPayRate || 0.04);

      const totalHours = (p.regularHours || 0) + (p.overtimeHours || 0);

      return {
        payrollId: p.id,
        workerId: p.workerId,
        workerName: p.worker?.fullName || 'Worker',
        worker: p.worker,
        role: p.worker?.department || 'Staff',
        companies: [p.company?.name || companyName],
        totalHours: Math.round(totalHours * 100) / 100,
        grossPay: p.grossPay,
        netPay: p.netPay,
        status: p.status,
        deductions: {
          cppEmployee: `$${cppEmp.toFixed(2)}`,
          eiEmployee: `$${eiEmp.toFixed(2)}`,
          federalTax: `$${fedTax.toFixed(2)}`,
          provincialTax: `$${provTax.toFixed(2)}`,
          total: p.deductions,
        },
        employerCosts: {
          cppEmployer: `$${cppEmployer.toFixed(2)}`,
          eiEmployer: `$${eiEmployer.toFixed(2)}`,
          wsib: `$${wsib.toFixed(2)}`,
          vacationPay: `$${vacationPay.toFixed(2)}`,
          total: p.employerCost ?? 0,
        },
        totalEmployerCost: p.employerCost ?? 0,
        employerCost: p.employerCost ?? 0,
        payPeriodStart: p.payPeriodStart,
        payPeriodEnd: p.payPeriodEnd,
        createdAt: p.createdAt,
      };
    });

    return {
      reportGeneratedAt: new Date().toISOString(),
      startDate: filterStart.toISOString(),
      endDate: filterEnd.toISOString(),
      period: {
        start: filterStart,
        end: filterEnd,
        type: config.period,
      },
      totalGrossPay: Math.round(totalGrossPay * 100) / 100,
      totalDeductions: Math.round(totalDeductions * 100) / 100,
      totalNetPay: Math.round(totalNetPay * 100) / 100,
      totalEmployerCost: Math.round(totalEmployerCost * 100) / 100,
      summary: {
        totalWorkers: payrolls.length,
        totalGrossPay: Math.round(totalGrossPay * 100) / 100,
        totalDeductions: Math.round(totalDeductions * 100) / 100,
        totalNetPay: Math.round(totalNetPay * 100) / 100,
        totalEmployerCost: Math.round(totalEmployerCost * 100) / 100,
      },
      deductionRates: {
        cppEmployee: `${(config.cppEmployeeRate * 100).toFixed(2)}%`,
        eiEmployee: `${(config.eiEmployeeRate * 100).toFixed(2)}%`,
        federalTax: `${(config.federalTaxRate * 100).toFixed(0)}%`,
        provincialTax: `${(config.provincialTaxRate * 100).toFixed(2)}%`,
      },
      employerRates: {
        cppEmployer: `${(config.cppEmployerRate * 100).toFixed(2)}%`,
        eiEmployer: `${(config.eiEmployerRate * 100).toFixed(2)}%`,
        wsib: `${(config.wsibRate * 100).toFixed(2)}%`,
        vacationPay: `${(config.vacationPayRate * 100).toFixed(0)}%`,
      },
      workers: workersList,
      records: workersList,
    };
  }

  // ─── Get Config ───────────────────────────────────────────────────────────
  async getConfig(userId: string, userRole: string) {
    const companies = await this.prisma.company.findMany({
      where: userRole === UserRole.super_admin ? {} : { ownerId: userId },
      select: { id: true, name: true },
      take: 1,
    });

    if (!companies.length) throw new NotFoundException('No company found');

    const config = await this.getOrCreateConfig(companies[0].id);

    return {
      companyId: companies[0].id,
      companyName: companies[0].name,
      period: config.period,
      employeeDeductions: {
        cppEmployeeRate: Math.round(config.cppEmployeeRate * 10000) / 100,
        eiEmployeeRate: Math.round(config.eiEmployeeRate * 10000) / 100,
        federalTaxRate: Math.round(config.federalTaxRate * 10000) / 100,
        provincialTaxRate: Math.round(config.provincialTaxRate * 10000) / 100,
      },
      employerContributions: {
        cppEmployerRate: Math.round(config.cppEmployerRate * 10000) / 100,
        eiEmployerRate: Math.round(config.eiEmployerRate * 10000) / 100,
        wsibRate: Math.round(config.wsibRate * 10000) / 100,
        vacationPayRate: Math.round(config.vacationPayRate * 10000) / 100,
      },
    };
  }

  // ─── Update Config ────────────────────────────────────────────────────────
  async updateConfig(
    dto: UpdatePayrollConfigDto,
    userId: string,
    userRole: string,
  ) {
    const companies = await this.prisma.company.findMany({
      where: userRole === UserRole.super_admin ? {} : { ownerId: userId },
      select: { id: true },
      take: 1,
    });

    if (!companies.length) throw new NotFoundException('No company found');

    const companyId = companies[0].id;

    const updated = await this.prisma.payrollConfig.upsert({
      where: { companyId },
      create: {
        companyId,
        ...DEFAULT_CONFIG,
        ...(dto.period && { period: dto.period }),
        ...(dto.cppEmployeeRate && {
          cppEmployeeRate: dto.cppEmployeeRate / 100,
        }),
        ...(dto.eiEmployeeRate && { eiEmployeeRate: dto.eiEmployeeRate / 100 }),
        ...(dto.federalTaxRate && { federalTaxRate: dto.federalTaxRate / 100 }),
        ...(dto.provincialTaxRate && {
          provincialTaxRate: dto.provincialTaxRate / 100,
        }),
        ...(dto.cppEmployerRate && {
          cppEmployerRate: dto.cppEmployerRate / 100,
        }),
        ...(dto.eiEmployerRate && { eiEmployerRate: dto.eiEmployerRate / 100 }),
        ...(dto.wsibRate && { wsibRate: dto.wsibRate / 100 }),
        ...(dto.vacationPayRate && {
          vacationPayRate: dto.vacationPayRate / 100,
        }),
      } as any,
      update: {
        ...(dto.period && { period: dto.period }),
        ...(dto.cppEmployeeRate !== undefined && {
          cppEmployeeRate: dto.cppEmployeeRate / 100,
        }),
        ...(dto.eiEmployeeRate !== undefined && {
          eiEmployeeRate: dto.eiEmployeeRate / 100,
        }),
        ...(dto.federalTaxRate !== undefined && {
          federalTaxRate: dto.federalTaxRate / 100,
        }),
        ...(dto.provincialTaxRate !== undefined && {
          provincialTaxRate: dto.provincialTaxRate / 100,
        }),
        ...(dto.cppEmployerRate !== undefined && {
          cppEmployerRate: dto.cppEmployerRate / 100,
        }),
        ...(dto.eiEmployerRate !== undefined && {
          eiEmployerRate: dto.eiEmployerRate / 100,
        }),
        ...(dto.wsibRate !== undefined && { wsibRate: dto.wsibRate / 100 }),
        ...(dto.vacationPayRate !== undefined && {
          vacationPayRate: dto.vacationPayRate / 100,
        }),
      },
    });

    return { message: 'Config updated successfully', config: updated };
  }

  // ─── Reset Config ─────────────────────────────────────────────────────────
  async resetConfig(userId: string, userRole: string) {
    const companies = await this.prisma.company.findMany({
      where: userRole === UserRole.super_admin ? {} : { ownerId: userId },
      select: { id: true },
      take: 1,
    });

    if (!companies.length) throw new NotFoundException('No company found');

    const companyId = companies[0].id;

    const reset = await this.prisma.payrollConfig.upsert({
      where: { companyId },
      create: { companyId, ...DEFAULT_CONFIG } as any,
      update: { ...DEFAULT_CONFIG } as any,
    });

    return { message: 'Config reset to defaults', config: reset };
  }

  // ─── IMAGE 3: Sample Calculation ─────────────────────────────────────────
  async calculateSample(
    hours: number,
    ratePerHour: number,
    userId: string,
    userRole: string,
  ) {
    const companies = await this.prisma.company.findMany({
      where: userRole === UserRole.super_admin ? {} : { ownerId: userId },
      select: { id: true },
      take: 1,
    });

    if (!companies.length) throw new NotFoundException('No company found');

    const config = await this.getOrCreateConfig(companies[0].id);
    const grossPay = Math.round(hours * ratePerHour * 100) / 100;

    const deductions = this.calculateDeductions(grossPay, config);
    const employerCosts = this.calculateEmployerCost(grossPay, config);

    return {
      input: { hours, ratePerHour },
      grossPay,
      employeeDeductions: {
        cppEmployee: {
          rate: `${(config.cppEmployeeRate * 100).toFixed(2)}%`,
          amount: -deductions.cppEmployee,
        },
        eiEmployee: {
          rate: `${(config.eiEmployeeRate * 100).toFixed(2)}%`,
          amount: -deductions.eiEmployee,
        },
        federalTax: {
          rate: `${(config.federalTaxRate * 100).toFixed(0)}%`,
          amount: -deductions.federalTax,
        },
        provincialTax: {
          rate: `${(config.provincialTaxRate * 100).toFixed(2)}%`,
          amount: -deductions.provincialTax,
        },
        total: -deductions.totalDeductions,
      },
      netPay: deductions.netPay,
      employerCosts: {
        cppEmployer: {
          rate: `${(config.cppEmployerRate * 100).toFixed(2)}%`,
          amount: employerCosts.cppEmployer,
        },
        eiEmployer: {
          rate: `${(config.eiEmployerRate * 100).toFixed(2)}%`,
          amount: employerCosts.eiEmployer,
        },
        wsib: {
          rate: `${(config.wsibRate * 100).toFixed(2)}%`,
          amount: employerCosts.wsib,
        },
        totalEmployerCost: employerCosts.totalEmployerCost,
      },
    };
  }

  // ─── Pay Worker Payroll ───────────────────────────────────────────────────
  async payWorkerPayroll(
    userId: string,
    userRole: string,
    dto: PayWorkerPayrollDto,
  ) {
    const worker = await this.prisma.user.findUnique({
      where: { id: dto.workerId },
      include: {
        companyMembers: { take: 1 },
      },
    });

    if (!worker) {
      throw new NotFoundException('Worker not found');
    }

    let companyId = worker.companyMembers?.[0]?.companyId;
    if (!companyId) {
      const anyCompany = await this.prisma.company.findFirst();
      companyId = anyCompany?.id;
    }

    if (!companyId) {
      throw new NotFoundException('No company found to assign payroll');
    }

    const payPeriodStart = new Date(dto.payPeriodStart);
    const payPeriodEnd = new Date(dto.payPeriodEnd);
    const rate = dto.ratePerHour ?? worker.hourlyRate ?? 35;
    const hours = dto.hours ?? 0;
    const grossPay = dto.grossPay ?? Math.round(hours * rate * 100) / 100;

    const config = await this.getOrCreateConfig(companyId);
    const calculatedDeductions = this.calculateDeductions(grossPay, config);
    const calculatedEmployer = this.calculateEmployerCost(grossPay, config);

    const deductions = dto.deductions ?? calculatedDeductions.totalDeductions;
    const netPay =
      dto.netPay ?? Math.round((grossPay - deductions) * 100) / 100;
    const employerCost = calculatedEmployer.totalEmployerCost;

    let payrollRecord;

    if (dto.payrollId) {
      payrollRecord = await this.prisma.payroll.update({
        where: { id: dto.payrollId },
        data: {
          status: 'paid',
          processedAt: new Date(),
          processedBy: userId,
          regularHours: hours,
          ratePerHour: rate,
          grossPay,
          deductions,
          netPay,
          employerCost,
        },
      });
    } else {
      // Find existing for this period or create
      const existing = await this.prisma.payroll.findFirst({
        where: {
          workerId: dto.workerId,
          payPeriodStart: {
            gte: new Date(payPeriodStart.getTime() - 24 * 3600 * 1000),
          },
          payPeriodEnd: {
            lte: new Date(payPeriodEnd.getTime() + 24 * 3600 * 1000),
          },
        },
      });

      if (existing) {
        payrollRecord = await this.prisma.payroll.update({
          where: { id: existing.id },
          data: {
            status: 'paid',
            processedAt: new Date(),
            processedBy: userId,
            regularHours: hours,
            ratePerHour: rate,
            grossPay,
            deductions,
            netPay,
            employerCost,
          },
        });
      } else {
        payrollRecord = await this.prisma.payroll.create({
          data: {
            companyId,
            workerId: dto.workerId,
            payPeriodStart,
            payPeriodEnd,
            regularHours: hours,
            ratePerHour: rate,
            grossPay,
            deductions,
            netPay,
            employerCost,
            status: 'paid',
            processedAt: new Date(),
            processedBy: userId,
          },
        });
      }
    }

    return {
      success: true,
      message: 'Payroll successfully processed and marked as paid',
      payroll: payrollRecord,
    };
  }

  // ─── Mark Payroll as Paid ─────────────────────────────────────────────────
  async markPayrollPaid(userId: string, userRole: string, payrollId: string) {
    const existing = await this.prisma.payroll.findUnique({
      where: { id: payrollId },
    });
    if (!existing) {
      throw new NotFoundException('Payroll record not found');
    }

    const updated = await this.prisma.payroll.update({
      where: { id: payrollId },
      data: {
        status: 'paid',
        processedAt: new Date(),
        processedBy: userId,
      },
    });

    return {
      success: true,
      message: 'Payroll marked as paid',
      payroll: updated,
    };
  }

  // ─── Get Worker Payrolls ──────────────────────────────────────────────────
  async getWorkerPayrolls(workerId: string) {
    const payrolls = await this.prisma.payroll.findMany({
      where: { workerId },
      orderBy: { payPeriodEnd: 'desc' },
      include: {
        company: { select: { id: true, name: true } },
      },
    });

    return payrolls;
  }
}

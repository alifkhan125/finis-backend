import { buildQuotationV2Pdf } from './quotation-v2-document';
import { EmailQuotationV2Dto, QuotationV2Dto } from './dto/quotation-v2.dto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import PDFDocument from 'pdfkit';
import {
  Prisma,
  ProjectType,
  QuoteEstimateStatus,
  UserRole,
} from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ProjectService } from '../project/project.service';
import {
  AcceptQuoteEstimateDto,
  CreateQuoteEstimateDto,
  QuoteEstimateFilterDto,
  QuoteEstimateTaskDto,
  RejectQuoteEstimateDto,
  UpdateQuoteEstimateDto,
} from './dto/quote-estimate.dto';

const includeQuoteEstimate = {
  company: { select: { id: true, name: true } },
  createdBy: { select: { id: true, fullName: true, email: true, role: true } },
  convertedProject: { select: { id: true, name: true, status: true } },
  acceptances: {
    orderBy: { createdAt: 'desc' as const },
    include: {
      acceptedBy: { select: { id: true, fullName: true, email: true } },
    },
  },
  tasks: { orderBy: [{ sortOrder: 'asc' as const }, { createdAt: 'asc' as const }] },
};

@Injectable()
export class QuoteEstimatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly projectService: ProjectService,
  ) {}

  private assertV2Admin(role: string) {
    if (role !== UserRole.admin && role !== UserRole.super_admin) throw new ForbiddenException('Admin access required');
  }

  async exportV2Pdf(input: QuotationV2Dto, role: string) {
    this.assertV2Admin(role);
    return { buffer: await buildQuotationV2Pdf(input), filename: 'quotation.pdf' };
  }

  async emailV2(input: EmailQuotationV2Dto, role: string) {
    this.assertV2Admin(role);
    const pdf = await this.exportV2Pdf(input, role);
    await this.createMailTransporter().sendMail({
      from: this.getMailFromAddress(), to: input.email,
      subject: `Quotation - ${input.project || 'Project'}`,
      text: `Hello ${input.client || 'there'},\n\nPlease find the attached quotation for ${input.project || 'your project'}.\n\n${input.company}`,
      attachments: [{ filename: pdf.filename, content: pdf.buffer, contentType: 'application/pdf' }],
    });
    return { message: 'Quotation emailed successfully' };
  }

  private assertAdmin(role: string) {
    if (
      role !== UserRole.admin &&
      role !== UserRole.super_admin
    ) {
      throw new ForbiddenException('Admin access required');
    }
  }

  private assertQuoteAuthor(role: string) {
    if (
      role !== UserRole.admin &&
      role !== UserRole.super_admin &&
      role !== UserRole.manager
    ) {
      throw new ForbiddenException('Quote access required');
    }
  }

  private toDecimal(value = 0) {
    return new Prisma.Decimal(Number(value || 0).toFixed(2));
  }

  private toNumber(value: unknown) {
    return value instanceof Prisma.Decimal ? Number(value) : value;
  }

  private serialize(quote: any, role: string = UserRole.admin) {
    if (!quote) return quote;
    const tasks = (quote.tasks ?? []).map((task: any) => ({
      ...task,
      quantity: this.toNumber(task.quantity),
      estimatedHours: this.toNumber(task.estimatedHours),
      unitPrice: this.toNumber(task.unitPrice),
      totalPrice: this.toNumber(task.totalPrice),
    }));
    const serialized = {
      ...quote,
      subtotal: this.toNumber(quote.subtotal),
      discountAmount: this.toNumber(quote.discountAmount),
      taxAmount: this.toNumber(quote.taxAmount),
      totalAmount: this.toNumber(quote.totalAmount),
      tasks,
    };
    if (role !== UserRole.manager) return serialized;

    const {
      subtotal: _subtotal,
      discountAmount: _discountAmount,
      taxAmount: _taxAmount,
      totalAmount: _totalAmount,
      pricingConfig: _pricingConfig,
      ...safeQuote
    } = serialized;
    return {
      ...safeQuote,
      tasks: tasks.map(({ unitPrice: _unitPrice, totalPrice: _totalPrice, ...task }) => task),
    };
  }

  private getMailFromAddress() {
    return (
      this.config.get<string>('MAIL_FROM') ??
      this.config.get<string>('MAIL_USER') ??
      'onboarding@proconstructiq.com'
    );
  }

  private createMailTransporter() {
    return nodemailer.createTransport({
      host: this.config.get<string>('MAIL_HOST') ?? 'smtp.resend.com',
      port: this.config.get<number>('MAIL_PORT') ?? 465,
      secure: true,
      auth: {
        user: this.config.get<string>('MAIL_USER') ?? 'resend',
        pass: this.config.get<string>('MAIL_PASS'),
      },
    });
  }

  private money(value: unknown) {
    const amount = Number(this.toNumber(value) ?? 0);
    return `$${amount.toFixed(2)}`;
  }

  private normalizeText(value?: string | null) {
    const normalized = value?.trim();
    return normalized ? normalized : null;
  }

  private normalizeDisplayName(value: string) {
    return value
      .trim()
      .toLocaleLowerCase()
      .replace(/\b\w/g, (character) => character.toLocaleUpperCase());
  }

  private locationToken(value: string) {
    return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }

  private normalizeProjectType(value?: string | null): ProjectType | null {
    const normalized = this.normalizeText(value)?.toLowerCase();
    if (!normalized) return null;
    if (normalized.includes('apartment')) return ProjectType.apartment;
    if (normalized.includes('house')) return ProjectType.house;
    if (Object.values(ProjectType).includes(normalized as ProjectType)) {
      return normalized as ProjectType;
    }
    return null;
  }

  private assertDateRange(startDate?: string | Date | null, endDate?: string | Date | null) {
    if (startDate && endDate && new Date(endDate).getTime() < new Date(startDate).getTime()) {
      throw new BadRequestException('End date must be on or after start date');
    }
  }

  private calculateTotals(
    tasks: QuoteEstimateTaskDto[] = [],
    discountAmount = 0,
    taxAmount = 0,
  ) {
    const normalizedTasks = tasks.map((task, index) => {
      const quantity = task.quantity ?? 1;
      const unitPrice = task.unitPrice ?? 0;
      const totalPrice = Math.round(quantity * unitPrice * 100) / 100;
      return {
        title: task.title.trim(),
        description: this.normalizeText(task.description),
        floorNumber: task.floorNumber ?? null,
        unitName: this.normalizeText(task.unitName),
        plannedFloorLabel: this.normalizeText(task.plannedFloorLabel) ??
          (task.floorNumber != null ? `Floor ${task.floorNumber}` : null),
        plannedUnitLabel: this.normalizeText(task.plannedUnitLabel) ??
          (task.unitName ? `Unit ${task.unitName}` : null),
        plannedLocationKey:
          this.normalizeText(task.plannedLocationKey) ??
          (task.floorNumber != null || task.unitName
            ? `floor_${task.floorNumber ?? 'any'}_unit_${task.unitName ?? 'any'}`
            : null),
        locationMode: task.locationMode ?? 'all',
        selectedFloorNumbers: task.selectedFloorNumbers ?? [],
        selectedUnitNames: (task.selectedUnitNames ?? []).map((name) => name.trim()).filter(Boolean),
        plannedLocationKeys: task.plannedLocationKeys ?? [],
        scopeChecklist: (task.scopeChecklist ?? []).map((item) => item.trim()).filter(Boolean),
        quantity: this.toDecimal(quantity),
        unit: this.normalizeText(task.unit),
        estimatedHours:
          task.estimatedHours === undefined
            ? null
            : this.toDecimal(task.estimatedHours),
        unitPrice: this.toDecimal(unitPrice),
        totalPrice: this.toDecimal(totalPrice),
        sortOrder: task.sortOrder ?? index,
      };
    });

    const subtotal = normalizedTasks.reduce(
      (sum, task) => sum + Number(task.totalPrice),
      0,
    );
    const totalAmount = Math.max(0, subtotal - discountAmount + taxAmount);
    return {
      tasks: normalizedTasks,
      subtotal: this.toDecimal(subtotal),
      discountAmount: this.toDecimal(discountAmount),
      taxAmount: this.toDecimal(taxAmount),
      totalAmount: this.toDecimal(totalAmount),
    };
  }

  private async assertCompany(companyId: string, userId: string, role: string) {
    const company = await this.prisma.company.findFirst({
      where: {
        id: companyId,
        isActive: true,
        ...(role === UserRole.super_admin ? {} : role === UserRole.admin
          ? { ownerId: userId }
          : {
              OR: [
                { members: { some: { userId } } },
                { projects: { some: { teamMembers: { some: { userId } } } } },
              ],
            }),
      },
      select: { id: true },
    });
    if (!company) throw new BadRequestException('Invalid company ID');
  }

  private resolvePlanningRange(input: {
    floorStart?: number | null;
    floorEnd?: number | null;
    unitStart?: number | null;
    unitEnd?: number | null;
    floorsCount?: number | null;
    unitsPerFloor?: number | null;
  }) {
    const hasFloorRange = input.floorStart != null || input.floorEnd != null;
    const hasUnitRange = input.unitStart != null || input.unitEnd != null;
    if (hasFloorRange && (input.floorStart == null || input.floorEnd == null || input.floorEnd < input.floorStart)) {
      throw new BadRequestException('Floor start/end range is invalid');
    }
    if (hasUnitRange && (input.unitStart == null || input.unitEnd == null || input.unitEnd < input.unitStart)) {
      throw new BadRequestException('Unit start/end range is invalid');
    }
    const floorStart = input.floorStart ?? 1;
    const unitStart = input.unitStart ?? 1;
    const floorsCount = hasFloorRange
      ? input.floorEnd! - input.floorStart! + 1
      : input.floorsCount ?? null;
    const unitsPerFloor = hasUnitRange
      ? input.unitEnd! - input.unitStart! + 1
      : input.unitsPerFloor ?? null;
    return {
      floorStart: hasFloorRange ? input.floorStart : null,
      floorEnd: hasFloorRange ? input.floorEnd : null,
      unitStart: hasUnitRange ? input.unitStart : null,
      unitEnd: hasUnitRange ? input.unitEnd : null,
      floorsCount,
      unitsPerFloor,
      totalUnits: floorsCount && unitsPerFloor ? floorsCount * unitsPerFloor : null,
      resolvedFloorStart: floorStart,
      resolvedUnitStart: unitStart,
    };
  }

  private async generateQuoteNumber() {
    const year = new Date().getFullYear();
    const prefix = `QE-${year}-`;
    // A timestamp plus a random suffix prevents duplicate numbers when the
    // dashboard saves multiple quote drafts concurrently.
    const timestamp = Date.now().toString(36).toUpperCase();
    const suffix = Math.floor(Math.random() * 1000)
      .toString()
      .padStart(3, '0');
    return `${prefix}${timestamp}-${suffix}`;
  }

  private async getQuoteOrThrow(id: string, userId: string, role: string) {
    const quote = await this.prisma.quoteEstimate.findFirst({
      where: {
        id,
        ...(role === UserRole.super_admin
          ? {}
          : role === UserRole.admin
            ? { company: { ownerId: userId } }
            : { createdById: userId }),
      },
      include: includeQuoteEstimate,
    });
    if (!quote) throw new NotFoundException('Quote estimate not found');
    return quote;
  }

  async create(
    dto: CreateQuoteEstimateDto,
    userId: string,
    role: string,
  ) {
    this.assertQuoteAuthor(role);
    await this.assertCompany(dto.companyId, userId, role);
    this.assertDateRange(dto.startDate, dto.endDate);
    const managerTasks = role === UserRole.manager
      ? (dto.tasks ?? []).map((task) => ({ ...task, unitPrice: 0 }))
      : dto.tasks;
    const totals = this.calculateTotals(
      managerTasks,
      role === UserRole.manager ? 0 : dto.discountAmount ?? 0,
      role === UserRole.manager ? 0 : dto.taxAmount ?? 0,
    );
    const planning = this.resolvePlanningRange(dto);

    const quote = await this.prisma.quoteEstimate.create({
      data: {
        quoteNumber: await this.generateQuoteNumber(),
        companyId: dto.companyId,
        projectName: this.normalizeDisplayName(dto.projectName),
        clientName: this.normalizeDisplayName(dto.clientName),
        clientEmail: this.normalizeText(dto.clientEmail),
        clientPhone: this.normalizeText(dto.clientPhone),
        projectAddress: this.normalizeText(dto.projectAddress),
        projectType: this.normalizeText(dto.projectType),
        propertyType: this.normalizeText(dto.propertyType),
        unitType: this.normalizeText(dto.unitType),
        startDate: dto.startDate ? new Date(dto.startDate) : null,
        endDate: dto.endDate ? new Date(dto.endDate) : null,
        floorsCount: planning.floorsCount,
        unitsPerFloor: planning.unitsPerFloor,
        floorStart: planning.floorStart,
        floorEnd: planning.floorEnd,
        unitStart: planning.unitStart,
        unitEnd: planning.unitEnd,
        totalUnits: planning.totalUnits,
        subtotal: totals.subtotal,
        discountAmount: totals.discountAmount,
        taxAmount: totals.taxAmount,
        totalAmount: totals.totalAmount,
        schemaVersion: dto.schemaVersion ?? 1,
        ...(dto.quotationDetails !== undefined
          ? { quotationDetails: dto.quotationDetails as Prisma.InputJsonValue }
          : {}),
        ...(dto.buildingPlan !== undefined
          ? { buildingPlan: dto.buildingPlan as Prisma.InputJsonValue }
          : {}),
        ...(role !== UserRole.manager && dto.pricingConfig !== undefined
          ? { pricingConfig: dto.pricingConfig as Prisma.InputJsonValue }
          : {}),
        createdById: userId,
        tasks: {
          create: totals.tasks,
        },
      },
      include: includeQuoteEstimate,
    });

    return {
      message: 'Quote estimate created successfully',
      quote: this.serialize(quote, role),
    };
  }

  async findAll(query: QuoteEstimateFilterDto, userId: string, role: string) {
    this.assertQuoteAuthor(role);
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const where: Prisma.QuoteEstimateWhereInput = {
      ...(role === UserRole.super_admin
        ? {}
        : role === UserRole.admin
          ? { company: { ownerId: userId } }
          : { createdById: userId }),
      ...(query.companyId ? { companyId: query.companyId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { quoteNumber: { contains: query.search, mode: 'insensitive' } },
              { projectName: { contains: query.search, mode: 'insensitive' } },
              { clientName: { contains: query.search, mode: 'insensitive' } },
              { clientEmail: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.quoteEstimate.findMany({
        where,
        include: includeQuoteEstimate,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.quoteEstimate.count({ where }),
    ]);

    return {
      data: items.map((item) => this.serialize(item, role)),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string, userId: string, role: string) {
    this.assertQuoteAuthor(role);
    return this.serialize(await this.getQuoteOrThrow(id, userId, role), role);
  }

  async update(id: string, dto: UpdateQuoteEstimateDto, userId: string, role: string) {
    this.assertQuoteAuthor(role);
    const existing = await this.getQuoteOrThrow(id, userId, role);
    if (dto.companyId) await this.assertCompany(dto.companyId, userId, role);
    if (existing.status === QuoteEstimateStatus.converted) {
      throw new BadRequestException('Converted quote estimates cannot be edited');
    }
    if (
      role === UserRole.manager &&
      (existing.status !== QuoteEstimateStatus.draft || Number(existing.totalAmount) > 0)
    ) {
      throw new ForbiddenException(
        'This quotation is under admin review and can no longer be edited',
      );
    }
    this.assertDateRange(dto.startDate ?? existing.startDate, dto.endDate ?? existing.endDate);

    const nextTasks =
      dto.tasks ??
      existing.tasks.map((task) => ({
        title: task.title,
        description: task.description ?? undefined,
        floorNumber: task.floorNumber ?? undefined,
        unitName: task.unitName ?? undefined,
        plannedFloorLabel: task.plannedFloorLabel ?? undefined,
        plannedUnitLabel: task.plannedUnitLabel ?? undefined,
        plannedLocationKey: task.plannedLocationKey ?? undefined,
        locationMode: (task.locationMode as 'all' | 'selected' | undefined) ?? undefined,
        selectedFloorNumbers: Array.isArray(task.selectedFloorNumbers)
          ? (task.selectedFloorNumbers as number[])
          : undefined,
        selectedUnitNames: Array.isArray(task.selectedUnitNames)
          ? (task.selectedUnitNames as string[])
          : undefined,
        plannedLocationKeys: Array.isArray(task.plannedLocationKeys)
          ? (task.plannedLocationKeys as string[])
          : undefined,
        scopeChecklist: Array.isArray(task.scopeChecklist)
          ? (task.scopeChecklist as string[])
          : undefined,
        quantity: Number(task.quantity),
        unit: task.unit ?? undefined,
        estimatedHours:
          task.estimatedHours === null ? undefined : Number(task.estimatedHours),
        unitPrice: Number(task.unitPrice),
        sortOrder: task.sortOrder,
      }));
    const managerTasks = role === UserRole.manager
      ? nextTasks.map((task) => ({ ...task, unitPrice: 0 }))
      : nextTasks;
    const totals = this.calculateTotals(
      managerTasks,
      role === UserRole.manager ? 0 : dto.discountAmount ?? Number(existing.discountAmount),
      role === UserRole.manager ? 0 : dto.taxAmount ?? Number(existing.taxAmount),
    );
    const planning = this.resolvePlanningRange({
      floorStart: dto.floorStart ?? existing.floorStart,
      floorEnd: dto.floorEnd ?? existing.floorEnd,
      unitStart: dto.unitStart ?? existing.unitStart,
      unitEnd: dto.unitEnd ?? existing.unitEnd,
      floorsCount: dto.floorsCount ?? existing.floorsCount,
      unitsPerFloor: dto.unitsPerFloor ?? existing.unitsPerFloor,
    });
    const floorsCount = planning.floorsCount;
    const unitsPerFloor = planning.unitsPerFloor;
    const totalUnits = planning.totalUnits;

    const quote = await this.prisma.quoteEstimate.update({
      where: { id },
      data: {
        ...(dto.companyId !== undefined ? { companyId: dto.companyId } : {}),
        ...(dto.projectName !== undefined
          ? { projectName: this.normalizeDisplayName(dto.projectName) }
          : {}),
        ...(dto.clientName !== undefined
          ? { clientName: this.normalizeDisplayName(dto.clientName) }
          : {}),
        ...(dto.clientEmail !== undefined
          ? { clientEmail: this.normalizeText(dto.clientEmail) }
          : {}),
        ...(dto.clientPhone !== undefined
          ? { clientPhone: this.normalizeText(dto.clientPhone) }
          : {}),
        ...(dto.projectAddress !== undefined
          ? { projectAddress: this.normalizeText(dto.projectAddress) }
          : {}),
        ...(dto.projectType !== undefined
          ? { projectType: this.normalizeText(dto.projectType) }
          : {}),
        ...(dto.propertyType !== undefined
          ? { propertyType: this.normalizeText(dto.propertyType) }
          : {}),
        ...(dto.unitType !== undefined
          ? { unitType: this.normalizeText(dto.unitType) }
          : {}),
        ...(dto.startDate !== undefined
          ? { startDate: dto.startDate ? new Date(dto.startDate) : null }
          : {}),
        ...(dto.endDate !== undefined
          ? { endDate: dto.endDate ? new Date(dto.endDate) : null }
          : {}),
        ...(dto.floorsCount !== undefined ? { floorsCount } : {}),
        ...(dto.unitsPerFloor !== undefined ? { unitsPerFloor } : {}),
        ...(dto.floorsCount !== undefined || dto.unitsPerFloor !== undefined ||
          dto.floorStart !== undefined || dto.floorEnd !== undefined ||
          dto.unitStart !== undefined || dto.unitEnd !== undefined
          ? {
              floorsCount,
              unitsPerFloor,
              floorStart: planning.floorStart,
              floorEnd: planning.floorEnd,
              unitStart: planning.unitStart,
              unitEnd: planning.unitEnd,
              totalUnits,
            }
          : {}),
        ...(role !== UserRole.manager && dto.status !== undefined ? { status: dto.status } : {}),
        subtotal: totals.subtotal,
        discountAmount: totals.discountAmount,
        taxAmount: totals.taxAmount,
        totalAmount: totals.totalAmount,
        ...(dto.schemaVersion !== undefined ? { schemaVersion: dto.schemaVersion } : {}),
        ...(dto.quotationDetails !== undefined
          ? { quotationDetails: dto.quotationDetails as Prisma.InputJsonValue }
          : {}),
        ...(dto.buildingPlan !== undefined
          ? { buildingPlan: dto.buildingPlan as Prisma.InputJsonValue }
          : {}),
        ...(role !== UserRole.manager && dto.pricingConfig !== undefined
          ? { pricingConfig: dto.pricingConfig as Prisma.InputJsonValue }
          : {}),
        ...(dto.tasks !== undefined
          ? {
              tasks: {
                deleteMany: {},
                create: totals.tasks,
              },
            }
          : {}),
      },
      include: includeQuoteEstimate,
    });

    return {
      message: 'Quote estimate updated successfully',
      quote: this.serialize(quote, role),
    };
  }

  async remove(id: string, userId: string, role: string) {
    this.assertQuoteAuthor(role);
    const existing = await this.getQuoteOrThrow(id, userId, role);
    if (role === UserRole.manager && existing.status !== QuoteEstimateStatus.draft) {
      throw new ForbiddenException(
        'Only draft quotation requests can be deleted by a manager',
      );
    }
    if (existing.status === QuoteEstimateStatus.converted) {
      throw new BadRequestException('Converted quote estimates cannot be deleted');
    }
    await this.prisma.quoteEstimate.delete({ where: { id } });
    return { message: 'Quote estimate deleted successfully', id };
  }

  async send(id: string, userId: string, role: string) {
    this.assertAdmin(role);
    const existing = await this.getQuoteOrThrow(id, userId, role);
    if (!existing.clientEmail) {
      throw new BadRequestException('Client email is required before sending');
    }

    const pdf = await this.exportPdf(id, userId, role);
    await this.createMailTransporter().sendMail({
      from: this.getMailFromAddress(),
      to: existing.clientEmail,
      subject: `Quote Estimate ${existing.quoteNumber} - ${existing.projectName}`,
      html: `
        <div style="font-family: Arial, sans-serif; color: #1f2937; max-width: 640px;">
          <h2 style="color: #1D4F6D; margin-bottom: 8px;">Quote Estimate</h2>
          <p>Hello ${existing.clientName},</p>
          <p>Please find the attached quote estimate for <strong>${existing.projectName}</strong>.</p>
          <p><strong>Total:</strong> ${this.money(existing.totalAmount)}</p>
          <p style="color: #6b7280; font-size: 12px;">This quote was sent from Finis.</p>
        </div>
      `,
      attachments: [
        {
          filename: pdf.filename,
          content: pdf.buffer,
          contentType: 'application/pdf',
        },
      ],
    });

    const quote = await this.prisma.quoteEstimate.update({
      where: { id },
      data: { status: QuoteEstimateStatus.sent, sentAt: new Date() },
      include: includeQuoteEstimate,
    });
    return {
      message: 'Quote estimate marked as sent',
      quote: this.serialize(quote),
    };
  }

  async exportPdf(id: string, userId: string, role: string) {
    this.assertAdmin(role);
    const quote = await this.getQuoteOrThrow(id, userId, role);
    const doc = new PDFDocument({ size: 'A4', margin: 44, bufferPages: true });
    const chunks: Buffer[] = [];

    const buffer = await new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (chunk) =>
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
      );
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const pageWidth = 507;
      const ensureSpace = (height: number) => {
        if (doc.y + height > 755) doc.addPage();
      };
      const section = (title: string, subtitle?: string) => {
        ensureSpace(subtitle ? 58 : 42);
        doc.moveDown(0.8);
        doc.font('Helvetica-Bold').fontSize(13).fillColor('#1D4F6D').text(title);
        if (subtitle) {
          doc.font('Helvetica').fontSize(9).fillColor('#64748B').text(subtitle);
        }
        doc.moveDown(0.45);
      };
      const infoRow = (label: string, value: unknown) => {
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#475569').text(label, {
          continued: true,
        });
        doc.font('Helvetica').fillColor('#111827').text(`  ${String(value || 'N/A')}`);
      };

      doc.roundedRect(44, 44, pageWidth, 104, 10).fill('#1D4F6D');
      doc.font('Helvetica-Bold').fontSize(25).fillColor('#FFFFFF').text('QUOTATION & SERVICE AGREEMENT', 62, 62, { width: 470 });
      doc.font('Helvetica').fontSize(10).fillColor('#DCEAF2').text(quote.company.name, 62, 98);
      doc.text(`Document No: ${quote.quoteNumber}`, 350, 98, { width: 180, align: 'right' });
      doc.text(`Issued: ${quote.createdAt.toLocaleDateString('en-CA')}`, 350, 116, { width: 180, align: 'right' });
      doc.y = 166;

      doc.font('Helvetica-Bold').fontSize(17).fillColor('#111827').text(quote.projectName);
      doc.font('Helvetica').fontSize(9).fillColor('#64748B').text('This document records the proposed scope, price, schedule and acceptance terms for the services described below.');

      section('1. PARTIES & PROJECT');
      infoRow('Service Provider', quote.company.name);
      infoRow('Customer / Service Receiver', quote.clientName);
      infoRow('Customer Email', quote.clientEmail);
      infoRow('Customer Phone', quote.clientPhone);
      infoRow('Service Address', quote.projectAddress);
      infoRow('Project Classification', [quote.projectType, quote.propertyType, quote.unitType].filter(Boolean).join(' / '));
      infoRow('Proposed Schedule', `${quote.startDate ? quote.startDate.toLocaleDateString('en-CA') : 'N/A'} to ${quote.endDate ? quote.endDate.toLocaleDateString('en-CA') : 'N/A'}`);

      const quotationDetails = Array.isArray(quote.quotationDetails)
        ? (quote.quotationDetails as any[])
        : [];
      if (quotationDetails.length) {
        section('2. QUOTATION DETAILS & TERMS');
        for (const block of quotationDetails) {
          ensureSpace(34);
          const text = Array.isArray(block?.runs)
            ? block.runs.map((run: any) => String(run?.text ?? '')).join('')
            : '';
          if (!text.trim()) continue;
          doc
            .font(block.heading ? 'Helvetica-Bold' : 'Helvetica')
            .fontSize(block.heading ? 12 : 9.5)
            .fillColor('#334155')
            .text(`${block.bullet ? '• ' : ''}${text}`, { width: pageWidth, lineGap: 2 });
          doc.moveDown(0.3);
        }
      }

      section(quotationDetails.length ? '3. SCOPE OF SERVICES' : '2. SCOPE OF SERVICES', 'Only the listed services and quantities are included in this quotation.');
      quote.tasks.forEach((task, index) => {
        ensureSpace(task.description ? 70 : 50);
        const top = doc.y;
        doc.roundedRect(44, top, pageWidth, task.description ? 60 : 44, 6).fillAndStroke('#F8FAFC', '#E2E8F0');
        doc.font('Helvetica-Bold').fontSize(10).fillColor('#111827').text(`${index + 1}. ${task.title}`, 56, top + 10, { width: 300 });
        doc.font('Helvetica-Bold').fontSize(10).fillColor('#1D4F6D').text(this.money(task.totalPrice), 410, top + 10, { width: 125, align: 'right' });
        doc.font('Helvetica').fontSize(8.5).fillColor('#64748B').text(`${Number(task.quantity)} ${task.unit ?? 'unit'} × ${this.money(task.unitPrice)}`, 56, top + 28, { width: 250 });
        if (task.description) doc.text(task.description, 56, top + 43, { width: 465, ellipsis: true });
        doc.y = top + (task.description ? 66 : 50);
      });

      section(quotationDetails.length ? '4. CONTRACT VALUE' : '3. CONTRACT VALUE');
      doc.font('Helvetica').fontSize(10).fillColor('#334155')
        .text(`Subtotal: ${this.money(quote.subtotal)}`, { align: 'right' })
        .text(`Discount: ${this.money(quote.discountAmount)}`, { align: 'right' })
        .text(`Tax: ${this.money(quote.taxAmount)}`, { align: 'right' });
      doc.moveDown(0.35);
      doc.roundedRect(351, doc.y, 200, 42, 7).fill('#1D4F6D');
      doc.font('Helvetica-Bold').fontSize(15).fillColor('#FFFFFF').text(`TOTAL  ${this.money(quote.totalAmount)}`, 365, doc.y + 13, { width: 172, align: 'right' });
      doc.y += 54;

      section(quotationDetails.length ? '5. ACCEPTANCE & SIGNATURES' : '4. ACCEPTANCE & SIGNATURES', 'By signing below, both parties acknowledge and accept this quotation and its stated scope and terms.');
      ensureSpace(145);
      const signatureY = doc.y + 38;
      doc.moveTo(44, signatureY).lineTo(276, signatureY).strokeColor('#94A3B8').stroke();
      doc.moveTo(319, signatureY).lineTo(551, signatureY).strokeColor('#94A3B8').stroke();
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#111827').text('For the Company / Service Provider', 44, signatureY + 8, { width: 232 });
      doc.text('Customer / Service Receiver', 319, signatureY + 8, { width: 232 });
      doc.font('Helvetica').fontSize(8).fillColor('#64748B').text('Authorized name & signature', 44, signatureY + 24, { width: 232 });
      doc.text('Name & signature', 319, signatureY + 24, { width: 232 });
      doc.moveTo(44, signatureY + 66).lineTo(276, signatureY + 66).strokeColor('#CBD5E1').stroke();
      doc.moveTo(319, signatureY + 66).lineTo(551, signatureY + 66).strokeColor('#CBD5E1').stroke();
      doc.fontSize(8).text('Date', 44, signatureY + 72).text('Date', 319, signatureY + 72);

      const range = doc.bufferedPageRange();
      for (let page = range.start; page < range.start + range.count; page += 1) {
        doc.switchToPage(page);
        doc.font('Helvetica').fontSize(7.5).fillColor('#94A3B8').text(
          `${quote.quoteNumber}  •  Confidential contract document  •  Page ${page + 1} of ${range.count}`,
          44,
          800,
          { width: pageWidth, align: 'center', lineBreak: false },
        );
      }

      doc.end();
    });

    return {
      buffer,
      filename: `${quote.quoteNumber}.pdf`,
    };
  }

  async accept(
    id: string,
    dto: AcceptQuoteEstimateDto,
    userId: string,
    role: string,
  ) {
    this.assertAdmin(role);
    await this.getQuoteOrThrow(id, userId, role);
    const quote = await this.prisma.quoteEstimate.update({
      where: { id },
      data: {
        status: QuoteEstimateStatus.accepted,
        acceptedAt: new Date(),
        acceptances: {
          create: {
            acceptedByName: this.normalizeText(dto.acceptedByName),
            notes: this.normalizeText(dto.notes),
            acceptedById: userId,
          },
        },
      },
      include: includeQuoteEstimate,
    });
    return {
      message: 'Quote estimate accepted successfully',
      quote: this.serialize(quote),
    };
  }

  async reject(id: string, dto: RejectQuoteEstimateDto, userId: string, role: string) {
    this.assertAdmin(role);
    await this.getQuoteOrThrow(id, userId, role);
    const quote = await this.prisma.quoteEstimate.update({
      where: { id },
      data: {
        status: QuoteEstimateStatus.rejected,
        rejectedAt: new Date(),
        acceptances: dto.notes
          ? { create: { notes: this.normalizeText(dto.notes) } }
          : undefined,
      },
      include: includeQuoteEstimate,
    });
    return {
      message: 'Quote estimate rejected successfully',
      quote: this.serialize(quote),
    };
  }

  async cancel(id: string, userId: string, role: string) {
    this.assertAdmin(role);
    await this.getQuoteOrThrow(id, userId, role);
    const quote = await this.prisma.quoteEstimate.update({
      where: { id },
      data: { status: QuoteEstimateStatus.cancelled },
      include: includeQuoteEstimate,
    });
    return {
      message: 'Quote estimate cancelled successfully',
      quote: this.serialize(quote),
    };
  }

  async convertToProject(id: string, userId: string, role: string) {
    return this.acceptAndCreateProject(id, {}, userId, role);
  }

  async acceptAndCreateProject(
    id: string,
    dto: AcceptQuoteEstimateDto,
    userId: string,
    role: string,
  ) {
    this.assertAdmin(role);
    const existing = await this.getQuoteOrThrow(id, userId, role);
    if (existing.convertedProjectId) {
      const existingTaskCount = await this.prisma.task.count({
        where: { projectId: existing.convertedProjectId },
      });
      if (existingTaskCount === 0 && existing.tasks.length > 0) {
        await this.createTasksFromQuoteLines(
          existing.convertedProjectId,
          existing,
          userId,
        );
        return {
          message: 'Quote estimate project tasks created successfully',
          project: await this.prisma.project.findUnique({
            where: { id: existing.convertedProjectId },
          }),
          quote: this.serialize(await this.getQuoteOrThrow(id, userId, role)),
        };
      }
      return {
        message: 'Quote estimate already converted to project',
        project: await this.prisma.project.findUnique({
          where: { id: existing.convertedProjectId },
        }),
        quote: this.serialize(existing),
      };
    }
    const convertibleStatuses: QuoteEstimateStatus[] = [
      QuoteEstimateStatus.accepted,
      QuoteEstimateStatus.sent,
      QuoteEstimateStatus.draft,
    ];
    if (!convertibleStatuses.includes(existing.status)) {
      throw new BadRequestException(
        'Only draft, sent, or accepted quote estimates can be converted',
      );
    }

    await this.projectService.assertProjectCreationAllowed(
      existing.companyId,
      userId,
      role,
    );

    const projectType =
      this.normalizeProjectType(existing.projectType) ??
      this.normalizeProjectType(existing.propertyType) ??
      this.normalizeProjectType(existing.unitType);
    const contractTotal = this.toDecimal(Number(existing.totalAmount));
    const buildingPlan = existing.buildingPlan as {
      floors?: Array<{
        label?: string;
        selected?: boolean;
        units?: Array<{ label?: string; selected?: boolean }>;
      }>;
    } | null;
    const plannedFloors = Array.isArray(buildingPlan?.floors)
      ? buildingPlan.floors.filter(
          (floor) => floor.selected !== false && floor.units?.some((unit) => unit.selected !== false),
        )
      : [];
    const project = await this.prisma.$transaction(async (tx) => {
      const createdProject = await tx.project.create({
        data: {
          companyId: existing.companyId,
          managerId: userId,
          name: existing.projectName,
          type: projectType,
          startDate: existing.startDate,
          endDate: existing.endDate,
          budget: Number(existing.totalAmount),
          originalContract: contractTotal,
          totalContractAmount: contractTotal,
          totalReceived: this.toDecimal(0),
          contractBalance: contractTotal,
          financialStatus: 'unpaid',
          location: existing.projectAddress,
          description: `Converted from quote ${existing.quoteNumber}`,
          numFloors: existing.floorsCount,
          unitPerFloor: existing.unitsPerFloor,
          status: 'planning',
          progress: 0,
        },
      });

      const createdFloors: { id: string; floorNumber: number }[] = [];
      const createdUnits: { id: string; floorId: string; name: string }[] = [];

      if (plannedFloors.length) {
        for (const [floorIndex, plannedFloor] of plannedFloors.entries()) {
          const floorNumber = floorIndex + 1;
          const floor = await tx.floor.create({
            data: {
              projectId: createdProject.id,
              name: this.normalizeText(plannedFloor.label) ?? `Floor ${floorNumber}`,
              floorNumber,
              status: 'pending',
              progress: 0,
            },
          });
          createdFloors.push({ id: floor.id, floorNumber });
          for (const [unitIndex, plannedUnit] of (plannedFloor.units ?? [])
            .filter((unit) => unit.selected !== false)
            .entries()) {
            const unit = await tx.unit.create({
              data: {
                floorId: floor.id,
                name: this.normalizeText(plannedUnit.label) ?? String(unitIndex + 1),
                status: 'pending',
                progress: 0,
              },
            });
            createdUnits.push({ id: unit.id, floorId: floor.id, name: unit.name });
          }
        }
      } else if (existing.floorsCount && existing.unitsPerFloor) {
        const floorStart = existing.floorStart ?? 1;
        const unitStart = existing.unitStart ?? 1;
        for (
          let floorNumber = floorStart;
          floorNumber < floorStart + existing.floorsCount;
          floorNumber++
        ) {
          const floor = await tx.floor.create({
            data: {
              projectId: createdProject.id,
              name: floorNumber === 1 ? 'Ground Floor' : `Floor ${floorNumber}`,
              floorNumber,
              status: 'pending',
              progress: 0,
            },
          });
          createdFloors.push({ id: floor.id, floorNumber });
          for (let unitOffset = 0; unitOffset < existing.unitsPerFloor; unitOffset++) {
            const unitIncrement = String(unitStart).length >= 4 ? 1000 : 100;
            const unitIndex = unitStart + (floorNumber - floorStart) * unitIncrement + unitOffset;
            const unit = await tx.unit.create({
              data: {
                floorId: floor.id,
                name: String(unitIndex),
                status: 'pending',
                progress: 0,
              },
            });
            createdUnits.push({
              id: unit.id,
              floorId: floor.id,
              name: unit.name,
            });
          }
        }
      }

      await tx.messageThread.create({
        data: {
          type: 'group',
          name: createdProject.name,
          projectId: createdProject.id,
          isActive: true,
          participants: {
            create: { userId, role },
          },
        },
      });

      await this.createTasksFromQuoteLines(
        createdProject.id,
        existing,
        userId,
        tx,
      );

      await tx.quoteEstimate.update({
        where: { id },
        data: {
          status: QuoteEstimateStatus.converted,
          convertedProjectId: createdProject.id,
          acceptedAt: existing.acceptedAt ?? new Date(),
          acceptances: {
            create: {
              acceptedByName:
                this.normalizeText(dto.acceptedByName) ?? existing.clientName,
              notes:
                this.normalizeText(dto.notes) ??
                `Accepted and converted from quote ${existing.quoteNumber}`,
              acceptedById: userId,
            },
          },
        },
      });

      return createdProject;
    });

    return {
      message: 'Quote estimate accepted and project created successfully',
      project,
      quote: this.serialize(await this.getQuoteOrThrow(id, userId, role)),
    };
  }

  private async createTasksFromQuoteLines(
    projectId: string,
    quote: Awaited<ReturnType<QuoteEstimatesService['getQuoteOrThrow']>>,
    userId: string,
    tx: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    const floors = await tx.floor.findMany({
      where: { projectId },
      select: { id: true, floorNumber: true, name: true },
      orderBy: { floorNumber: 'asc' },
    });
    const units = await tx.unit.findMany({
      where: { floor: { projectId } },
      select: { id: true, floorId: true, name: true },
      orderBy: [{ floor: { floorNumber: 'asc' } }, { name: 'asc' }],
    });

    for (const [index, quoteTask] of quote.tasks.entries()) {
      const plannedFloorNumber = quoteTask.floorNumber ?? Number(
        quoteTask.plannedFloorLabel?.match(/\d+/)?.[0],
      );
      const plannedUnitName =
        quoteTask.unitName ?? quoteTask.plannedUnitLabel?.replace(/^unit\s+/i, '');
      const matchedFloor = plannedFloorNumber
        ? floors.find((floor) => floor.floorNumber === plannedFloorNumber)
        : floors[0];
      const plannedLocationKey = quoteTask.plannedLocationKey?.toLowerCase();
      const matchedUnit = plannedUnitName
        ? units.find((unit) => {
            return (
              unit.name.toLowerCase() === plannedUnitName.toLowerCase() &&
              (!matchedFloor || unit.floorId === matchedFloor.id) ||
              (plannedLocationKey?.includes(`unit_${unit.name.toLowerCase()}`) &&
                (!matchedFloor || unit.floorId === matchedFloor.id))
            );
          })
        : units.find((unit) => !matchedFloor || unit.floorId === matchedFloor.id) ?? units[0];
      const plannedLocationKeys = Array.isArray(quoteTask.plannedLocationKeys)
        ? (quoteTask.plannedLocationKeys as string[])
            .map((key) => key.toLowerCase())
            .filter(Boolean)
        : [];
      const taskUnits = plannedLocationKeys.length
        ? units.filter((unit) => {
            const floor = floors.find((item) => item.id === unit.floorId);
            return Boolean(
              floor &&
                (plannedLocationKeys.includes(
                  `floor_${floor.floorNumber}_unit_${unit.name.toLowerCase()}`,
                ) ||
                  plannedLocationKeys.includes(
                    `floor_${this.locationToken(floor.name)}_unit_${this.locationToken(unit.name)}`,
                  )),
            );
          })
        : matchedUnit
        ? [matchedUnit]
        : (() => {
            const selectedFloors = Array.isArray(quoteTask.selectedFloorNumbers)
              ? (quoteTask.selectedFloorNumbers as number[])
              : [];
            const selectedUnits = Array.isArray(quoteTask.selectedUnitNames)
              ? (quoteTask.selectedUnitNames as string[]).map((name) => name.toLowerCase())
              : [];
            return units.filter((unit) => {
              const floor = floors.find((item) => item.id === unit.floorId);
              const floorMatches = selectedFloors.length
                ? Boolean(floor && selectedFloors.includes(floor.floorNumber))
                : matchedFloor
                  ? unit.floorId === matchedFloor.id
                  : true;
              const unitMatches = selectedUnits.length
                ? selectedUnits.includes(unit.name.toLowerCase())
                : true;
              return floorMatches && unitMatches;
            });
          })();

      const taskFloorIds = Array.from(
        new Set(taskUnits.map((unit) => unit.floorId)),
      );

      const taskPrice = Number(quoteTask.totalPrice || quoteTask.unitPrice || 0);

      const task = await tx.task.create({
        data: {
          projectId,
          floorId: taskFloorIds.length === 1 ? taskFloorIds[0] : null,
          unitId: matchedUnit?.id ?? null,
          createdBy: userId,
          title: quoteTask.title,
          description:
            quoteTask.description ??
            `Converted from quote ${quote.quoteNumber} line ${index + 1}`,
          priority: 'medium',
          status: 'pending',
          price: taskPrice,
          approvalDecision: 'approved',
          approvalReviewedBy: userId,
          approvalReviewedAt: new Date(),
          estimatedHours:
            quoteTask.estimatedHours === null
              ? null
              : Math.round(Number(quoteTask.estimatedHours) * Math.max(taskUnits.length, 1)),
        },
      });

      if (taskFloorIds.length) {
        await tx.taskFloor.createMany({
          data: taskFloorIds.map((floorId) => ({ taskId: task.id, floorId })),
          skipDuplicates: true,
        });
      }

      if (taskUnits.length) {
        await tx.taskUnit.createMany({
          data: taskUnits.map((unit) => ({
            taskId: task.id,
            unitId: unit.id,
          })),
          skipDuplicates: true,
        });

        const subTaskPrice = Number((taskPrice / taskUnits.length).toFixed(2));

        await tx.subTask.createMany({
          data: taskUnits.map((unit) => ({
            taskId: task.id,
            unitId: unit.id,
            createdBy: userId,
            title: `${quoteTask.title} - Unit ${unit.name}`,
            description:
              quoteTask.description ??
              `Locked-price subtask from quote ${quote.quoteNumber}`,
            priority: 'medium',
            status: 'pending',
            price: subTaskPrice,
            approvalDecision: 'approved',
            approvalReviewedBy: userId,
            approvalReviewedAt: new Date(),
            estimatedHours:
              quoteTask.estimatedHours === null
                ? null
                : Math.round(Number(quoteTask.estimatedHours)),
          })),
        });
      }
    }
  }
}

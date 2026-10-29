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
            ? {
                OR: [
                  { company: { ownerId: userId } },
                  { createdById: userId },
                ],
              }
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
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
    const chunks: Buffer[] = [];

    const buffer = await new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (chunk) =>
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
      );
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const pageWidth = 515;
      const ensureSpace = (height: number) => {
        if (doc.y + height > 750) {
          doc.addPage();
          doc.y = 40;
        }
      };

      const section = (title: string, subtitle?: string) => {
        ensureSpace(subtitle ? 52 : 38);
        doc.moveDown(0.7);
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#1D4F6D').text(title);
        if (subtitle) {
          doc.font('Helvetica').fontSize(8.5).fillColor('#64748B').text(subtitle);
        }
        doc.moveDown(0.35);
      };

      // Header Banner
      doc.roundedRect(40, 40, pageWidth, 106, 8).fill('#1D4F6D');

      // Header Tag
      doc.roundedRect(54, 52, 210, 16, 4).fill('#13394F');
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#99C7E3').text('COMMERCIAL CONTRACT & QUOTATION', 54, 56, { width: 210, align: 'center' });

      // Title & Company
      doc.font('Helvetica-Bold').fontSize(18).fillColor('#FFFFFF').text('QUOTATION & SERVICE AGREEMENT', 54, 75, { width: 300 });
      doc.font('Helvetica').fontSize(9.5).fillColor('#DCEAF2').text(quote.company?.name || 'Company / Service Provider', 54, 100, { width: 300 });
      doc.font('Helvetica').fontSize(8).fillColor('#A3C8DE').text('Binding commercial contract upon mutual execution', 54, 115, { width: 300 });

      // Header Meta (Right)
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#FFFFFF').text(`Ref: ${quote.quoteNumber}`, 320, 56, { width: 220, align: 'right' });
      const issuedDateStr = quote.createdAt ? new Date(quote.createdAt).toLocaleDateString('en-CA') : new Date().toLocaleDateString('en-CA');
      doc.font('Helvetica').fontSize(8.5).fillColor('#DCEAF2').text(`Issued: ${issuedDateStr}`, 320, 74, { width: 220, align: 'right' });
      const statusText = (quote.status || 'ISSUED').toUpperCase();
      doc.roundedRect(440, 94, 100, 18, 4).fill('#246387');
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#FFFFFF').text(statusText, 440, 99, { width: 100, align: 'center' });

      doc.y = 158;

      // Legal Contract Preamble
      doc.roundedRect(40, doc.y, pageWidth, 36, 5).fillAndStroke('#F8FAFC', '#E2E8F0');
      doc.font('Helvetica-Oblique').fontSize(8).fillColor('#475569').text(
        'This Document constitutes a formal Commercial Quotation and Service Agreement ("Agreement") between the Parties identified below. Mutual signature and execution of this Agreement establishes the agreed scope of works, specifications, pricing, and legally binding terms governing the project.',
        48,
        doc.y + 7,
        { width: 499, lineGap: 1.5 },
      );
      doc.y = 202;

      // Section 1: Parties & Project Specifications
      section('1. CONTRACT PARTIES & PROJECT SPECIFICATIONS');
      const partiesY = doc.y;
      const boxHeight = 96;

      // Party A: Service Provider Box
      doc.roundedRect(40, partiesY, 250, boxHeight, 6).fillAndStroke('#FFFFFF', '#E2E8F0');
      doc.roundedRect(40, partiesY, 250, 20, 5).fill('#F1F5F9');
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#1D4F6D').text('PARTY A: SERVICE PROVIDER (COMPANY)', 48, partiesY + 6);
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#0F172A').text(quote.company?.name || 'Company / Service Provider', 48, partiesY + 26, { width: 234 });
      doc.font('Helvetica').fontSize(8).fillColor('#475569')
        .text(`Representative: ${quote.createdBy?.fullName || 'Company Signatory'}`, 48, partiesY + 42, { width: 234 })
        .text(`Email: ${quote.createdBy?.email || 'N/A'}`, 48, partiesY + 56, { width: 234 })
        .text('Role: Prime Contractor & Service Provider', 48, partiesY + 70, { width: 234 });

      // Party B: Customer / Service Receiver Box
      doc.roundedRect(305, partiesY, 250, boxHeight, 6).fillAndStroke('#FFFFFF', '#E2E8F0');
      doc.roundedRect(305, partiesY, 250, 20, 5).fill('#F1F5F9');
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#1D4F6D').text('PARTY B: CUSTOMER / SERVICE RECEIVER', 313, partiesY + 6);
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#0F172A').text(quote.clientName || 'Customer / Service Receiver', 313, partiesY + 26, { width: 234 });
      doc.font('Helvetica').fontSize(8).fillColor('#475569')
        .text(`Phone: ${quote.clientPhone || 'N/A'}`, 313, partiesY + 42, { width: 234 })
        .text(`Email: ${quote.clientEmail || 'N/A'}`, 313, partiesY + 56, { width: 234 })
        .text(`Address: ${quote.projectAddress || 'N/A'}`, 313, partiesY + 70, { width: 234 });

      doc.y = partiesY + boxHeight + 8;

      // Project Specs Bar
      doc.roundedRect(40, doc.y, pageWidth, 42, 5).fillAndStroke('#F8FAFC', '#E2E8F0');
      const specsY = doc.y;
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#1D4F6D').text('Project Name:', 48, specsY + 7);
      doc.font('Helvetica').fontSize(8.5).fillColor('#0F172A').text(` ${quote.projectName || 'Project'}`, 115, specsY + 7, { width: 390 });
      const classification = [quote.projectType, quote.propertyType, quote.unitType].filter(Boolean).join(' • ') || 'General Construction';
      const scheduleStr = `${quote.startDate ? new Date(quote.startDate).toLocaleDateString('en-CA') : 'TBD'} to ${quote.endDate ? new Date(quote.endDate).toLocaleDateString('en-CA') : 'TBD'}`;
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#475569').text('Classification:', 48, specsY + 23);
      doc.font('Helvetica').fontSize(8).fillColor('#0F172A').text(` ${classification}`, 115, specsY + 23);
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#475569').text('Schedule:', 320, specsY + 23);
      doc.font('Helvetica').fontSize(8).fillColor('#0F172A').text(` ${scheduleStr}`, 375, specsY + 23);

      doc.y = specsY + 50;

      // Section 2: Quotation Details & Terms
      const quotationDetails = Array.isArray(quote.quotationDetails)
        ? (quote.quotationDetails as any[])
        : [];

      section('2. QUOTATION DETAILS & CONTRACT TERMS');
      if (quotationDetails.length) {
        for (const block of quotationDetails) {
          ensureSpace(30);
          const headingLevel = ([1, 2, 3, 4, 5].includes(Number(block?.headingLevel))
            ? Number(block.headingLevel)
            : 2) as 1 | 2 | 3 | 4 | 5;
          const headingSizes: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 14, 2: 12, 3: 11, 4: 10, 5: 9.5 };
          const runs = Array.isArray(block?.runs) ? block.runs.filter((r: any) => r?.text) : [];
          if (!runs.length) continue;

          if (block.heading) {
            const headingText = runs.map((r: any) => String(r.text || '')).join('');
            doc.font('Helvetica-Bold').fontSize(headingSizes[headingLevel]).fillColor('#1D4F6D').text(headingText, { width: pageWidth });
            doc.moveDown(0.2);
          } else {
            const prefix = block.bullet ? '• ' : '';
            doc.font('Helvetica').fontSize(9).fillColor('#334155');
            runs.forEach((run: any, idx: number) => {
              const fontName = run.bold ? (run.italic ? 'Helvetica-BoldOblique' : 'Helvetica-Bold') : (run.italic ? 'Helvetica-Oblique' : 'Helvetica');
              doc.font(fontName).fontSize(run.fontSize || 9).text(`${idx === 0 ? prefix : ''}${run.text}`, {
                continued: idx < runs.length - 1,
                underline: Boolean(run.underline),
                width: pageWidth,
                lineGap: 2,
              });
            });
            doc.moveDown(0.25);
          }
        }
      } else {
        const terms = [
          '1. Scope of Work: The Service Provider agrees to provide all labor, materials, and equipment required to complete the itemized services detailed in Section 3 in a good and workmanlike manner.',
          '2. Contract Consideration & Payment: Invoices will be rendered upon completion and inspection of designated milestones or tasks. Payment is due within the agreed payment schedule.',
          '3. Variations & Change Orders: Any modification, addition, or deletion to the described work must be agreed upon in writing by both parties before proceeding.',
          '4. Acceptance & Validity: This quotation remains open for formal acceptance for 30 calendar days from the date of issue unless extended in writing by the Service Provider.',
        ];
        for (const term of terms) {
          ensureSpace(20);
          doc.font('Helvetica').fontSize(8.5).fillColor('#475569').text(term, { width: pageWidth, lineGap: 1.5 });
          doc.moveDown(0.2);
        }
      }

      // Section 3: Scope of Services & Itemized Work Schedule
      section('3. SCOPE OF SERVICES & ITEMIZED WORK SCHEDULE', 'Only items and quantities explicitly enumerated below are included in this contract.');
      ensureSpace(40);

      // Table Header
      const tableHeaderY = doc.y;
      doc.roundedRect(40, tableHeaderY, pageWidth, 22, 3).fill('#1E293B');
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#FFFFFF');
      doc.text('#', 46, tableHeaderY + 6, { width: 20 });
      doc.text('SERVICE / WORK ITEM DESCRIPTION', 72, tableHeaderY + 6, { width: 228 });
      doc.text('QUANTITY', 305, tableHeaderY + 6, { width: 65, align: 'right' });
      doc.text('UNIT RATE', 375, tableHeaderY + 6, { width: 65, align: 'right' });
      doc.text('LINE TOTAL', 445, tableHeaderY + 6, { width: 95, align: 'right' });
      doc.y = tableHeaderY + 24;

      // Table Rows
      (quote.tasks || []).forEach((task, index) => {
        const hasDesc = Boolean(task.description);
        const rowHeight = hasDesc ? 44 : 26;
        ensureSpace(rowHeight + 6);
        const rowY = doc.y;

        if (index % 2 === 1) {
          doc.roundedRect(40, rowY, pageWidth, rowHeight, 2).fill('#F8FAFC');
        }

        doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#0F172A').text(`${index + 1}`, 46, rowY + 6, { width: 20 });
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#0F172A').text(task.title || 'Service Item', 72, rowY + 6, { width: 228 });
        doc.font('Helvetica').fontSize(8).fillColor('#475569').text(`${Number(task.quantity || 1)} ${task.unit ?? 'unit'}`, 305, rowY + 6, { width: 65, align: 'right' });
        doc.font('Helvetica').fontSize(8).fillColor('#475569').text(this.money(task.unitPrice), 375, rowY + 6, { width: 65, align: 'right' });
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#1D4F6D').text(this.money(task.totalPrice), 445, rowY + 6, { width: 95, align: 'right' });

        if (hasDesc) {
          doc.font('Helvetica').fontSize(7.5).fillColor('#64748B').text(task.description!, 72, rowY + 20, { width: 360, ellipsis: true });
        }

        doc.moveTo(40, rowY + rowHeight).lineTo(40 + pageWidth, rowY + rowHeight).strokeColor('#E2E8F0').lineWidth(0.5).stroke();
        doc.y = rowY + rowHeight + 2;
      });

      // Section 4: Commercial Summary & Contract Value
      ensureSpace(95);
      section('4. COMMERCIAL SUMMARY & TOTAL CONTRACT VALUE');
      const sumY = doc.y;

      // Breakdown Lines (Right aligned)
      doc.font('Helvetica').fontSize(9).fillColor('#475569')
        .text(`Subtotal Amount: ${this.money(quote.subtotal)}`, 295, sumY, { width: 250, align: 'right' });
      if (Number(quote.discountAmount) > 0) {
        doc.text(`Discount Applied: -${this.money(quote.discountAmount)}`, 295, sumY + 14, { width: 250, align: 'right' });
      }
      if (Number(quote.taxAmount) > 0) {
        doc.text(`Estimated Tax: ${this.money(quote.taxAmount)}`, 295, sumY + 28, { width: 250, align: 'right' });
      }

      // Total Card
      const totalCardY = sumY + (Number(quote.discountAmount) > 0 || Number(quote.taxAmount) > 0 ? 44 : 20);
      doc.roundedRect(295, totalCardY, 260, 44, 6).fill('#1D4F6D');
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#BEE3F8').text('TOTAL CONTRACT VALUE', 310, totalCardY + 10);
      doc.font('Helvetica').fontSize(7.5).fillColor('#E2E8F0').text('Inclusive of all listed specifications', 310, totalCardY + 24);
      doc.font('Helvetica-Bold').fontSize(16).fillColor('#FFFFFF').text(this.money(quote.totalAmount), 415, totalCardY + 13, { width: 125, align: 'right' });

      doc.y = totalCardY + 54;

      // Section 5: Execution & Dual Formal Signatures
      ensureSpace(185);
      section('5. EXECUTION & MUTUAL ACCEPTANCE (SIGNATURES)');
      doc.font('Helvetica').fontSize(8).fillColor('#475569').text(
        'IN WITNESS WHEREOF, the Parties hereto have caused this Commercial Quotation & Service Agreement to be duly executed by their authorized representatives as of the date written below. Mutual execution affirms full agreement with the specifications, scope, terms, and total commercial consideration.',
        40,
        doc.y,
        { width: pageWidth, lineGap: 1.5 },
      );
      doc.moveDown(0.7);

      const sigBoxY = doc.y;
      const sigHeight = 138;

      // Box 1: Company / Service Provider Signature Box
      doc.roundedRect(40, sigBoxY, 250, sigHeight, 6).strokeColor('#CBD5E1').lineWidth(1).stroke();
      doc.roundedRect(40, sigBoxY, 250, 22, 5).fill('#F1F5F9');
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#1D4F6D').text('FOR SERVICE PROVIDER (COMPANY)', 48, sigBoxY + 6);
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#0F172A').text(quote.company?.name || 'Company / Service Provider', 48, sigBoxY + 28, { width: 234 });

      // Signature line
      doc.moveTo(48, sigBoxY + 66).lineTo(280, sigBoxY + 66).strokeColor('#94A3B8').lineWidth(0.8).stroke();
      doc.font('Helvetica').fontSize(7.5).fillColor('#64748B').text('Authorized Representative Signature', 48, sigBoxY + 69);

      // Meta lines
      doc.font('Helvetica').fontSize(7.5).fillColor('#334155')
        .text('Printed Name: _________________________________', 48, sigBoxY + 84)
        .text('Title / Designation: ____________________________', 48, sigBoxY + 98)
        .text('Execution Date: ________________________________', 48, sigBoxY + 112);

      // Seal / Stamp placeholder
      doc.font('Helvetica-Bold').fontSize(7).fillColor('#94A3B8').text('[ OFFICIAL COMPANY SEAL / STAMP ]', 48, sigBoxY + 125, { width: 234, align: 'right' });

      // Box 2: Customer / Service Receiver Signature Box
      doc.roundedRect(305, sigBoxY, 250, sigHeight, 6).strokeColor('#CBD5E1').lineWidth(1).stroke();
      doc.roundedRect(305, sigBoxY, 250, 22, 5).fill('#F1F5F9');
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#1D4F6D').text('FOR CUSTOMER / SERVICE RECEIVER', 313, sigBoxY + 6);
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#0F172A').text(quote.clientName, 313, sigBoxY + 28, { width: 234 });

      // Signature line
      doc.moveTo(313, sigBoxY + 66).lineTo(545, sigBoxY + 66).strokeColor('#94A3B8').lineWidth(0.8).stroke();
      doc.font('Helvetica').fontSize(7.5).fillColor('#64748B').text('Customer / Authorized Signatory', 313, sigBoxY + 69);

      // Meta lines
      doc.font('Helvetica').fontSize(7.5).fillColor('#334155')
        .text('Printed Name: _________________________________', 313, sigBoxY + 84)
        .text('Title / Capacity: ______________________________', 313, sigBoxY + 98)
        .text('Acceptance Date: _______________________________', 313, sigBoxY + 112);

      // Acceptance badge
      doc.font('Helvetica-Bold').fontSize(7).fillColor('#16A34A').text('[ ACCEPTED & CONFIRMED ]', 313, sigBoxY + 125, { width: 234, align: 'right' });

      doc.y = sigBoxY + sigHeight + 10;

      // Page numbers on all pages
      const range = doc.bufferedPageRange();
      for (let page = range.start; page < range.start + range.count; page += 1) {
        doc.switchToPage(page);
        doc.font('Helvetica').fontSize(7.5).fillColor('#94A3B8').text(
          `${quote.quoteNumber}  •  Legally Binding Commercial Contract  •  Page ${page + 1} of ${range.count}  •  Confidential`,
          40,
          805,
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

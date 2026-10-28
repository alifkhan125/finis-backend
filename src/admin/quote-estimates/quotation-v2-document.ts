import PDFDocument from 'pdfkit';
import type { QuotationV2Dto } from './dto/quotation-v2.dto';

export function quotationV2Totals(input: QuotationV2Dto) {
  const floors = input.floors || [];
  const servicesList = input.services || [];
  const available = new Set(floors.flatMap(floor => (floor.units || []).map(unit => unit.id)));
  const services = servicesList.map(service => {
    const count = new Set((service.unitIds || []).filter(id => available.has(id))).size;
    const hourly = (Number(service.rate) || 0) * count + (Number(service.hourlyExtra) || 0);
    return { ...service, count, hourly, total: Math.round((hourly * (Number(service.hours) || 1) + (Number(service.oneTime) || 0)) * 100) / 100 };
  });
  return { services, total: services.reduce((sum, service) => sum + service.total, 0) };
}

export async function buildQuotationV2Pdf(input: QuotationV2Dto): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', chunk => chunks.push(Buffer.from(chunk)));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const pageWidth = 515;
  const money = (value: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);

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
  doc.font('Helvetica').fontSize(9.5).fillColor('#DCEAF2').text(input.company || 'Service Provider', 54, 100, { width: 300 });
  doc.font('Helvetica').fontSize(8).fillColor('#A3C8DE').text('Binding commercial contract upon mutual execution', 54, 115, { width: 300 });

  // Header Meta (Right)
  const todayStr = new Date().toLocaleDateString('en-CA');
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#FFFFFF').text('Ref: QUOTE-V2-DOCUMENT', 320, 56, { width: 220, align: 'right' });
  doc.font('Helvetica').fontSize(8.5).fillColor('#DCEAF2').text(`Issued: ${todayStr}`, 320, 74, { width: 220, align: 'right' });
  doc.roundedRect(440, 94, 100, 18, 4).fill('#246387');
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#FFFFFF').text('ISSUED', 440, 99, { width: 100, align: 'center' });

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
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#0F172A').text(input.company || 'Finis Contractor', 48, partiesY + 26, { width: 234 });
  doc.font('Helvetica').fontSize(8).fillColor('#475569')
    .text('Representative: Authorized Company Signatory', 48, partiesY + 42, { width: 234 })
    .text(`Email: Contact Office`, 48, partiesY + 56, { width: 234 })
    .text('Role: Prime Contractor & Service Provider', 48, partiesY + 70, { width: 234 });

  // Party B: Customer / Service Receiver Box
  doc.roundedRect(305, partiesY, 250, boxHeight, 6).fillAndStroke('#FFFFFF', '#E2E8F0');
  doc.roundedRect(305, partiesY, 250, 20, 5).fill('#F1F5F9');
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#1D4F6D').text('PARTY B: CUSTOMER / SERVICE RECEIVER', 313, partiesY + 6);
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#0F172A').text(input.client || 'Client', 313, partiesY + 26, { width: 234 });
  doc.font('Helvetica').fontSize(8).fillColor('#475569')
    .text(`Phone: ${input.phone || 'N/A'}`, 313, partiesY + 42, { width: 234 })
    .text(`Email: ${input.email || 'N/A'}`, 313, partiesY + 56, { width: 234 })
    .text(`Address: ${input.address || 'N/A'}`, 313, partiesY + 70, { width: 234 });

  doc.y = partiesY + boxHeight + 8;

  // Project Specs Bar
  doc.roundedRect(40, doc.y, pageWidth, 42, 5).fillAndStroke('#F8FAFC', '#E2E8F0');
  const specsY = doc.y;
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#1D4F6D').text('Project Name:', 48, specsY + 7);
  doc.font('Helvetica').fontSize(8.5).fillColor('#0F172A').text(` ${input.project || 'Untitled Project'}`, 115, specsY + 7, { width: 390 });
  const classification = [input.projectType, input.propertyType, input.buildingType].filter(Boolean).join(' • ') || 'General Construction';
  const scheduleStr = `${input.start || 'TBD'} to ${input.end || 'TBD'}`;
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#475569').text('Classification:', 48, specsY + 23);
  doc.font('Helvetica').fontSize(8).fillColor('#0F172A').text(` ${classification}`, 115, specsY + 23);
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#475569').text('Schedule:', 320, specsY + 23);
  doc.font('Helvetica').fontSize(8).fillColor('#0F172A').text(` ${scheduleStr}`, 375, specsY + 23);

  doc.y = specsY + 50;

  // Section 2: Quotation Details & Terms
  const details = input.details || [];
  section('2. QUOTATION DETAILS & CONTRACT TERMS');
  if (details.length) {
    const headingSizes: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 14, 2: 12, 3: 11, 4: 10, 5: 9.5 };
    for (const block of details) {
      ensureSpace(30);
      const headingLevel = ([1, 2, 3, 4, 5].includes(Number(block.headingLevel))
        ? Number(block.headingLevel)
        : 2) as 1 | 2 | 3 | 4 | 5;
      const runs = (block.runs || []).filter(run => run.text);
      if (!runs.length) continue;

      if (block.heading) {
        const headingText = runs.map(r => r.text).join('');
        doc.font('Helvetica-Bold').fontSize(headingSizes[headingLevel]).fillColor('#1D4F6D').text(headingText, { width: pageWidth });
        doc.moveDown(0.2);
      } else {
        const prefix = block.bullet ? '• ' : '';
        doc.font('Helvetica').fontSize(9).fillColor('#334155');
        runs.forEach((run, index) => {
          const fontName = run.bold ? (run.italic ? 'Helvetica-BoldOblique' : 'Helvetica-Bold') : (run.italic ? 'Helvetica-Oblique' : 'Helvetica');
          doc.font(fontName)
            .fontSize(run.fontSize || 9)
            .text(`${index === 0 ? prefix : ''}${run.text}`, {
              continued: index < runs.length - 1,
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

  // Work Areas
  const floors = input.floors || [];
  if (floors.length) {
    section('3. SELECTED WORK AREAS', 'Specified architectural breakdown and unit allocations.');
    for (const floor of floors) {
      ensureSpace(22);
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#0F172A').text(floor.label, { continued: true });
      doc.font('Helvetica').fontSize(8).fillColor('#475569').text(`: ${(floor.units || []).map(u => u.label).join(', ') || 'No units selected'}`, { width: pageWidth });
      doc.moveDown(0.2);
    }
  }

  // Services & Pricing Table
  section(floors.length ? '4. SCOPE OF SERVICES & ITEMIZED PRICING' : '3. SCOPE OF SERVICES & ITEMIZED PRICING', 'Only items and quantities explicitly enumerated below are included in this contract.');
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

  const totals = quotationV2Totals(input);
  totals.services.forEach((service, index) => {
    const hasDesc = Boolean(service.description);
    const rowHeight = hasDesc ? 44 : 26;
    ensureSpace(rowHeight + 6);
    const rowY = doc.y;

    if (index % 2 === 1) {
      doc.roundedRect(40, rowY, pageWidth, rowHeight, 2).fill('#F8FAFC');
    }

    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#0F172A').text(`${index + 1}`, 46, rowY + 6, { width: 20 });
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#0F172A').text(service.title || 'Untitled service', 72, rowY + 6, { width: 228 });
    doc.font('Helvetica').fontSize(8).fillColor('#475569').text(`${service.count} units`, 305, rowY + 6, { width: 65, align: 'right' });
    doc.font('Helvetica').fontSize(8).fillColor('#475569').text(money(service.rate), 375, rowY + 6, { width: 65, align: 'right' });
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#1D4F6D').text(money(service.total), 445, rowY + 6, { width: 95, align: 'right' });

    if (hasDesc) {
      doc.font('Helvetica').fontSize(7.5).fillColor('#64748B').text(service.description, 72, rowY + 20, { width: 360, ellipsis: true });
    }

    doc.moveTo(40, rowY + rowHeight).lineTo(40 + pageWidth, rowY + rowHeight).strokeColor('#E2E8F0').lineWidth(0.5).stroke();
    doc.y = rowY + rowHeight + 2;
  });

  // Total Card
  ensureSpace(95);
  section(floors.length ? '5. COMMERCIAL SUMMARY & TOTAL CONTRACT VALUE' : '4. COMMERCIAL SUMMARY & TOTAL CONTRACT VALUE');
  const totalCardY = doc.y;
  doc.roundedRect(295, totalCardY, 260, 44, 6).fill('#1D4F6D');
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#BEE3F8').text('TOTAL CONTRACT VALUE', 310, totalCardY + 10);
  doc.font('Helvetica').fontSize(7.5).fillColor('#E2E8F0').text('Inclusive of all listed specifications', 310, totalCardY + 24);
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#FFFFFF').text(money(totals.total), 415, totalCardY + 13, { width: 125, align: 'right' });
  doc.y = totalCardY + 54;

  // Execution & Dual Signatures
  ensureSpace(185);
  section(floors.length ? '6. EXECUTION & MUTUAL ACCEPTANCE (SIGNATURES)' : '5. EXECUTION & MUTUAL ACCEPTANCE (SIGNATURES)');
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
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#0F172A').text(input.company || 'Service Provider', 48, sigBoxY + 28, { width: 234 });

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
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#0F172A').text(input.client || 'Customer', 313, sigBoxY + 28, { width: 234 });

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
  for (let index = range.start; index < range.start + range.count; index++) {
    doc.switchToPage(index);
    doc.font('Helvetica').fontSize(7.5).fillColor('#94a3b8').text(`Finis  •  Legally Binding Commercial Contract  •  Page ${index + 1} of ${range.count}  •  Confidential`, 40, 805, { width: pageWidth, align: 'center', lineBreak: false });
  }

  doc.end();
  return result;
}

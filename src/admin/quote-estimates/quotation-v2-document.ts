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
  const doc = new PDFDocument({ size: 'A4', margin: 44, bufferPages: true });
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', chunk => chunks.push(Buffer.from(chunk)));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const money = (value: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
  const section = (title: string) => {
    if (doc.y > 690) doc.addPage();
    doc.moveDown().font('Helvetica-Bold').fontSize(13).fillColor('#1d4f6d').text(title).moveDown(0.5);
    doc.font('Helvetica').fontSize(10).fillColor('#334155');
  };
  doc.font('Helvetica-Bold').fontSize(24).fillColor('#1d4f6d').text('QUOTATION');
  doc.moveDown(0.5).fontSize(17).text(input.project || 'Untitled project');
  doc.font('Helvetica').fontSize(11).text(input.company || '');
  section('Client & project');
  for (const [label, value] of Object.entries({ Client: input.client, Email: input.email, Phone: input.phone, Address: input.address, 'Project type': input.projectType, Property: input.propertyType, Building: input.buildingType, 'Start date': input.start, 'End date': input.end })) {
    if (value) doc.text(`${label}: ${value}`, { width: 507 });
  }
  const details = input.details || [];
  if (details.length) {
    section('Quotation details');
    const headingSizes: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 18, 2: 16, 3: 14, 4: 12, 5: 11 };
    for (const block of details) {
      if (doc.y > 700) doc.addPage();
      const headingLevel = ([1, 2, 3, 4, 5].includes(Number(block.headingLevel))
        ? Number(block.headingLevel)
        : 2) as 1 | 2 | 3 | 4 | 5;
      const blockFontSize = block.heading ? headingSizes[headingLevel] : 10;
      doc.fontSize(blockFontSize);
      if (block.bullet) doc.font('Helvetica').text('- ', { continued: true });
      const runs = (block.runs || []).filter(run => run.text);
      runs.forEach((run, index) => {
        doc.font(run.bold || block.heading ? (run.italic ? 'Helvetica-BoldOblique' : 'Helvetica-Bold') : (run.italic ? 'Helvetica-Oblique' : 'Helvetica'))
          .fontSize(run.fontSize || blockFontSize)
          .text(run.text, { continued: index < runs.length - 1, underline: Boolean(run.underline), width: 507 });
      });
      if (!runs.length) doc.text(' ');
      doc.moveDown(0.4);
    }
  }
  section('Selected work areas');
  const floors = input.floors || [];
  for (const floor of floors) {
    doc.font('Helvetica-Bold').text(floor.label);
    doc.font('Helvetica').text((floor.units || []).map(unit => unit.label).join(', ') || 'No units', { width: 507 }).moveDown(0.5);
  }
  if (!floors.length) doc.text('No work areas selected.');
  section('Services & pricing');
  const totals = quotationV2Totals(input);
  for (const service of totals.services) {
    if (doc.y > 670) doc.addPage();
    doc.font('Helvetica-Bold').text(service.title || 'Untitled service');
    doc.font('Helvetica');
    if (service.description) doc.text(service.description, { width: 507 });
    doc.text(`${money(service.rate)} per unit | ${service.count} units | ${money(service.total)}`);
    for (const floor of input.floors) {
      const units = floor.units.filter(unit => service.unitIds.includes(unit.id));
      if (units.length) doc.fontSize(9).text(`${floor.label}: ${units.map(unit => unit.label).join(', ')}`, { width: 507 });
    }
    doc.fontSize(10).moveDown();
  }
  if (!totals.services.length) doc.text('No services assigned.');
  section(`Quotation total: ${money(totals.total)} USD`);
  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index++) {
    doc.switchToPage(index);
    doc.font('Helvetica').fontSize(8).fillColor('#94a3b8').text(`Finis | Page ${index + 1} of ${range.count}`, 44, 800, { lineBreak: false });
  }
  doc.end();
  return result;
}

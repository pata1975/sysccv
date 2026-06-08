const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const PDFDocument = require('pdfkit');

let QRCode = null;
try {
  QRCode = require('qrcode');
} catch (_) {
  QRCode = null;
}

const INVOICES_DIR = process.env.INVOICE_PDF_DIR
  ? path.resolve(process.env.INVOICE_PDF_DIR)
  : path.join(__dirname, '..', 'data', 'invoices');

const PAGE = {
  width: 595.28,
  height: 841.89,
  margin: 28
};

function cleanText(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function onlyDigits(value) {
  return cleanText(value).replace(/\D+/g, '');
}

function padNumber(value, length) {
  const digits = onlyDigits(value);
  return digits ? digits.padStart(length, '0') : ''.padStart(length, '0');
}

function formatDisplayDate(value) {
  if (!value) return '';

  const raw = String(value);

  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(6, 8)}/${raw.slice(4, 6)}/${raw.slice(0, 4)}`;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return `${raw.slice(8, 10)}/${raw.slice(5, 7)}/${raw.slice(0, 4)}`;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return raw;
  }

  return date.toLocaleDateString('es-AR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: process.env.TZ || 'America/Argentina/Buenos_Aires'
  });
}

function formatQrDate(value) {
  if (!value) return new Date().toISOString().slice(0, 10);

  const raw = String(value);

  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function formatMoney(value) {
  return toNumber(value).toLocaleString('es-AR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function getBuyerDocCode(order) {
  const type = cleanText(order?.buyerDocumentType).toUpperCase();
  const number = onlyDigits(order?.buyerDocumentNumber);

  if (!number) return null;
  if (type.includes('CUIT')) return 80;
  if (type.includes('CUIL')) return 86;
  if (type.includes('DNI') || type.includes('DOCUMENTO')) return 96;

  return 99;
}

function drawText(doc, text, x, y, options = {}) {
  doc.text(cleanText(text), x, y, options);
}

function labelValue(doc, label, value, x, y, valueX, options = {}) {
  doc.font('Helvetica-Bold').fontSize(options.fontSize || 8.5).text(label, x, y, {
    width: valueX - x - 4,
    continued: false
  });
  doc.font('Helvetica').fontSize(options.fontSize || 8.5).text(cleanText(value), valueX, y, {
    width: options.width || 200,
    align: options.align || 'left'
  });
}

function drawBox(doc, x, y, width, height, fillColor = null) {
  if (fillColor) {
    doc.rect(x, y, width, height).fillAndStroke(fillColor, 'black');
    doc.fillColor('black');
  } else {
    doc.rect(x, y, width, height).stroke();
  }
}

function drawCentered(doc, text, x, y, width, options = {}) {
  doc.font(options.font || 'Helvetica-Bold')
    .fontSize(options.fontSize || 10)
    .text(cleanText(text), x, y, {
      width,
      align: 'center'
    });
}

function buildAddressLine(address) {
  if (!address) return '';

  return [
    address.streetName,
    address.streetNumber,
    address.city,
    address.stateName,
    address.zipCode
  ]
    .map((part) => cleanText(part))
    .filter(Boolean)
    .join(', ');
}

function getBusinessConfig() {
  return {
    displayName: cleanText(process.env.BUSINESS_NAME, 'CORRECONVENTAJA'),
    legalName: cleanText(
      process.env.BUSINESS_LEGAL_NAME,
      cleanText(process.env.BUSINESS_NAME, 'CORRECONVENTAJA')
    ),
    address: cleanText(process.env.BUSINESS_ADDRESS, ''),
    taxCondition: cleanText(process.env.BUSINESS_TAX_CONDITION, 'Responsable Monotributo'),
    grossIncome: cleanText(process.env.BUSINESS_GROSS_INCOME, process.env.ARCA_CUIT || ''),
    activityStartDate: cleanText(process.env.BUSINESS_ACTIVITY_START_DATE, ''),
    cuit: onlyDigits(process.env.ARCA_CUIT)
  };
}

function getInvoiceTypeCode(invoice) {
  return Number(invoice?.invoiceTypeCode || process.env.ARCA_INVOICE_TYPE || 11);
}

function buildArcaQrUrl({ invoice, order }) {
  if (!invoice?.cae || invoice.environment !== 'production') {
    return null;
  }

  const cuit = Number(onlyDigits(process.env.ARCA_CUIT));
  const ptoVta = Number(onlyDigits(invoice.pointOfSale));
  const tipoCmp = getInvoiceTypeCode(invoice);
  const nroCmp = Number(onlyDigits(invoice.invoiceNumber));
  const importe = Number(toNumber(invoice.total || order?.total).toFixed(2));
  const tipoDocRec = getBuyerDocCode(order);
  const nroDocRec = Number(onlyDigits(order?.buyerDocumentNumber));
  const codAut = Number(onlyDigits(invoice.cae));

  if (!cuit || !ptoVta || !tipoCmp || !nroCmp || !codAut) {
    return null;
  }

  const payload = {
    ver: 1,
    fecha: formatQrDate(invoice.issuedAt),
    cuit,
    ptoVta,
    tipoCmp,
    nroCmp,
    importe,
    moneda: invoice.currency === 'USD' ? 'DOL' : 'PES',
    ctz: 1,
    tipoCodAut: 'E',
    codAut
  };

  if (tipoDocRec && nroDocRec) {
    payload.tipoDocRec = tipoDocRec;
    payload.nroDocRec = nroDocRec;
  }

  const base64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return `https://www.afip.gob.ar/fe/qr/?p=${encodeURIComponent(base64)}`;
}

async function buildQrBuffer({ invoice, order }) {
  if (!QRCode) return null;

  const qrUrl = buildArcaQrUrl({ invoice, order });
  if (!qrUrl) return null;

  const dataUrl = await QRCode.toDataURL(qrUrl, {
    errorCorrectionLevel: 'M',
    margin: 0,
    width: 180
  });

  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

function drawHeader(doc, { invoice, business }) {
  const x = PAGE.margin;
  const y = 28;
  const w = PAGE.width - PAGE.margin * 2;
  const h = 148;

  const leftW = 250;
  const centerW = 50;
  const rightW = w - leftW - centerW;

  const centerX = x + leftW;
  const rightStartX = x + leftW + centerW;

  drawCentered(doc, 'ORIGINAL', x, y - 20, w, { fontSize: 15 });

  drawBox(doc, x, y, w, h);

  // Separador entre bloque izquierdo/C y bloque derecho.
  doc.moveTo(rightStartX, y).lineTo(rightStartX, y + h).stroke();

  // Caja de la letra C solamente arriba. No dibujamos rectángulo vacío debajo.
  drawBox(doc, centerX, y, centerW, 50);
  drawCentered(doc, 'C', centerX, y + 7, centerW, { fontSize: 28 });
  drawCentered(doc, 'COD. 011', centerX, y + 35, centerW, { fontSize: 7.5 });

  drawCentered(doc, business.displayName, x + 10, y + 26, leftW - 20, {
    fontSize: 11
  });

  labelValue(doc, 'Razon Social:', business.legalName, x + 10, y + 72, x + 78, {
    width: leftW + centerW - 88
  });

  labelValue(doc, 'Domicilio Comercial:', business.address, x + 10, y + 100, x + 106, {
    width: leftW + centerW - 116
  });

  labelValue(doc, 'Condición frente al IVA:', business.taxCondition, x + 10, y + 128, x + 122, {
    width: leftW + centerW - 132
  });

  doc.font('Helvetica-Bold').fontSize(20).text('FACTURA', rightStartX + 12, y + 18, {
    width: rightW - 24,
    align: 'center'
  });

  const rightX = rightStartX + 12;

  labelValue(doc, 'Punto de Venta:', padNumber(invoice.pointOfSale, 5), rightX, y + 62, rightX + 72, {
    width: 42,
    fontSize: 8
  });

  labelValue(doc, 'Comp. Nro:', padNumber(invoice.invoiceNumber, 8), rightX + 122, y + 62, rightX + 178, {
    width: 50,
    fontSize: 8
  });

  labelValue(doc, 'Fecha de Emision:', formatDisplayDate(invoice.issuedAt), rightX, y + 84, rightX + 92, {
    width: 120,
    fontSize: 8
  });

  labelValue(doc, 'CUIT:', business.cuit, rightX, y + 108, rightX + 32, {
    width: 120,
    fontSize: 8
  });

  labelValue(doc, 'Ingresos Brutos:', business.grossIncome, rightX, y + 124, rightX + 84, {
    width: 120,
    fontSize: 8
  });

  labelValue(doc, 'Fecha de Inicio de Actividades:', business.activityStartDate, rightX, y + 140, rightX + 144, {
    width: 85,
    fontSize: 8
  });
}

function drawBuyerBox(doc, { order }) {
  const x = PAGE.margin;
  const y = 186;
  const w = PAGE.width - PAGE.margin * 2;
  const h = 76;
  drawBox(doc, x, y, w, h);

  const docType = cleanText(order.buyerDocumentType, 'DNI');
  const docNumber = cleanText(order.buyerDocumentNumber, '');
  doc.font('Helvetica-Bold').fontSize(8.5).text(`${docType}:`, x + 8, y + 9, { continued: true });
  doc.font('Helvetica').text(` ${docNumber}`);

  labelValue(doc, 'Apellido y Nombre / Razon Social:', order.buyerName || 'Consumidor Final', x + 205, y + 9, x + 370, { width: 170 });
  labelValue(doc, 'Condicion frente al IVA:', order.buyerTaxpayerType || 'Consumidor Final', x + 8, y + 34, x + 120, { width: 190 });
  labelValue(doc, 'Domicilio:', buildAddressLine(order.buyerAddress), x + 315, y + 34, x + 370, { width: 170 });
  labelValue(doc, 'Condicion de venta:', process.env.INVOICE_SALES_CONDITION || 'Otros medios de pago electrónico', x + 8, y + 56, x + 110, { width: 250 });
}

function drawItemsTable(doc, { order }) {
  const x = PAGE.margin;
  const y = 265;
  const w = PAGE.width - PAGE.margin * 2;
  const headerH = 20;

  const baseColumns = [
    { key: 'code', label: 'Codigo', width: 38, align: 'center' },
    { key: 'title', label: 'Producto / Servicio', width: 160, align: 'left' },
    { key: 'quantity', label: 'Cantidad', width: 50, align: 'right' },
    { key: 'unit', label: 'U. Medida', width: 45, align: 'center' },
    { key: 'unitPrice', label: 'Precio Unit.', width: 70, align: 'right' },
    { key: 'discountPercent', label: '% Bonif', width: 38, align: 'right' },
    { key: 'discountAmount', label: 'Imp. Bonif.', width: 50, align: 'right' },
    { key: 'subtotal', label: 'Subtotal', width: w - 451, align: 'right' }
  ];

  let currentX = x;

  const columns = baseColumns.map((col) => {
    const column = {
      ...col,
      x: currentX
    };

    currentX += col.width;

    return column;
  });

  drawBox(doc, x, y, w, headerH, '#d9d9d9');

  columns.forEach((col) => {
    doc.moveTo(col.x, y).lineTo(col.x, y + headerH).stroke();

    doc
      .font('Helvetica-Bold')
      .fontSize(7)
      .text(col.label, col.x + 3, y + 6, {
        width: col.width - 6,
        align: col.align
      });
  });

  doc.moveTo(x + w, y).lineTo(x + w, y + headerH).stroke();

  const items = Array.isArray(order.items) && order.items.length
    ? order.items
    : [{ quantity: 1, title: 'Producto / Servicio', unitPrice: order.total || 0 }];

  let rowY = y + headerH + 8;

  items.forEach((item) => {
    const quantity = toNumber(item.quantity, 1);
    const unitPrice = toNumber(item.unitPrice || item.price, 0);
    const subtotal = quantity * unitPrice;
    const title = cleanText(item.title || item.description || 'Producto / Servicio');

    doc.font('Helvetica').fontSize(8);

    columns.forEach((col) => {
      let value = '';

      if (col.key === 'code') value = '';
      if (col.key === 'title') value = title;
      if (col.key === 'quantity') value = formatMoney(quantity);
      if (col.key === 'unit') value = 'unidades';
      if (col.key === 'unitPrice') value = formatMoney(unitPrice);
      if (col.key === 'discountPercent') value = '0,00';
      if (col.key === 'discountAmount') value = '0,00';
      if (col.key === 'subtotal') value = formatMoney(subtotal);

      doc.text(value, col.x + 3, rowY, {
        width: col.width - 6,
        height: col.key === 'title' ? 34 : undefined,
        align: col.align,
        ellipsis: col.key === 'title'
      });
    });

    rowY += 38;
  });

  return rowY;
}

function drawTotalsBox(doc, { total }) {
  const x = PAGE.margin;
  const y = 585;
  const w = PAGE.width - PAGE.margin * 2;
  const h = 112;
  drawBox(doc, x, y, w, h);

  const labelX = x + 355;
  const valueX = x + 468;

  doc.font('Helvetica-Bold').fontSize(9);
  doc.text('Subtotal: $', labelX, y + 42, { width: 105, align: 'right' });
  doc.text(formatMoney(total), valueX, y + 42, { width: 70, align: 'right' });
  doc.text('Importe Otros Tributos: $', labelX, y + 64, { width: 105, align: 'right' });
  doc.text(formatMoney(0), valueX, y + 64, { width: 70, align: 'right' });
  doc.text('Importe Total: $', labelX, y + 86, { width: 105, align: 'right' });
  doc.text(formatMoney(total), valueX, y + 86, { width: 70, align: 'right' });
}

function drawFooter(doc, { invoice, qrBuffer }) {
  const x = PAGE.margin;
  const y = 724;
  const qrSize = 72;

  if (qrBuffer) {
    doc.image(qrBuffer, x + 8, y + 4, { width: qrSize, height: qrSize });
  } else {
    drawBox(doc, x + 8, y + 4, qrSize, qrSize);
    doc.font('Helvetica-Bold').fontSize(7).text('QR ARCA', x + 8, y + 34, {
      width: qrSize,
      align: 'center'
    });
  }

  doc.font('Helvetica-Bold').fontSize(18).fillColor('#666666').text('ARCA', x + 95, y + 8);
  doc.fillColor('black').font('Helvetica').fontSize(5.8).text('AGENCIA DE RECAUDACIÃ“N\nY CONTROL ADUANERO', x + 96, y + 32, {
    width: 100
  });

  doc.font('Helvetica-Bold').fontSize(8.5).text('Comprobante Autorizado', x + 95, y + 59);
  doc.font('Helvetica-Oblique').fontSize(6.2).text(
    'Esta Agencia no se responsabiliza por los datos ingresados en el detalle de la operaciÃ³n',
    x + 95,
    y + 78,
    { width: 250 }
  );

  doc.font('Helvetica-Bold').fontSize(9).text('PÃ¡g. 1/1', x + 250, y + 18, {
    width: 80,
    align: 'center'
  });

  labelValue(doc, 'CAE NÂ°:', invoice.cae || '', x + 395, y + 18, x + 448, { width: 95, align: 'left', fontSize: 9 });
  labelValue(doc, 'Fecha de Vto. de CAE:', formatDisplayDate(invoice.caeDueDate), x + 332, y + 42, x + 448, { width: 95, align: 'left', fontSize: 9 });
}

async function createInvoicePdfMock({ job, order, invoice }) {
  await fsPromises.mkdir(INVOICES_DIR, { recursive: true });

  const safeTimestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-');

  const fileName = `factura-${invoice.environment || 'mock'}-${job.id}-${safeTimestamp}.pdf`;
  const filePath = path.join(INVOICES_DIR, fileName);
  const business = getBusinessConfig();
  const total = toNumber(invoice.total || order.total);
  const qrBuffer = await buildQrBuffer({ invoice, order });

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: PAGE.margin,
      bufferPages: false,
      info: {
        Title: `Factura C ${padNumber(invoice.pointOfSale, 4)}-${padNumber(invoice.invoiceNumber, 8)}`,
        Author: business.displayName,
        Subject: 'Factura electrÃ³nica'
      }
    });

    const stream = fs.createWriteStream(filePath);

    stream.on('finish', () => {
      resolve({ fileName, filePath });
    });

    stream.on('error', reject);
    doc.on('error', reject);

    doc.pipe(stream);
    doc.lineWidth(0.75).fillColor('black');

    drawHeader(doc, { invoice, business });
    drawBuyerBox(doc, { order });
    drawItemsTable(doc, { order });
    drawTotalsBox(doc, { total });
    drawFooter(doc, { invoice, qrBuffer });

    if (invoice.environment === 'testing' || invoice.environment === 'mock') {
      doc.save();
      doc.rotate(-28, { origin: [PAGE.width / 2, PAGE.height / 2] });
      doc.font('Helvetica-Bold')
        .fontSize(32)
        .fillColor('#cccccc')
        .opacity(0.35)
        .text('DOCUMENTO DE PRUEBA', 60, 390, { width: 480, align: 'center' });
      doc.restore();
      doc.opacity(1).fillColor('black');
    }

    doc.end();
  });
}

module.exports = {
  createInvoicePdfMock,
  formatDisplayDate,
  formatMoney,
  buildArcaQrUrl
};

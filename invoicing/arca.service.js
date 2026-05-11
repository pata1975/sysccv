const arcaWsfeService = require('./arcaWsfe.service');

function padNumber(value, length) {
  return String(value).padStart(length, '0');
}

function formatArcaDateForPdf(value) {
  if (!value) {
    return null;
  }

  const raw = String(value);

  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }

  return raw;
}

function shouldUseRealArca() {
  return process.env.ARCA_USE_REAL === 'true';
}

async function createInvoiceMock({ job, order, fiscalInvoice }) {
  const now = new Date();

  const pointOfSale =
    fiscalInvoice?.comprobante?.puntoVenta ||
    Number(process.env.ARCA_POINT_OF_SALE || 1);

  const invoiceType =
    fiscalInvoice?.comprobante?.tipo ||
    Number(process.env.ARCA_INVOICE_TYPE || 11);

  return {
    environment: 'mock',
    invoiceType: invoiceType === 11 ? 'C' : String(invoiceType),
    invoiceTypeCode: invoiceType,
    pointOfSale: padNumber(pointOfSale, 4),
    invoiceNumber: padNumber(Date.now().toString().slice(-8), 8),
    cae: '00000000000000',
    caeDueDate: new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10),
    issuedAt: now.toISOString(),
    currency: fiscalInvoice?.comprobante?.moneda || order.currency || 'ARS',
    total: fiscalInvoice?.importes?.total || order.total,
    relatedJobId: job.id,
    fiscalInvoice
  };
}

async function createInvoiceReal({ job, order, fiscalInvoice }) {
  const arcaResult = await arcaWsfeService.feCaeSolicitar(fiscalInvoice);

  const invoiceType = Number(arcaResult.invoiceType);
  const pointOfSale = Number(arcaResult.pointOfSale);

  return {
    environment: process.env.ARCA_ENV || 'testing',
    invoiceType: invoiceType === 11 ? 'C' : String(invoiceType),
    invoiceTypeCode: invoiceType,
    pointOfSale: padNumber(pointOfSale, 4),
    invoiceNumber: padNumber(arcaResult.invoiceNumber, 8),
    cae: arcaResult.cae,
    caeDueDate: formatArcaDateForPdf(arcaResult.caeDueDate),
    issuedAt: new Date().toISOString(),
    currency: fiscalInvoice?.comprobante?.moneda || order.currency || 'ARS',
    total: fiscalInvoice?.importes?.total || order.total,
    relatedJobId: job.id,
    fiscalInvoice,
    arcaResult: arcaResult.result
  };
}

async function createInvoice({ job, order, fiscalInvoice }) {
  if (shouldUseRealArca()) {
    return createInvoiceReal({
      job,
      order,
      fiscalInvoice
    });
  }

  return createInvoiceMock({
    job,
    order,
    fiscalInvoice
  });
}

module.exports = {
  createInvoice,
  createInvoiceMock,
  createInvoiceReal
};
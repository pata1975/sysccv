function padNumber(value, length) {
  return String(value).padStart(length, '0');
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

module.exports = {
  createInvoiceMock
};
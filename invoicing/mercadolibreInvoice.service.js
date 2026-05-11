const mlibreService = require('../services/mlibre');
const arcaService = require('./arca.service');
const pdfService = require('./pdf.service');
const invoiceFiscalService = require('./invoiceFiscal.service');

async function getMercadoLibreOrder(job) {
  if (!job.orderId) {
    throw new Error(`El job ${job.id} no tiene orderId`);
  }

  return mlibreService.getOrderForInvoice(job.orderId);
}

async function processInvoiceJob(job) {
  if (job.source !== 'mercadolibre') {
    throw new Error(`Unsupported invoice source: ${job.source}`);
  }

  const order = await getMercadoLibreOrder(job);
  const fiscalInvoice = invoiceFiscalService.buildArcaInvoiceRequestFromOrder(order);
  
  const invoice = await arcaService.createInvoice({
    job,
    order,
    fiscalInvoice
  });

  const pdf = await pdfService.createInvoicePdfMock({
    job,
    order,
    invoice
  });

  return {
    orderId: order.orderId,
    packId: order.packId,
    status: order.status,
    buyerName: order.buyerName,
    total: order.total,
    currency: order.currency,
    invoiceType: invoice.invoiceType,
    pointOfSale: invoice.pointOfSale,
    invoiceNumber: invoice.invoiceNumber,
    cae: invoice.cae,
    caeDueDate: invoice.caeDueDate,
    pdfFileName: pdf.fileName,
    pdfFilePath: pdf.filePath,
    fiscalInvoice
  };
}

module.exports = {
  processInvoiceJob
};
const arcaService = require('./arca.service');
const pdfService = require('./pdf.service');

async function getMercadoLibreOrderMock(job) {
  return {
    orderId: job.orderId,
    buyerName: 'Comprador de prueba',
    buyerDocumentType: 'DNI',
    buyerDocumentNumber: '00000000',
    total: 12345,
    items: [
      {
        title: 'Producto de prueba MercadoLibre',
        quantity: 1,
        unitPrice: 12345
      }
    ]
  };
}

async function processInvoiceJob(job) {
  if (job.source !== 'mercadolibre') {
    throw new Error(`Unsupported invoice source: ${job.source}`);
  }

  const order = await getMercadoLibreOrderMock(job);

  const invoice = await arcaService.createInvoiceMock({
    job,
    order
  });

  const pdf = await pdfService.createInvoicePdfMock({
    job,
    order,
    invoice
  });

  return {
    orderId: order.orderId,
    invoiceType: invoice.invoiceType,
    pointOfSale: invoice.pointOfSale,
    invoiceNumber: invoice.invoiceNumber,
    cae: invoice.cae,
    caeDueDate: invoice.caeDueDate,
    pdfFileName: pdf.fileName,
    pdfFilePath: pdf.filePath
  };
}

module.exports = {
  processInvoiceJob
};
const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const PDFDocument = require('pdfkit');

const INVOICES_DIR = path.join(__dirname, '..', 'data', 'invoices');

async function createInvoicePdfMock({ job, order, invoice }) {
  await fsPromises.mkdir(INVOICES_DIR, { recursive: true });

const safeTimestamp = new Date()
  .toISOString()
  .replace(/[:.]/g, '-');

const fileName = `factura-mock-${job.id}-${safeTimestamp}.pdf`;
const filePath = path.join(INVOICES_DIR, fileName);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const stream = fs.createWriteStream(filePath);

    stream.on('finish', () => {
      resolve({
        fileName,
        filePath
      });
    });

    stream.on('error', reject);

    doc.pipe(stream);

    doc.fontSize(18).text('Factura C', { align: 'center' });
    doc.moveDown();

    doc.fontSize(10).text('Documento de prueba. No válido como factura real.', {
      align: 'center'
    });

    doc.moveDown(2);

    doc.fontSize(12).text(`Punto de venta: ${invoice.pointOfSale}`);
    doc.text(`Comprobante: ${invoice.invoiceNumber}`);
    doc.text(`Fecha de emisión: ${invoice.issuedAt}`);
    doc.text(`CAE mock: ${invoice.cae}`);
    doc.text(`Vencimiento CAE: ${invoice.caeDueDate}`);

    doc.moveDown();

    doc.fontSize(12).text('Vendedor');
    doc.fontSize(10).text('Corre con Ventaja');
    doc.text('CUIT: pendiente de configurar');

    doc.moveDown();

    doc.fontSize(12).text('Comprador');
doc.fontSize(10).text(order.buyerName || 'Consumidor final');

if (order.buyerDocumentType || order.buyerDocumentNumber) {
  doc.text(
    `${order.buyerDocumentType || 'Documento'}: ${order.buyerDocumentNumber || ''}`
  );
}

if (order.buyerTaxpayerType) {
  doc.text(`Condición fiscal: ${order.buyerTaxpayerType}`);
}

if (order.buyerAddress) {
  const addressLine = [
    order.buyerAddress.streetName,
    order.buyerAddress.streetNumber,
    order.buyerAddress.city,
    order.buyerAddress.stateName,
    order.buyerAddress.zipCode
  ]
    .filter(Boolean)
    .join(', ');

  if (addressLine) {
    doc.text(`Domicilio: ${addressLine}`);
  }
}

doc.text(`Order ID MercadoLibre: ${order.orderId || 'sin order id'}`);

    doc.moveDown();

    doc.fontSize(12).text('Detalle');
    doc.moveDown(0.5);

    order.items.forEach((item) => {
      doc.fontSize(10).text(
        `${item.quantity} x ${item.title} - $${item.unitPrice}`
      );
    });

    doc.moveDown();

    doc.fontSize(14).text(`Total: $${order.total}`, { align: 'right' });

    doc.end();
  });
}

module.exports = {
  createInvoicePdfMock
};
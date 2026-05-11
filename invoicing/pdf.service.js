const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const PDFDocument = require('pdfkit');

const INVOICES_DIR = path.join(__dirname, '..', 'data', 'invoices');

function formatDisplayDate(value) {
  if (!value) return '';

  const raw = String(value);

  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(6, 8)}/${raw.slice(4, 6)}/${raw.slice(0, 4)}`;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return raw;
  }

  return date.toLocaleDateString('es-AR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
}

function formatMoney(value) {
  const number = Number(value || 0);

  return number.toLocaleString('es-AR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

async function createInvoicePdfMock({ job, order, invoice }) {
  await fsPromises.mkdir(INVOICES_DIR, { recursive: true });

  const safeTimestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-');

  const fileName = `factura-${invoice.environment || 'mock'}-${job.id}-${safeTimestamp}.pdf`;
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

    const environmentLabel =
      invoice.environment === 'mock'
        ? 'Documento de prueba. No válido como factura real.'
        : invoice.environment === 'testing'
          ? 'Documento emitido en homologación ARCA. No válido como factura real.'
          : '';

    doc.fontSize(18).text('Factura C', { align: 'center' });
    doc.moveDown();

    if (environmentLabel) {
      doc.fontSize(10).text(environmentLabel, { align: 'center' });
      doc.moveDown();
    }

    doc.moveDown();

    doc.fontSize(12).text(`Punto de venta: ${invoice.pointOfSale}`);
    doc.text(`Comprobante: ${invoice.invoiceNumber}`);
    doc.text(`Fecha de emisión: ${formatDisplayDate(invoice.issuedAt)}`);
    doc.text(`CAE: ${invoice.cae || 'pendiente'}`);
    doc.text(`Vencimiento CAE: ${formatDisplayDate(invoice.caeDueDate)}`);

    doc.moveDown();

    doc.fontSize(12).text('Vendedor');
    doc.fontSize(10).text(process.env.BUSINESS_NAME || 'Corre con Ventaja');
    doc.text(`CUIT: ${process.env.ARCA_CUIT || 'pendiente de configurar'}`);

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

    if (order.buyerTaxContributor) {
      doc.text(`Tipo de contribuyente: ${order.buyerTaxContributor}`);
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

    const items = Array.isArray(order.items) ? order.items : [];

    items.forEach((item) => {
      const quantity = Number(item.quantity || 0);
      const unitPrice = Number(item.unitPrice || 0);
      const total = quantity * unitPrice;

      doc.fontSize(10).text(
        `${quantity} x ${item.title || 'Producto sin título'} - $${formatMoney(unitPrice)} - Total: $${formatMoney(total)}`
      );
    });

    doc.moveDown();

    doc.fontSize(14).text(`Total: $${formatMoney(order.total)}`, {
      align: 'right'
    });

    doc.end();
  });
}

module.exports = {
  createInvoicePdfMock
};
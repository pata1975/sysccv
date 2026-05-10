function padNumber(value, length) {
  return String(value).padStart(length, '0');
}

async function createInvoiceMock({ job, order }) {
  const now = new Date();

  return {
    environment: 'mock',
    invoiceType: 'C',
    pointOfSale: '0001',
    invoiceNumber: padNumber(Date.now().toString().slice(-8), 8),
    cae: '00000000000000',
    caeDueDate: new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10),
    issuedAt: now.toISOString(),
    currency: 'ARS',
    total: order.total,
    relatedJobId: job.id
  };
}

module.exports = {
  createInvoiceMock
};
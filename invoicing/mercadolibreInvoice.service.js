const mlibreService = require('../services/mlibre');
const arcaService = require('./arca.service');
const pdfService = require('./pdf.service');
const invoiceFiscalService = require('./invoiceFiscal.service');
const invoiceJobService = require('./invoiceJob.service');

function sanitizeOrderForPersistence(order) {
  if (!order) {
    return null;
  }

  return {
    orderId: order.orderId,
    packId: order.packId || null,
    status: order.status || null,
    dateCreated: order.dateCreated || null,
    dateClosed: order.dateClosed || null,
    currency: order.currency || 'ARS',
    total: order.total || 0,
    paidAmount: order.paidAmount || 0,

    buyerName: order.buyerName || 'Consumidor final',
    buyerDocumentType: order.buyerDocumentType || null,
    buyerDocumentNumber: order.buyerDocumentNumber || null,
    buyerTaxTypeCode: order.buyerTaxTypeCode || null,
    buyerTaxpayerType: order.buyerTaxpayerType || null,
    buyerTaxContributor: order.buyerTaxContributor || null,
    buyerAddress: order.buyerAddress || null,

    buyerId: order.buyerId || null,
    buyerNickname: order.buyerNickname || null,

    items: Array.isArray(order.items) ? order.items : []
  };
}

function buildInvoiceFromLegacyResult(result) {
  if (!result) {
    return null;
  }

  if (result.invoice) {
    return result.invoice;
  }

  if (!result.cae && !result.invoiceNumber) {
    return null;
  }

  return {
    environment: result.arcaResult ? process.env.ARCA_ENV || 'testing' : 'mock',
    invoiceType: result.invoiceType || 'C',
    invoiceTypeCode: result.invoiceTypeCode || 11,
    pointOfSale: result.pointOfSale,
    invoiceNumber: result.invoiceNumber,
    cae: result.cae,
    caeDueDate: result.caeDueDate,
    issuedAt: result.issuedAt || result.updatedAt || new Date().toISOString(),
    currency: result.currency || 'ARS',
    total: result.total || 0,
    relatedJobId: result.jobId || null,
    fiscalInvoice: result.fiscalInvoice || null,
    arcaResult: result.arcaResult || null
  };
}

function getPdfFromResult(result) {
  if (!result) {
    return null;
  }

  if (result.pdf?.filePath) {
    return result.pdf;
  }

  if (result.pdfFilePath) {
    return {
      fileName: result.pdfFileName || null,
      filePath: result.pdfFilePath,
      generatedAt: result.pdfGeneratedAt || null
    };
  }

  return null;
}

function shouldAttemptMercadoLibreUpload(invoice) {
  if (process.env.ML_UPLOAD_INVOICE_TO_ML !== 'true') {
    return false;
  }

  if (invoice?.environment === 'production') {
    return true;
  }

  return process.env.ML_ALLOW_NON_PRODUCTION_INVOICE_UPLOAD === 'true';
}

function shouldBlockMercadoLibreUpload(invoice) {
  return (
    process.env.ML_UPLOAD_INVOICE_TO_ML === 'true' &&
    invoice?.environment !== 'production' &&
    process.env.ML_ALLOW_NON_PRODUCTION_INVOICE_UPLOAD !== 'true'
  );
}

function resolveUploadTargetId(result) {
  return (
    result?.order?.packId ||
    result?.packId ||
    result?.order?.orderId ||
    result?.orderId ||
    null
  );
}

async function ensureArcaAuthorized(job) {
  const existingInvoice = buildInvoiceFromLegacyResult(job.result);

  if (existingInvoice?.cae && existingInvoice?.invoiceNumber) {
    if (job.status === 'pending' || job.status === 'arca_failed') {
      return invoiceJobService.markStatus(job.id, 'arca_authorized');
    }

    return job;
  }

  try {
    await invoiceJobService.markStatus(job.id, 'arca_authorizing');

    const order = await mlibreService.getOrderForInvoice(job.orderId);
    const sanitizedOrder = sanitizeOrderForPersistence(order);
    const fiscalInvoice = invoiceFiscalService.buildArcaInvoiceRequestFromOrder(order);

    const invoice = await arcaService.createInvoice({
      job,
      order,
      fiscalInvoice
    });

    const updatedJob = await invoiceJobService.mergeJobResult(job.id, {
      order: sanitizedOrder,
      fiscalInvoice,
      invoice,

      orderId: sanitizedOrder.orderId,
      packId: sanitizedOrder.packId,
      status: sanitizedOrder.status,
      buyerName: sanitizedOrder.buyerName,
      total: sanitizedOrder.total,
      currency: sanitizedOrder.currency,

      invoiceType: invoice.invoiceType,
      invoiceTypeCode: invoice.invoiceTypeCode,
      pointOfSale: invoice.pointOfSale,
      invoiceNumber: invoice.invoiceNumber,
      cae: invoice.cae,
      caeDueDate: invoice.caeDueDate,
      issuedAt: invoice.issuedAt,
      arcaResult: invoice.arcaResult || null,
      arcaAuthorizedAt: new Date().toISOString()
    });

    return invoiceJobService.markStatus(updatedJob.id, 'arca_authorized');
  } catch (error) {
    await invoiceJobService.markStageFailed(job.id, 'arca_failed', error);
    throw error;
  }
}

async function ensurePdfGenerated(job) {
  const result = job.result || {};
  const existingPdf = getPdfFromResult(result);

  if (existingPdf?.filePath) {
    if (
      job.status === 'pending' ||
      job.status === 'arca_authorized' ||
      job.status === 'pdf_failed'
    ) {
      return invoiceJobService.markStatus(job.id, 'pdf_generated');
    }

    return job;
  }

  try {
    await invoiceJobService.markStatus(job.id, 'pdf_generating');

    const order = result.order;

    if (!order) {
      throw new Error(`El job ${job.id} no tiene order persistido para generar PDF`);
    }

    const invoice = buildInvoiceFromLegacyResult(result);

    if (!invoice) {
      throw new Error(`El job ${job.id} no tiene invoice persistida para generar PDF`);
    }

    const pdf = await pdfService.createInvoicePdfMock({
      job,
      order,
      invoice
    });

    const updatedJob = await invoiceJobService.mergeJobResult(job.id, {
      pdf: {
        fileName: pdf.fileName,
        filePath: pdf.filePath,
        generatedAt: new Date().toISOString()
      },
      pdfFileName: pdf.fileName,
      pdfFilePath: pdf.filePath
    });

    return invoiceJobService.markStatus(updatedJob.id, 'pdf_generated');
  } catch (error) {
    await invoiceJobService.markStageFailed(job.id, 'pdf_failed', error);
    throw error;
  }
}

async function ensureUploadedToMercadoLibre(job) {
  const result = job.result || {};
  const invoice = buildInvoiceFromLegacyResult(result);

  if (result.mercadoLibreUpload?.uploadedAt) {
    return job;
  }

  if (process.env.ML_UPLOAD_INVOICE_TO_ML !== 'true') {
    return job;
  }

  if (shouldBlockMercadoLibreUpload(invoice)) {
    return invoiceJobService.markStatus(job.id, 'upload_blocked_non_production', {
      lastError:
        'Subida bloqueada porque el comprobante no es de producción. Para pruebas explícitas usar ML_ALLOW_NON_PRODUCTION_INVOICE_UPLOAD=true.'
    });
  }

  if (!shouldAttemptMercadoLibreUpload(invoice)) {
    return job;
  }

  try {
    await invoiceJobService.markStatus(job.id, 'upload_pending');

    const pdf = getPdfFromResult(result);

    if (!pdf?.filePath) {
      throw new Error(`El job ${job.id} no tiene PDF para subir a MercadoLibre`);
    }

    const targetId = resolveUploadTargetId(result);

    if (!targetId) {
      throw new Error(`No se pudo determinar packId/orderId para subir factura del job ${job.id}`);
    }

    const uploadResponse = await mlibreService.uploadFiscalDocumentToPack(
      targetId,
      pdf.filePath
    );

    const updatedJob = await invoiceJobService.mergeJobResult(job.id, {
      mercadoLibreUpload: {
        targetId,
        uploadedAt: new Date().toISOString(),
        response: uploadResponse
      }
    });

    return invoiceJobService.markStatus(updatedJob.id, 'uploaded_to_ml');
  } catch (error) {
    await invoiceJobService.markStageFailed(job.id, 'upload_failed', error);
    throw error;
  }
}

async function processInvoiceJob(job) {
  if (job.source !== 'mercadolibre') {
    throw new Error(`Unsupported invoice source: ${job.source}`);
  }

  await invoiceJobService.incrementAttempts(job.id);

  let currentJob = await invoiceJobService.getJobById(job.id);
  currentJob = await ensureArcaAuthorized(currentJob);

  currentJob = await invoiceJobService.getJobById(job.id);
  currentJob = await ensurePdfGenerated(currentJob);

  currentJob = await invoiceJobService.getJobById(job.id);
  currentJob = await ensureUploadedToMercadoLibre(currentJob);

  currentJob = await invoiceJobService.getJobById(job.id);

  if (currentJob.status === 'pdf_generated' && process.env.ML_UPLOAD_INVOICE_TO_ML !== 'true') {
    return currentJob.result;
  }

  if (
    currentJob.status === 'uploaded_to_ml' ||
    currentJob.status === 'upload_blocked_non_production'
  ) {
    return currentJob.result;
  }

  return currentJob.result;
}

module.exports = {
  processInvoiceJob
};
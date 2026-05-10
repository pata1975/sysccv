function roundMoney(value) {
  const number = Number(value || 0);
  return Math.round((number + Number.EPSILON) * 100) / 100;
}

function formatArcaDate(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');

  return `${yyyy}${mm}${dd}`;
}

function normalizeDocumentNumber(value) {
  if (!value) {
    return 0;
  }

  const onlyDigits = String(value).replace(/\D/g, '');

  if (!onlyDigits) {
    return 0;
  }

  return Number(onlyDigits);
}

function mapDocumentTypeToArca(documentType, documentNumber) {
  const type = String(documentType || '').trim().toUpperCase();
  const number = normalizeDocumentNumber(documentNumber);

  if (type === 'CUIT') {
    return {
      docTipo: 80,
      docNro: number
    };
  }

  if (type === 'CUIL') {
    return {
      docTipo: 86,
      docNro: number
    };
  }

  if (type === 'DNI') {
    return {
      docTipo: 96,
      docNro: number
    };
  }

  return {
    docTipo: 99,
    docNro: 0
  };
}

function mapBuyerIvaConditionToArca(order) {
  const value = String(order?.buyerTaxpayerType || '').trim().toLowerCase();

  if (value.includes('consumidor final')) {
    return 5;
  }

  if (value.includes('monotributo')) {
    return 6;
  }

  if (value.includes('responsable inscripto')) {
    return 1;
  }

  if (value.includes('exento')) {
    return 4;
  }

  return 5;
}

function buildInvoiceItems(order) {
  const items = Array.isArray(order?.items) ? order.items : [];

  return items.map((item) => {
    const quantity = Number(item.quantity || 0);
    const unitPrice = roundMoney(item.unitPrice || 0);

    return {
      title: item.title || 'Producto sin título',
      itemId: item.itemId || null,
      sku: item.sku || null,
      quantity,
      unitPrice,
      total: roundMoney(quantity * unitPrice)
    };
  });
}

function buildArcaInvoiceRequestFromOrder(order, options = {}) {
  if (!order) {
    throw new Error('No se recibió order para buildArcaInvoiceRequestFromOrder');
  }

  const pointOfSale = Number(
    options.pointOfSale ||
    process.env.ARCA_POINT_OF_SALE ||
    1
  );

  const invoiceType = Number(
    options.invoiceType ||
    process.env.ARCA_INVOICE_TYPE ||
    11
  );

  const items = buildInvoiceItems(order);
  const totalFromItems = roundMoney(
    items.reduce((acc, item) => acc + item.total, 0)
  );

  const total = roundMoney(order.total || totalFromItems);
  const { docTipo, docNro } = mapDocumentTypeToArca(
    order.buyerDocumentType,
    order.buyerDocumentNumber
  );

  const condicionIVAReceptorId = mapBuyerIvaConditionToArca(order);

  const request = {
    FeCAEReq: {
      FeCabReq: {
        CantReg: 1,
        PtoVta: pointOfSale,
        CbteTipo: invoiceType
      },
      FeDetReq: {
        FECAEDetRequest: {
          Concepto: 1,
          DocTipo: docTipo,
          DocNro: docNro,

          CbteDesde: null,
          CbteHasta: null,
          CbteFch: formatArcaDate(),

          ImpTotal: total,
          ImpTotConc: 0,
          ImpNeto: total,
          ImpOpEx: 0,
          ImpIVA: 0,
          ImpTrib: 0,

          MonId: 'PES',
          MonCotiz: 1,

          CondicionIVAReceptorId: condicionIVAReceptorId
        }
      }
    }
  };

  return {
    source: 'mercadolibre',
    orderId: order.orderId,
    packId: order.packId || null,

    comprobante: {
      tipo: invoiceType,
      tipoDescripcion: invoiceType === 11 ? 'Factura C' : null,
      puntoVenta: pointOfSale,
      concepto: 1,
      moneda: 'PES',
      cotizacion: 1
    },

    receptor: {
      nombre: order.buyerName || 'Consumidor final',
      documentoTipoOriginal: order.buyerDocumentType || null,
      documentoNumeroOriginal: order.buyerDocumentNumber || null,
      docTipo,
      docNro,
      condicionIVAReceptorId,
      condicionIVAOriginal: order.buyerTaxpayerType || null,
      domicilio: order.buyerAddress || null
    },

    importes: {
      total,
      neto: total,
      iva: 0,
      tributos: 0,
      exento: 0,
      noGravado: 0
    },

    items,

    arcaRequest: request
  };
}

module.exports = {
  buildArcaInvoiceRequestFromOrder,
  mapDocumentTypeToArca,
  mapBuyerIvaConditionToArca,
  formatArcaDate,
  roundMoney
};
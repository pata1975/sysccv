require('dotenv').config();

const arcaWsfeService = require('../invoicing/arcaWsfe.service');

function formatArcaDate(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');

  return `${yyyy}${mm}${dd}`;
}

async function main() {
  const pointOfSale = Number(process.env.ARCA_POINT_OF_SALE || 1);
  const invoiceType = Number(process.env.ARCA_INVOICE_TYPE || 11);

  const fiscalInvoice = {
    source: 'manual-test',
    orderId: 'manual-test',
    packId: null,

    comprobante: {
      tipo: invoiceType,
      tipoDescripcion: invoiceType === 11 ? 'Factura C' : null,
      puntoVenta: pointOfSale,
      concepto: 1,
      moneda: 'PES',
      cotizacion: 1
    },

    receptor: {
      nombre: 'Consumidor Final',
      documentoTipoOriginal: 'Consumidor Final',
      documentoNumeroOriginal: null,
      docTipo: 99,
      docNro: 0,
      condicionIVAReceptorId: 5,
      condicionIVAOriginal: 'Consumidor Final',
      domicilio: null
    },

    importes: {
      total: 1,
      neto: 1,
      iva: 0,
      tributos: 0,
      exento: 0,
      noGravado: 0
    },

    items: [
      {
        title: 'Producto de prueba homologacion',
        itemId: null,
        sku: null,
        quantity: 1,
        unitPrice: 1,
        total: 1
      }
    ],

    arcaRequest: {
      FeCAEReq: {
        FeCabReq: {
          CantReg: 1,
          PtoVta: pointOfSale,
          CbteTipo: invoiceType
        },
        FeDetReq: {
          FECAEDetRequest: {
            Concepto: 1,
            DocTipo: 99,
            DocNro: 0,
            CbteDesde: null,
            CbteHasta: null,
            CbteFch: formatArcaDate(),
            ImpTotal: 1,
            ImpTotConc: 0,
            ImpNeto: 1,
            ImpOpEx: 0,
            ImpIVA: 0,
            ImpTrib: 0,
            MonId: 'PES',
            MonCotiz: 1,
            CondicionIVAReceptorId: 5
          }
        }
      }
    }
  };

  console.log('[ARCA test emit] Emitiendo comprobante de prueba', {
    env: process.env.ARCA_ENV || 'testing',
    pointOfSale,
    invoiceType,
    useReal: process.env.ARCA_USE_REAL
  });

  const result = await arcaWsfeService.feCaeSolicitar(fiscalInvoice);

  console.log('[ARCA test emit] Resultado:');
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error('[ARCA test emit] Error:', {
    message: error?.message,
    status: error?.response?.status || null,
    data: error?.response?.data || null,
    details: error?.details || null
  });

  process.exit(1);
});
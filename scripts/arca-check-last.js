require('dotenv').config();

const arcaWsfeService = require('../invoicing/arcaWsfe.service');

async function main() {
  const pointOfSale = Number(process.env.ARCA_POINT_OF_SALE || 1);
  const invoiceType = Number(process.env.ARCA_INVOICE_TYPE || 11);

  console.log('[ARCA check] Consultando último comprobante autorizado', {
    env: process.env.ARCA_ENV || 'testing',
    cuit: process.env.ARCA_CUIT ? 'configurado' : 'faltante',
    pointOfSale,
    invoiceType
  });

  const result = await arcaWsfeService.feCompUltimoAutorizado({
    pointOfSale,
    invoiceType
  });

  console.log('[ARCA check] Resultado:');
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error('[ARCA check] Error:', {
    message: error?.message,
    status: error?.response?.status || null,
    data: error?.response?.data || null,
    details: error?.details || null
  });

  process.exit(1);
});
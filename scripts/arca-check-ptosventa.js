require('dotenv').config();

const arcaWsfeService = require('../invoicing/arcaWsfe.service');

async function main() {
  console.log('[ARCA check] Consultando puntos de venta', {
    env: process.env.ARCA_ENV || 'testing',
    cuit: process.env.ARCA_CUIT ? 'configurado' : 'faltante'
  });

  const result = await arcaWsfeService.feParamGetPtosVenta();

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
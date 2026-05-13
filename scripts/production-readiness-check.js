require('dotenv').config();

const fs = require('fs');

function mask(value) {
  if (!value) return 'faltante';
  return 'configurado';
}

function checkFile(path, label) {
  if (!path) {
    return {
      label,
      ok: false,
      message: 'faltante'
    };
  }

  return {
    label,
    ok: fs.existsSync(path),
    message: fs.existsSync(path) ? 'existe' : `no existe: ${path}`
  };
}

function checkEnv(name, expected = null) {
  const value = process.env[name];

  if (expected === null) {
    return {
      label: name,
      ok: !!value,
      message: mask(value)
    };
  }

  return {
    label: name,
    ok: value === expected,
    message: value || 'faltante',
    expected
  };
}

function printResult(result) {
  const status = result.ok ? 'OK' : 'ERROR';
  const expected = result.expected ? ` esperado=${result.expected}` : '';

  console.log(`[${status}] ${result.label}: ${result.message}${expected}`);
}

function main() {
  const checks = [
    checkEnv('ARCA_ENV', 'production'),
    checkEnv('ARCA_USE_REAL', 'true'),
    checkEnv('ARCA_PRODUCTION_CONFIRMED', 'true'),
    checkEnv('ARCA_CUIT'),
    checkEnv('ARCA_POINT_OF_SALE'),
    checkEnv('ARCA_INVOICE_TYPE', '11'),
    checkEnv('ML_UPLOAD_INVOICE_TO_ML', 'true'),
    checkEnv('ML_ALLOW_NON_PRODUCTION_INVOICE_UPLOAD', 'false'),
    {
  label: 'ARCA_CERT_PATH o ARCA_CERT_PEM',
  ok: !!process.env.ARCA_CERT_PEM || fs.existsSync(process.env.ARCA_CERT_PATH || ''),
  message: process.env.ARCA_CERT_PEM
    ? 'configurado por variable'
    : fs.existsSync(process.env.ARCA_CERT_PATH || '')
      ? 'existe'
      : 'faltante'
},
{
  label: 'ARCA_KEY_PATH o ARCA_KEY_PEM',
  ok: !!process.env.ARCA_KEY_PEM || fs.existsSync(process.env.ARCA_KEY_PATH || ''),
  message: process.env.ARCA_KEY_PEM
    ? 'configurado por variable'
    : fs.existsSync(process.env.ARCA_KEY_PATH || '')
      ? 'existe'
      : 'faltante'
}
  ];

  console.log('[production readiness] Revisión de configuración');
  checks.forEach(printResult);

  const failed = checks.filter((check) => !check.ok);

  if (failed.length > 0) {
    console.error(
      `[production readiness] Hay ${failed.length} condición(es) sin cumplir. No pases a producción todavía.`
    );
    process.exit(1);
  }

  console.log('[production readiness] Configuración mínima completa para probar producción.');
  console.log(
    '[production readiness] Próximo paso seguro: correr npm run arca:check-last contra producción. Eso consulta, no emite.'
  );
}

main();
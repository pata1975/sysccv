require('dotenv').config();

const fs = require('fs');

function mask(value) {
  if (!value) return 'faltante';
  return 'configurado';
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

function checkBoolean(name, expected) {
  return checkEnv(name, String(expected));
}

function checkSecretNotPlaceholder(name) {
  const value = process.env[name] || '';
  const looksPlaceholder = /TU_|PEGAR|TOKEN_|<.*>|PRODUCCION|PLACEHOLDER/i.test(value);

  return {
    label: name,
    ok: !!value && !looksPlaceholder,
    message: !value ? 'faltante' : looksPlaceholder ? 'parece placeholder' : 'configurado'
  };
}

function checkPemOrPath(pathName, pemName, label) {
  const pathValue = process.env[pathName];
  const pemValue = process.env[pemName];

  if (pemValue) {
    const isPem = /-----BEGIN (CERTIFICATE|RSA PRIVATE KEY|PRIVATE KEY)-----/.test(pemValue.replace(/\\n/g, '\n'));
    return {
      label,
      ok: isPem,
      message: isPem ? 'configurado por PEM' : 'PEM inválido'
    };
  }

  return {
    label,
    ok: !!pathValue && fs.existsSync(pathValue),
    message: pathValue && fs.existsSync(pathValue) ? 'existe por path' : 'faltante'
  };
}

function printResult(result) {
  const status = result.ok ? 'OK' : 'ERROR';
  const expected = result.expected ? ` esperado=${result.expected}` : '';
  console.log(`[${status}] ${result.label}: ${result.message}${expected}`);
}

function main() {
  const checks = [
    checkEnv('NODE_ENV'),

    checkEnv('ARCA_ENV', 'production'),
    checkBoolean('ARCA_USE_REAL', true),
    checkBoolean('ARCA_PRODUCTION_CONFIRMED', true),
    checkSecretNotPlaceholder('ARCA_CUIT'),
    checkEnv('ARCA_POINT_OF_SALE'),
    checkEnv('ARCA_INVOICE_TYPE', '11'),
    checkPemOrPath('ARCA_CERT_PATH', 'ARCA_CERT_PEM', 'ARCA_CERT_PATH o ARCA_CERT_PEM'),
    checkPemOrPath('ARCA_KEY_PATH', 'ARCA_KEY_PEM', 'ARCA_KEY_PATH o ARCA_KEY_PEM'),
    checkEnv('ARCA_TA_STORE_DIR'),

    checkEnv('INVOICE_DATA_DIR'),
    checkEnv('INVOICE_PDF_DIR'),
    checkEnv('INVOICE_ADMIN_TOKEN'),

    checkSecretNotPlaceholder('ML_CLIENT_ID'),
    checkSecretNotPlaceholder('ML_CLIENT_SECRET'),
    checkSecretNotPlaceholder('ML_USER_ID'),
    checkSecretNotPlaceholder('ML_ACCESS_TOKEN'),
    checkSecretNotPlaceholder('ML_REFRESH_TOKEN'),
    checkEnv('ML_TOKEN_STORE_PATH'),
    checkBoolean('ML_ALLOW_NON_PRODUCTION_INVOICE_UPLOAD', false),

    checkSecretNotPlaceholder('TN_USER_ID'),
    checkSecretNotPlaceholder('TN_ACCESS_TOKEN')
  ];

  console.log('[production readiness] Revisión de configuración');
  checks.forEach(printResult);

  const failed = checks.filter((check) => !check.ok);

  if (failed.length > 0) {
    console.error(`[production readiness] Hay ${failed.length} condición(es) sin cumplir.`);
    process.exit(1);
  }

  console.log('[production readiness] Configuración mínima completa.');
  console.log('[production readiness] Próximo paso seguro: /debug/arca-last, /debug/ml-me y /debug/tn-products.');
}

main();

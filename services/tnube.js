const axios = require('axios');

function getHeaders() {
  return {
    Authentication: `bearer ${process.env.TN_ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

async function getTNProductBySKU(sku) {
  try {
    const targetSku = String(sku).trim();

    const res = await axios.get(`https://api.tiendanube.com/v1/${process.env.TN_USER_ID}/products`, {
      params: { q: targetSku },
      headers: getHeaders(),
    });

    if (!res.data || res.data.length === 0) {
      console.log(`🔍 El SKU "${targetSku}" no existe en ninguna página de Tiendanube.`);
      return null;
    }

    for (const product of res.data) {
      const variant = product.variants.find((v) => String(v.sku).trim() === targetSku);
      if (variant) {
        return {
          productId: product.id,
          variantId: variant.id,
          stock: variant.stock,
        };
      }
    }

    return null;
  } catch (err) {
    console.error('❌ Error TN:', err.response?.data || err.message);
    return null;
  }
}

async function updateTNStock(productId, variantId, stock) {
  try {
    await axios.put(
      `https://api.tiendanube.com/v1/${process.env.TN_USER_ID}/products/${productId}/variants/${variantId}`,
      { stock: parseInt(stock, 10) },
      { headers: getHeaders() }
    );
    return true;
  } catch (err) {
    console.error('❌ Error API Tiendanube (Update):', err.response?.data || err.message);
    throw err;
  }
}

async function getTNProductById(id) {
  try {
    const res = await axios.get(`https://api.tiendanube.com/v1/${process.env.TN_USER_ID}/products/${id}`, {
      headers: getHeaders(),
    });

    return (res.data?.variants || []).map((v) => ({
      sku: v.sku ? String(v.sku).trim() : null,
      stock: parseInt(v.stock || 0, 10),
    }));
  } catch (err) {
    console.error(`❌ Error TN [${id}]:`, err.response?.data || err.message);
    return null;
  }
}

async function getTNVariantBySKU(sku) {
  const res = await axios.get(`https://api.tiendanube.com/v1/${process.env.TN_USER_ID}/products`, {
    headers: getHeaders(),
  });

  for (const product of res.data) {
    const variant = product.variants.find((v) => String(v.sku).trim() === String(sku).trim());
    if (variant) {
      return {
        product_id: product.id,
        variant_id: variant.id,
        stock: variant.stock,
      };
    }
  }

  return null;
}

async function updateTNVariantStock(productId, variantId, stock) {
  return axios.put(
    `https://api.tiendanube.com/v1/${process.env.TN_USER_ID}/products/${productId}/variants/${variantId}`,
    { stock: parseInt(stock, 10) },
    { headers: getHeaders() }
  );
}

async function syncToTiendanube(sku, newStock) {
  try {
    const targetStock = parseInt(newStock, 10);
    const variantData = await getTNVariantBySKU(sku);

    if (!variantData) {
      console.warn(`[TN-SERVICE] SKU ${sku} no hallado en la tienda.`);
      return null;
    }

    console.log(`[TN-SERVICE] Actualizando SKU ${sku} -> Stock: ${targetStock}`);
    await updateTNVariantStock(variantData.product_id, variantData.variant_id, targetStock);
    return true;
  } catch (err) {
    console.error(`[TN-SERVICE] Error en syncToTiendanube para SKU ${sku}:`, err.response?.data || err.message);
    throw err;
  }
}

module.exports = {
  getTNProductBySKU,
  updateTNStock,
  getTNProductById,
  getTNVariantBySKU,
  updateTNVariantStock,
  syncToTiendanube,
};

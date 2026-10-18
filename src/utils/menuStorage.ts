import type { StoreConfig, Product, Additional, StoreStatus } from '../types.ts';
import { DEFAULT_CONFIG, DEFAULT_PRODUCTS, DEFAULT_ADDITIONALS } from '../data/defaultMenuData.ts';
import { computeStoreStatus } from './statusHelper.ts';
import { saveImageToIndexedDb, getImageFromIndexedDb } from './imageDb.ts';

export const CURRENT_DATA_VERSION = 2;
const LOCAL_MENU_DATA_KEY = 'faby_menu_data_v2';
const LEGACY_LOCAL_MENU_DATA_KEY = 'faby_menu_data_v1';
const LOCAL_ADMIN_CREDS_KEY = 'faby_admin_creds_v1';
const LOCAL_CUSTOM_API_KEY = 'faby_custom_api_url';

export interface MenuDataResponse {
  config: StoreConfig;
  products: Product[];
  additionals: Additional[];
  storeStatus: StoreStatus;
}

// In-memory cache to guarantee instant synchronization across views
let inMemoryCache: { config: StoreConfig; products: Product[]; additionals: Additional[] } | null = null;

/**
 * Get configured API Base URL (if user configured a custom backend, e.g. Render/Cloud Run, or VITE_API_URL)
 */
export function getApiBaseUrl(): string {
  try {
    const custom = localStorage.getItem(LOCAL_CUSTOM_API_KEY);
    if (custom && custom.trim()) {
      return custom.trim().replace(/\/+$/, '');
    }
  } catch {}

  const envUrl = (import.meta as any).env?.VITE_API_URL;
  if (envUrl && typeof envUrl === 'string' && envUrl.trim()) {
    return envUrl.trim().replace(/\/+$/, '');
  }

  return '';
}

export function setCustomApiBaseUrl(url: string) {
  try {
    if (url && url.trim()) {
      localStorage.setItem(LOCAL_CUSTOM_API_KEY, url.trim().replace(/\/+$/, ''));
    } else {
      localStorage.removeItem(LOCAL_CUSTOM_API_KEY);
    }
  } catch {}
}

/**
 * Checks if a photo URL looks valid and not like a broken dummy or missing local upload
 */
function isHealthyPhotoUrl(url?: string | null): boolean {
  if (!url || typeof url !== 'string') return false;
  const clean = url.trim();
  if (!clean) return false;
  // Data URLs and blob URLs are always valid
  if (clean.startsWith('data:') || clean.startsWith('blob:')) return true;
  // External URLs (Unsplash, HTTPS)
  if (clean.startsWith('http://') || clean.startsWith('https://')) return true;
  // Local existing static assets
  if (clean === '/logo_oficial.png' || clean === '/logo_oficial.jpg' || clean.startsWith('/pwa-')) return true;
  // Local uploads: only if they are known valid files or general paths
  return clean.startsWith('/');
}

/**
 * Get stored or default local menu data, ensuring all products have valid photos and config
 */
export function getLocalMenuData(): { config: StoreConfig; products: Product[]; additionals: Additional[] } {
  if (inMemoryCache) {
    return inMemoryCache;
  }

  // Clear legacy v1 data if v2 doesn't exist yet to prevent mobile stale cache retention
  try {
    if (!localStorage.getItem(LOCAL_MENU_DATA_KEY) && localStorage.getItem(LEGACY_LOCAL_MENU_DATA_KEY)) {
      localStorage.removeItem(LEGACY_LOCAL_MENU_DATA_KEY);
    }
  } catch {}

  try {
    const raw = localStorage.getItem(LOCAL_MENU_DATA_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.config && Array.isArray(parsed.products) && Array.isArray(parsed.additionals)) {
        const productMap = new Map<string, Product>();
        DEFAULT_PRODUCTS.forEach((dp) => productMap.set(dp.id, { ...dp }));

        parsed.products.forEach((p: Product) => {
          if (p && p.id) {
            const existing = productMap.get(p.id);
            if (existing) {
              productMap.set(p.id, {
                ...existing,
                ...p,
                photoUrl: p.photoUrl !== undefined ? p.photoUrl : existing.photoUrl,
                updatedAt: p.updatedAt || existing.updatedAt || Date.now(),
              });
            } else {
              productMap.set(p.id, p);
            }
          }
        });

        const mergedProducts = Array.from(productMap.values()).sort(
          (a, b) => (a.order || 99) - (b.order || 99)
        );

        const result = {
          config: { ...DEFAULT_CONFIG, ...parsed.config, version: CURRENT_DATA_VERSION },
          products: mergedProducts,
          additionals: parsed.additionals.length > 0 ? parsed.additionals : DEFAULT_ADDITIONALS,
        };
        inMemoryCache = result;
        return result;
      }
    }
  } catch (e) {
    console.warn('Could not read local menu cache:', e);
  }

  const defaultResult = {
    config: { ...DEFAULT_CONFIG, version: CURRENT_DATA_VERSION },
    products: [...DEFAULT_PRODUCTS],
    additionals: [...DEFAULT_ADDITIONALS],
  };
  inMemoryCache = defaultResult;
  return defaultResult;
}

/**
 * Save updated menu data to localStorage, IndexedDB and in-memory cache, and notify UI
 */
export function saveLocalMenuData(data: {
  config?: StoreConfig;
  products?: Product[];
  additionals?: Additional[];
}) {
  const current = getLocalMenuData();
  const updated = {
    config: {
      ...(data.config || current.config),
      version: CURRENT_DATA_VERSION,
      updatedAt: Date.now(),
    },
    products: (data.products || current.products).map((p) => ({
      ...p,
      updatedAt: p.updatedAt || Date.now(),
    })),
    additionals: data.additionals || current.additionals,
  };

  inMemoryCache = updated;

  // Persist base64 images into IndexedDB asynchronously for permanent device storage
  if (data.products && Array.isArray(data.products)) {
    data.products.forEach((p) => {
      if (p.id && p.photoUrl && p.photoUrl.startsWith('data:image')) {
        saveImageToIndexedDb(p.id, p.photoUrl).catch(() => {});
      }
    });
  }

  try {
    localStorage.setItem(LOCAL_MENU_DATA_KEY, JSON.stringify(updated));
  } catch (e) {
    console.warn('LocalStorage quota or write warning (persisting in memory and IndexedDB):', e);
  }

  // Notify other windows/tabs and components about the data change
  try {
    window.dispatchEvent(new CustomEvent('faby_menu_updated', { detail: updated }));
  } catch {}

  return updated;
}

/**
 * Update a specific product directly in local cache
 */
export function updateLocalProduct(id: string, updates: Partial<Product>): Product[] {
  const current = getLocalMenuData();
  const index = current.products.findIndex((p) => p.id === id);
  let updatedProducts: Product[];

  const now = Date.now();
  if (index > -1) {
    updatedProducts = current.products.map((p) =>
      p.id === id ? ({ ...p, ...updates, updatedAt: now } as Product) : p
    );
  } else {
    const def = DEFAULT_PRODUCTS.find((p) => p.id === id);
    const newProd = ({ ...(def || {}), id, ...updates, updatedAt: now } as Product);
    updatedProducts = [...current.products, newProd];
  }

  saveLocalMenuData({ products: updatedProducts });
  return updatedProducts;
}

// In-flight fetch deduplication to prevent simultaneous duplicate requests
let activeFetchPromise: Promise<MenuDataResponse> | null = null;

/**
 * Fetch menu data from server with automatic seamless offline/Netlify fallback.
 * Deduplicates in-flight requests, prioritizes fast static JSON endpoints,
 * preserves user-saved newer product modifications and photos, and falls back instantaneously.
 */
export async function fetchMenuDataWithFallback(): Promise<MenuDataResponse> {
  if (activeFetchPromise) {
    return activeFetchPromise;
  }

  activeFetchPromise = (async (): Promise<MenuDataResponse> => {
    const apiBase = getApiBaseUrl();
    const timestamp = Date.now();

    // Prioritize direct static /api/menu.json (CDN edge-cached on Netlify and instant in Express)
    const endpointCandidates = [
      apiBase ? `${apiBase}/api/menu.json?_t=${timestamp}` : '',
      apiBase ? `${apiBase}/api/menu?_t=${timestamp}` : '',
      `/api/menu.json?_t=${timestamp}`,
      `/api/menu?_t=${timestamp}`,
    ].filter(Boolean);

    const endpoints = Array.from(new Set(endpointCandidates));

    for (const url of endpoints) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1500);

      try {
        const res = await fetch(url, {
          headers: {
            Accept: 'application/json',
            'Cache-Control': 'no-cache',
          },
          cache: 'no-store',
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        const contentType = res.headers.get('content-type') || '';
        if (res.ok && contentType.includes('application/json')) {
          const data = await res.json();
          if (data && data.config && Array.isArray(data.products) && data.products.length > 0) {
            const serverProducts = data.products as Product[];
            const serverIds = new Set(serverProducts.map((p) => p.id));

            // CRITICAL: Merge products using updatedAt timestamp!
            // If the user modified a product locally (e.g. uploaded a new photo or edited description),
            // NEVER overwrite it with an older copy from static JSON!
            const local = getLocalMenuData();
            const localMap = new Map((local.products || []).map((p) => [p.id, p]));

            const mergedProducts: Product[] = serverProducts.map((serverProd) => {
              const localProd = localMap.get(serverProd.id);
              if (localProd && (localProd.updatedAt || 0) > (serverProd.updatedAt || 0)) {
                return localProd;
              }
              return serverProd;
            });

            // Retain any custom offline-created products not present in server
            (local.products || []).forEach((localProd) => {
              if (localProd.id && !serverIds.has(localProd.id)) {
                mergedProducts.push(localProd);
              }
            });

            mergedProducts.sort((a, b) => (a.order || 99) - (b.order || 99));

            const finalConfig = {
              ...DEFAULT_CONFIG,
              ...data.config,
              version: CURRENT_DATA_VERSION,
              updatedAt: data.config.updatedAt || timestamp,
            };

            const finalAdditionals =
              Array.isArray(data.additionals) && data.additionals.length > 0
                ? data.additionals
                : DEFAULT_ADDITIONALS;

            saveLocalMenuData({
              config: finalConfig,
              products: mergedProducts,
              additionals: finalAdditionals,
            });

            return {
              config: finalConfig,
              products: mergedProducts,
              additionals: finalAdditionals,
              storeStatus: data.storeStatus || computeStoreStatus(finalConfig),
            };
          }
        }
      } catch {
        clearTimeout(timeoutId);
        // Continue to next endpoint attempt without delay
      }
    }

    // 2. Seamless instant fallback to local/bundled menu data
    const local = getLocalMenuData();
    const storeStatus = computeStoreStatus(local.config);

    return {
      config: local.config,
      products: local.products,
      additionals: local.additionals,
      storeStatus,
    };
  })().finally(() => {
    activeFetchPromise = null;
  });

  return activeFetchPromise;
}

/**
 * Local Admin Authentication & Credential Management for Static Hosting
 */
export function getLocalAdminCreds(): { email: string; passwordHash: string; recoveryKey: string } {
  try {
    const raw = localStorage.getItem(LOCAL_ADMIN_CREDS_KEY);
    if (raw) {
      return JSON.parse(raw);
    }
  } catch {}

  return {
    email: 'admin@fabylanches.com',
    passwordHash: 'admin',
    recoveryKey: 'FABY-ADMIN-RECOVERY',
  };
}

export function saveLocalAdminCreds(creds: { email?: string; passwordHash?: string; recoveryKey?: string }) {
  try {
    const current = getLocalAdminCreds();
    const updated = { ...current, ...creds };
    localStorage.setItem(LOCAL_ADMIN_CREDS_KEY, JSON.stringify(updated));
  } catch (e) {
    console.warn('Could not persist admin credentials:', e);
  }
}

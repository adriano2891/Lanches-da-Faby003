/**
 * Utility for formatting product image URLs with automatic cache-busting
 * Prevents stale browser / CDN / Service Worker caching on desktop and mobile.
 */
export type ImageSize = 'thumbnail' | 'medium' | 'full';

/**
 * Utility for formatting product image URLs with responsive sizing and automatic cache-busting.
 * Optimizes Unsplash and external images to prevent downloading 600px+ images for small 120px thumbnails,
 * while ensuring local uploads and cache-busting timestamps function properly.
 */
export function getProductImageUrl(
  photoUrl?: string | null,
  updatedAt?: number | string | null,
  size: ImageSize = 'thumbnail'
): string {
  if (!photoUrl || typeof photoUrl !== 'string') return '';
  let clean = photoUrl.trim();
  if (!clean) return '';

  // Data URLs and blob URLs do not require cache busting or remote resizing
  if (clean.startsWith('data:') || clean.startsWith('blob:')) {
    return clean;
  }

  // Optimize Unsplash images dynamically according to display size
  if (clean.includes('images.unsplash.com')) {
    const widthParam = size === 'thumbnail' ? 'w=300&q=75' : size === 'medium' ? 'w=500&q=80' : 'w=900&q=85';
    // Remove existing width, height and quality query parameters
    clean = clean
      .replace(/[?&]w=\d+/g, '')
      .replace(/[?&]h=\d+/g, '')
      .replace(/[?&]q=\d+/g, '')
      .replace(/[?&]auto=[^&]*/g, '');

    const separator = clean.includes('?') ? '&' : '?';
    clean = `${clean}${separator}${widthParam}&auto=format&fit=crop`;
  }

  // If pointing to the default official logo in PNG, prefer WebP when available
  if (clean === '/logo_oficial.png' || clean === '/logo_oficial.jpg') {
    if (size === 'thumbnail') {
      return '/logo_oficial_sm.webp';
    }
    return '/logo_oficial.webp';
  }

  // Append or replace cache-busting timestamp query parameter
  try {
    const v = updatedAt && Number(updatedAt) > 0 ? String(updatedAt) : 'v3';
    const separator = clean.includes('?') ? '&' : '?';
    // If it already has a v= parameter, replace it
    if (/[?&]v=[^&#]*/.test(clean)) {
      return clean.replace(/([?&]v=)[^&#]*/, `$1${v}`);
    }
    return `${clean}${separator}v=${v}`;
  } catch {
    return clean;
  }
}

/**
 * Generates an optimized srcSet for responsive retina display (1x and 2x)
 */
export function getProductImageSrcSet(
  photoUrl?: string | null,
  updatedAt?: number | string | null
): string | undefined {
  if (!photoUrl || typeof photoUrl !== 'string') return undefined;
  if (!photoUrl.includes('images.unsplash.com')) return undefined;

  const thumb = getProductImageUrl(photoUrl, updatedAt, 'thumbnail');
  const medium = getProductImageUrl(photoUrl, updatedAt, 'medium');
  return `${thumb} 1x, ${medium} 2x`;
}

/**
 * Actively purge any stale image and menu caches from window.caches (Service Worker CacheStorage)
 */
export async function clearProductImageCaches(): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    if ('caches' in window) {
      const keys = await window.caches.keys();
      for (const key of keys) {
        if (
          key.includes('product-images') ||
          key.includes('api-menu') ||
          key.includes('menu') ||
          key.includes('images')
        ) {
          await window.caches.delete(key);
        }
      }
    }
  } catch (err) {
    console.warn('CacheStorage cleanup notice:', err);
  }
}

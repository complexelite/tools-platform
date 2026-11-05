const legacyRoots=['/static','/scrape','/download','/delete','/jobs','/view','/api/docs','/api/v1/jobs'];

// Keep old bookmarks working without letting the scraper own hostname-root routes.
export function legacyGoogleMapsPath(pathname) {
  return legacyRoots.some(root=>pathname===root||pathname.startsWith(root+'/'))
    ? '/google-maps-scraper'+pathname
    : null;
}

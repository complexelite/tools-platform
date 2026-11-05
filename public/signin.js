(() => {
  const link = document.getElementById('perfex-signin');
  if (!link) return;

  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin || event.data?.type !== 'ce-tools-authenticated') return;
    const status = document.getElementById('signin-status');
    if (status) status.textContent = 'Signed in. Opening your Tools workspace…';
    window.location.assign('/');
  });

  link.addEventListener('click', (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const popupUrl = new URL(link.href, window.location.href);
    popupUrl.searchParams.set('popup', '1');
    const width = Math.min(560, window.screen.availWidth || 560);
    const height = Math.min(780, window.screen.availHeight || 780);
    const left = Math.max(0, Math.round((window.screen.availWidth - width) / 2));
    const top = Math.max(0, Math.round((window.screen.availHeight - height) / 2));
    const popup = window.open(popupUrl.href, 'complexElitePerfexSignIn', `popup=yes,width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`);
    if (!popup) return; // The link's normal same-tab SSO flow remains the fallback.
    event.preventDefault();
    const status = document.getElementById('signin-status');
    if (status) status.textContent = 'Continue in the secure Perfex sign-in window. This page will open your Tools workspace when you finish.';
  });
})();

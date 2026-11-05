(() => {
  const status = document.getElementById('callback-status');
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage({ type: 'ce-tools-authenticated' }, window.location.origin);
      if (status) status.textContent = 'You are signed in. Returning to the Tools workspace…';
      window.setTimeout(() => window.close(), 500);
    } else if (status) {
      status.textContent = 'You are signed in. Use the button below to open your Tools workspace.';
    }
  } catch {
    if (status) status.textContent = 'You are signed in. Use the button below to open your Tools workspace.';
  }
})();

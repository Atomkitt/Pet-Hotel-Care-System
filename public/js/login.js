// public/js/login.js
(function () {
  function routeForRole(role) {
    if (role === 'Developer') return 'dev.html';
    if (role === 'Admin') return 'admin.html';
    return 'index.html';
  }

  function showMessage(text, type = 'error') {
    const box = document.getElementById('authNotice');
    box.className = `auth-msg ${type}`;
    box.textContent = text;
  }

  async function safeJson(res) {
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return res.json();
    }
    return { error: `Unexpected server response (${res.status})` };
  }

  async function checkExistingSession() {
    const params = new URLSearchParams(window.location.search);
    const reason = params.get('reason');

    if (reason === 'forbidden') {
      showMessage(
        'Access denied: Your current role does not have permission for that page. Sign in with an authorized account.',
        'info'
      );
      return;
    }
    if (reason === 'unauthorized') {
      showMessage('Please sign in to continue.', 'info');
    }

    try {
      const res = await fetch('/api/auth/me', { credentials: 'include' });
      if (res.ok) {
        const data = await safeJson(res);
        if (data && data.user) {
          window.location.replace(routeForRole(data.user.role));
        }
      }
    } catch (_) {
      // Not signed in
    }
  }

  async function handleLogin(e) {
    e.preventDefault();
    const btn = document.getElementById('loginSubmitBtn');
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;

    btn.disabled = true;
    btn.textContent = 'Signing in...';

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'PawStay-Client'
        },
        credentials: 'include',
        body: JSON.stringify({ email, password })
      });

      const data = await safeJson(res);
      if (!res.ok) {
        showMessage(data.error || 'Invalid email or password.', 'error');
        btn.disabled = false;
        btn.textContent = 'Sign In';
        return;
      }

      window.location.replace(routeForRole(data.user.role));
    } catch (err) {
      showMessage('Network error connecting to server: ' + err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Sign In';
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const loginForm = document.getElementById('loginForm');
    if (loginForm) {
      loginForm.addEventListener('submit', handleLogin);
    }

    document.querySelectorAll('[data-demo-email]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.getElementById('loginEmail').value = btn.getAttribute('data-demo-email') || '';
        document.getElementById('loginPassword').value = btn.getAttribute('data-demo-pass') || '';
      });
    });

    checkExistingSession();
  });
})();

// public/js/register.js
(function () {
  function showError(msg) {
    const box = document.getElementById('registerError');
    box.className = 'auth-msg error';
    box.textContent = msg;
  }

  async function safeJson(res) {
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return res.json();
    }
    return { error: `Unexpected server response (${res.status})` };
  }

  async function handleRegister(e) {
    e.preventDefault();
    const name = document.getElementById('regName').value.trim();
    const email = document.getElementById('regEmail').value.trim();
    const phone = document.getElementById('regPhone').value.trim();
    const password = document.getElementById('regPassword').value;
    const confirmPassword = document.getElementById('regConfirm').value;
    const btn = document.getElementById('regSubmitBtn');

    if (password.length < 8) {
      showError('Password must be at least 8 characters long.');
      return;
    }

    if (password !== confirmPassword) {
      showError('Passwords do not match.');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Creating account...';

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'PawStay-Client'
        },
        credentials: 'include',
        body: JSON.stringify({ name, email, phone, password })
      });

      const data = await safeJson(res);
      if (!res.ok) {
        showError(data.error || 'Registration failed.');
        btn.disabled = false;
        btn.textContent = 'Create Account';
        return;
      }

      window.location.replace('index.html');
    } catch (err) {
      showError('Network error: ' + err.message);
      btn.disabled = false;
      btn.textContent = 'Create Account';
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('registerForm');
    if (form) {
      form.addEventListener('submit', handleRegister);
    }
  });
})();

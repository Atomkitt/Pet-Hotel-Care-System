// public/js/dev.js
(function () {
  const ALLOWED_ROLES = ['Developer'];
  let currentDevUser = null;
  let cachedUsers = [];

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async function safeJson(res) {
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return res.json();
    }
    return { error: `Unexpected server response (${res.status})` };
  }

  async function apiFetch(url, options = {}) {
    const mergedOptions = {
      ...options,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'PawStay-Client',
        ...(options.headers || {})
      }
    };

    const res = await fetch(url, mergedOptions);
    if (res.status === 401) {
      window.location.replace('login.html?reason=unauthorized');
      throw new Error('Unauthorized');
    }
    if (res.status === 403) {
      window.location.replace('login.html?reason=forbidden');
      throw new Error('Forbidden');
    }
    return res;
  }

  async function verifyAuth() {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'include' });
      if (!res.ok) {
        window.location.replace('login.html?reason=unauthorized');
        return null;
      }
      const data = await safeJson(res);
      const user = data.user;

      if (!user || !ALLOWED_ROLES.includes(user.role)) {
        window.location.replace('login.html?reason=forbidden');
        return null;
      }

      currentDevUser = user;
      document.getElementById('currentUserName').textContent = `🛠️ ${user.name}`;
      document.getElementById('currentUserRole').textContent = user.role;
      document.getElementById('appContainer').style.visibility = 'visible';
      return user;
    } catch (_) {
      window.location.replace('login.html?reason=unauthorized');
      return null;
    }
  }

  async function handleLogout() {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'X-Requested-With': 'PawStay-Client' },
        credentials: 'include'
      });
    } finally {
      window.location.replace('login.html');
    }
  }

  async function loadUsers() {
    const tbody = document.getElementById('userTable');
    try {
      const res = await apiFetch('/api/users');
      const users = await safeJson(res);
      if (!res.ok) throw new Error(users.error || 'Failed to load users');

      cachedUsers = users;

      tbody.innerHTML = users
        .map((u) => {
          const uId = Number(u.user_id);
          const isProtectedDev =
            String(u.email).toLowerCase() === 'nattapat@pawstay.dev' ||
            (currentDevUser && uId === Number(currentDevUser.user_id));

          if (isProtectedDev) {
            return `
              <tr>
                <td>${escapeHtml(u.name)}</td>
                <td>${escapeHtml(u.email)}</td>
                <td>
                  <select disabled aria-label="Protected Developer role" style="margin: 0; padding: 4px 8px; font-size: 0.8rem; cursor: not-allowed; opacity: 0.7;">
                    <option value="User">User</option>
                    <option value="Admin">Administrator</option>
                    <option value="Developer" selected>Developer</option>
                  </select>
                </td>
                <td><button type="button" class="btn-danger btn-sm" disabled style="opacity: 0.5; cursor: not-allowed;">Protected</button></td>
              </tr>
            `;
          }

          return `
            <tr>
              <td>${escapeHtml(u.name)}</td>
              <td>${escapeHtml(u.email)}</td>
              <td>
                <select data-action="change-role" data-user-id="${uId}" style="margin: 0; padding: 4px 8px; font-size: 0.8rem;">
                  <option value="User" ${u.role === 'User' ? 'selected' : ''}>User</option>
                  <option value="Admin" ${u.role === 'Admin' ? 'selected' : ''}>Administrator</option>
                  <option value="Developer" ${u.role === 'Developer' ? 'selected' : ''}>Developer</option>
                </select>
              </td>
              <td>
                <button type="button" class="btn-danger btn-sm" data-action="revoke-role" data-user-id="${uId}">Revoke</button>
              </td>
            </tr>
          `;
        })
        .join('');
    } catch (err) {
      if (err.message !== 'Unauthorized' && err.message !== 'Forbidden') {
        console.error('Error loading users:', err);
        tbody.innerHTML = `<tr><td colspan="4" style="color: var(--danger);">${escapeHtml(err.message)}</td></tr>`;
      }
    }
  }

  async function updateRole(userId, newRole) {
    const target = cachedUsers.find((u) => Number(u.user_id) === Number(userId));
    const emailLabel = target ? target.email : `#${userId}`;

    try {
      const res = await apiFetch(`/api/users/${Number(userId)}/role`, {
        method: 'PUT',
        body: JSON.stringify({ role: newRole })
      });
      const data = await safeJson(res);
      if (!res.ok) {
        alert(data.error || 'Failed to update role.');
        await loadUsers();
        return;
      }
      alert(`Access Control Updated:\nUser [${emailLabel}] has been assigned role: ${newRole}`);
      await Promise.all([loadUsers(), loadPoolAndAudit()]);
    } catch (err) {
      if (err.message !== 'Unauthorized' && err.message !== 'Forbidden') {
        alert('Error updating role: ' + err.message);
      }
    }
  }

  async function revokeAccess(userId, btnEl) {
    const target = cachedUsers.find((u) => Number(u.user_id) === Number(userId));
    const userName = target ? target.name : `#${userId}`;
    if (!confirm(`Are you sure you want to revoke elevated privileges for "${userName}"?`)) return;
    if (btnEl) btnEl.disabled = true;

    try {
      const res = await apiFetch(`/api/users/${Number(userId)}/role`, {
        method: 'PUT',
        body: JSON.stringify({ role: 'User' })
      });
      const data = await safeJson(res);
      if (!res.ok) {
        alert(data.error || 'Failed to revoke privileges.');
        return;
      }
      alert(`Privileges revoked for ${userName}. Role reverted to default 'User'.`);
      await Promise.all([loadUsers(), loadPoolAndAudit()]);
    } catch (err) {
      if (err.message !== 'Unauthorized' && err.message !== 'Forbidden') {
        alert('Error revoking access: ' + err.message);
      }
    } finally {
      if (btnEl) btnEl.disabled = false;
    }
  }

  function switchRoutineTest() {
    const routine = document.getElementById('routineSelect').value;
    const trgInputs = document.getElementById('trgInputs');
    trgInputs.style.display = routine === 'trg_status' ? 'block' : 'none';
  }

  async function executeRoutineTest() {
    const routine = document.getElementById('routineSelect').value;
    const bookingId = Number(document.getElementById('testBookingId').value) || 1;
    const status = document.getElementById('testTriggerStatus').value;
    const consoleBox = document.getElementById('sqlConsole');
    const btn = document.getElementById('executeRoutineBtn');

    btn.disabled = true;
    consoleBox.textContent = '/* Dispatching statement to MySQL 8.0 connection pool... */';

    try {
      const res = await apiFetch('/api/dev/execute-test', {
        method: 'POST',
        body: JSON.stringify({
          routine,
          booking_id: bookingId,
          status
        })
      });
      const data = await safeJson(res);

      if (!res.ok) {
        consoleBox.textContent = `ERROR: ${data.error || 'Execution failed'}\n${data.details || ''}`;
      } else {
        consoleBox.textContent = data.consoleOutput;
      }

      await loadPoolAndAudit();
    } catch (err) {
      if (err.message !== 'Unauthorized' && err.message !== 'Forbidden') {
        consoleBox.textContent = `Network Error: ${err.message}`;
      }
    } finally {
      btn.disabled = false;
    }
  }

  async function loadPoolAndAudit() {
    const pill = document.getElementById('dbHealthPill');
    const auditBody = document.getElementById('auditLogs');

    try {
      const res = await apiFetch('/api/dev/pool-status');
      const data = await safeJson(res);

      if (res.ok && data.connected) {
        pill.className = 'status-pill status-healthy';
        pill.textContent = `● MySQL ${data.mysqlVersion || '8.0'} Connected`;
      } else {
        pill.className = 'status-pill status-error';
        pill.textContent = '● MySQL Disconnected';
      }

      document.getElementById('maxPoolSize').innerText = data.maxPoolSize ?? 10;
      document.getElementById('activeConns').innerText = data.activeConnections ?? 0;
      document.getElementById('idleConns').innerText = data.idleConnections ?? 0;
      document.getElementById('avgLatency').innerText = `${data.avgLatencyMs ?? data.pingLatencyMs ?? 0} ms`;

      const logs = Array.isArray(data.auditLogs) ? data.auditLogs : [];
      if (logs.length === 0) {
        auditBody.innerHTML =
          '<tr><td colspan="5" style="color: var(--text-muted); text-align: center;">No parameterized queries recorded yet.</td></tr>';
        return;
      }

      auditBody.innerHTML = logs
        .slice(0, 15)
        .map((item) => {
          const paramsText = item.params && item.params.length > 0 ? ` ${JSON.stringify(item.params)}` : '';
          const badgeClass = item.status === 'ERROR' ? 'tag-aggressive' : 'tag-friendly';

          return `
            <tr>
              <td>${escapeHtml(item.timestamp)}</td>
              <td><code>${escapeHtml(item.type)}</code></td>
              <td style="font-family: monospace; font-size: 0.8rem;">${escapeHtml(item.statement + paramsText)}</td>
              <td>${escapeHtml(item.latencyMs)} ms</td>
              <td><span class="tag ${badgeClass}" style="margin-top: 0;">${escapeHtml(item.status)}</span></td>
            </tr>
          `;
        })
        .join('');
    } catch (err) {
      if (err.message !== 'Unauthorized' && err.message !== 'Forbidden') {
        pill.className = 'status-pill status-error';
        pill.textContent = '● Server Unreachable';
      }
    }
  }

  function bindEvents() {
    document.getElementById('logoutBtn').addEventListener('click', handleLogout);
    document.getElementById('routineSelect').addEventListener('change', switchRoutineTest);
    document.getElementById('executeRoutineBtn').addEventListener('click', executeRoutineTest);
    document.getElementById('refreshAuditBtn').addEventListener('click', loadPoolAndAudit);

    document.getElementById('userTable').addEventListener('change', (e) => {
      const sel = e.target.closest('select[data-action="change-role"]');
      if (sel) {
        updateRole(Number(sel.getAttribute('data-user-id')), sel.value);
      }
    });

    document.getElementById('userTable').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action="revoke-role"]');
      if (btn) {
        revokeAccess(Number(btn.getAttribute('data-user-id')), btn);
      }
    });
  }

  async function initDevConsole() {
    bindEvents();
    const user = await verifyAuth();
    if (!user) return;
    await loadUsers();
    await loadPoolAndAudit();
  }

  document.addEventListener('DOMContentLoaded', initDevConsole);
})();

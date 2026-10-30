// public/js/admin.js
(function () {
  const ALLOWED_ROLES = ['Admin', 'Developer'];
  let pendingCheckoutBookingId = null;
  let cachedBookingsById = new Map();
  let cachedRoomsById = new Map();
  let socket = null;
  let toastTimer = null;

  function showToast(msg) {
    const el = document.getElementById('rtToast');
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.style.display = 'none';
    }, 4500);
  }

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

      document.getElementById('currentUserName').textContent = `👨‍💼 ${user.name}`;
      const roleBadge = document.getElementById('currentUserRole');
      roleBadge.textContent = user.role === 'Admin' ? 'Administrator' : user.role;
      roleBadge.className = 'role-badge ' + (user.role === 'Developer' ? 'dev' : 'admin');

      if (user.role === 'Developer') {
        document.getElementById('navDevLink').style.display = 'inline';
      }

      document.getElementById('appContainer').style.visibility = 'visible';
      return user;
    } catch (_) {
      window.location.replace('login.html?reason=unauthorized');
      return null;
    }
  }

  function initRealtimeSocket() {
    if (typeof io !== 'function') return;
    socket = io({ withCredentials: true });

    socket.on('booking:created', async (payload) => {
      if (payload && payload.event === 'payment_confirmed') {
        showToast(
          `💳 Payment Confirmed! Booking #${payload.booking_id} (Room #${payload.room_number}) is now Checked-In!`
        );
      } else if (payload && payload.event === 'slip_submitted') {
        showToast(
          `🧾 Payment Slip Uploaded for Booking #${payload.booking_id} (Room #${payload.room_number}) — Ready for review!`
        );
      } else if (payload) {
        showToast(`🔔 New Reservation #${payload.booking_id} received for Room #${payload.room_number}!`);
      }
      await refreshDashboard();
    });

    socket.on('room:status_changed', async () => {
      await refreshDashboard();
    });

    socket.on('log:added', async () => {
      await loadStayLogs();
    });
  }

  async function handleLogout() {
    try {
      if (socket) socket.disconnect();
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'X-Requested-With': 'PawStay-Client' },
        credentials: 'include'
      });
    } finally {
      window.location.replace('login.html');
    }
  }

  function formatShortDate(dtStr) {
    if (!dtStr) return '';
    const d = new Date(dtStr);
    if (Number.isNaN(d.getTime())) return dtStr;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function formatRoomTier(roomType) {
    return roomType === 'Suite' ? 'VIP' : roomType;
  }

  function renderVaccinePetCards(pets) {
    return (pets || [])
      .map((pet) => {
        const avatarHtml = pet.photo_url
          ? `<img src="${escapeHtml(pet.photo_url)}" alt="${escapeHtml(pet.name)}" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover;">`
          : `<span style="font-size: 1.5rem;">${pet.species === 'Cat' ? '🐈' : '🐕'}</span>`;

        const certHtml = pet.vaccine_card_url
          ? `
            <img src="${escapeHtml(pet.vaccine_card_url)}" alt="Vaccine Certificate for ${escapeHtml(pet.name)}" class="vaccine-preview-img">
            <div style="margin-top: 6px; text-align: right;">
              <a href="${escapeHtml(pet.vaccine_card_url)}" target="_blank" rel="noopener" style="font-size: 0.78rem; color: var(--primary); font-weight: 600;">🔍 เปิดดูภาพขนาดเต็ม</a>
            </div>
          `
          : `<div style="margin-top: 8px; padding: 10px; background: #FEF3C7; color: #92400E; border-radius: 6px; font-size: 0.8rem;">⚠️ ยังไม่มีไฟล์สมุดวัคซีนในระบบสำหรับ ${escapeHtml(pet.name)}</div>`;

        return `
          <div class="vaccine-card-item">
            <div style="display: flex; align-items: center; gap: 10px;">
              ${avatarHtml}
              <div>
                <strong>${escapeHtml(pet.name)}</strong> (${escapeHtml(pet.breed || pet.species)} • ${Number(pet.weight_kg)} kg)
                <div style="font-size: 0.76rem; color: var(--text-muted);">Behavior: ${escapeHtml(pet.behavior_status)} ${pet.medical_notes ? '• ' + escapeHtml(pet.medical_notes) : ''}</div>
              </div>
            </div>
            ${certHtml}
          </div>
        `;
      })
      .join('');
  }

  function openVaccineModal(bookingId) {
    const booking = cachedBookingsById.get(Number(bookingId));
    if (!booking) return;

    document.getElementById('vaccineModalTitle').textContent =
      `📋 สมุดวัคซีน — Room #${booking.room_number} (${booking.owner_name})`;

    document.getElementById('vaccineModalBody').innerHTML = renderVaccinePetCards(booking.pets || []);
    document.getElementById('vaccineModal').style.display = 'flex';
  }

  function openRoomVaccineModal(roomId) {
    const room = cachedRoomsById.get(Number(roomId));
    if (!room || !room.active_stay) return;

    document.getElementById('vaccineModalTitle').textContent =
      `📋 สมุดวัคซีน — Room #${room.room_number} (${room.active_stay.owner_name})`;

    document.getElementById('vaccineModalBody').innerHTML = renderVaccinePetCards(room.active_stay.pets || []);
    document.getElementById('vaccineModal').style.display = 'flex';
  }

  function openSlipModal(bookingId) {
    const booking = cachedBookingsById.get(Number(bookingId));
    if (!booking || !booking.payment_slip_url) return;

    document.getElementById('vaccineModalTitle').textContent =
      `🧾 สลิปการโอนเงิน — Booking #${booking.booking_id} (Room #${booking.room_number})`;

    document.getElementById('vaccineModalBody').innerHTML = `
      <div class="vaccine-card-item">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <div>
            <strong>ลูกค้า:</strong> ${escapeHtml(booking.owner_name)}<br>
            <span style="font-size: 0.8rem; color: var(--text-muted);">ยอดที่ต้องชำระ: <strong>${Number(booking.total_price).toLocaleString()} THB</strong></span>
          </div>
          <span class="tag" style="background: #FEF3C7; color: #92400E; margin-top: 0;">${escapeHtml(booking.payment_status)}</span>
        </div>
        <img src="${escapeHtml(booking.payment_slip_url)}" alt="Payment Slip for Booking #${Number(booking.booking_id)}" class="vaccine-preview-img">
        <div style="margin-top: 6px; text-align: right;">
          <a href="${escapeHtml(booking.payment_slip_url)}" target="_blank" rel="noopener" style="font-size: 0.78rem; color: var(--primary); font-weight: 600;">🔍 เปิดดูภาพสลิปขนาดเต็ม</a>
        </div>
      </div>
    `;

    document.getElementById('vaccineModal').style.display = 'flex';
  }

  function closeVaccineModal() {
    document.getElementById('vaccineModal').style.display = 'none';
  }

  async function loadRoomsGrid() {
    const grid = document.getElementById('adminRoomGrid');
    const alertBanner = document.getElementById('safetyAlertBanner');
    const alertContent = document.getElementById('safetyAlertContent');

    try {
      const res = await apiFetch('/api/rooms');
      const rooms = await safeJson(res);
      if (!res.ok) throw new Error(rooms.error || 'Failed to load rooms');

      cachedRoomsById = new Map(rooms.map((r) => [Number(r.room_id), r]));
      const aggressiveAlerts = [];

      grid.innerHTML = rooms
        .map((room) => {
          const roomId = Number(room.room_id);
          const tier = formatRoomTier(room.room_type);
          const maxCap = Number(room.max_capacity);
          const stay = room.active_stay;
          const occupiedCount = Number(room.occupied_pets ?? (stay && stay.pets ? stay.pets.length : 0));
          const remainingCount = Math.max(0, maxCap - occupiedCount);

          if (stay && Array.isArray(stay.pets)) {
            for (const pet of stay.pets) {
              if (pet.behavior_status === 'Aggressive') {
                aggressiveAlerts.push(
                  `"${escapeHtml(pet.name)}" (${escapeHtml(pet.breed || 'Dog')}, Room ${escapeHtml(room.room_number)}) is flagged as <u>Aggressive</u>. Do not release into a yard with other dogs!`
                );
              }
            }
          }

          if (room.status === 'Maintenance') {
            return `
              <div class="room-card room-maintenance realtime-highlight">
                <div class="room-header">
                  <span>Room ${escapeHtml(room.room_number)} (${escapeHtml(tier)})</span>
                  <span class="room-status-tag">Cleaning</span>
                </div>
                <div>Sanitization in progress (Max ${maxCap} ตัว)</div>
                <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.75rem;">
                  <span>Base: ${Number(room.base_price_per_night).toLocaleString()} THB</span>
                  <button type="button" data-action="toggle-room" data-room-id="${roomId}" data-next-status="Available" style="padding: 2px 8px; font-size: 0.7rem; background: rgba(255,255,255,0.25); color: #FFF; border-radius: 4px;">Set Available</button>
                </div>
              </div>
            `;
          }

          if (room.status === 'Occupied') {
            const petNames =
              stay && stay.pets.length > 0
                ? stay.pets
                    .map((p) => `${escapeHtml(p.name)}${p.behavior_status === 'Aggressive' ? ' ⚠️' : ''}`)
                    .join(' & ')
                : 'Checked-in Guest';
            const dueOut = stay ? formatShortDate(stay.check_out_date) : 'Active';
            const vaccineQuickBtn = stay
              ? `<button type="button" data-action="view-room-vaccine" data-room-id="${roomId}" style="padding: 2px 7px; font-size: 0.68rem; background: rgba(255,255,255,0.25); color: #FFF; border-radius: 4px;">📋 สมุดวัคซีน</button>`
              : '';

            return `
              <div class="room-card room-occupied realtime-highlight">
                <div class="room-header">
                  <span>Room ${escapeHtml(room.room_number)} (${escapeHtml(tier)})</span>
                  <span class="room-status-tag">Occupied (เต็ม ${occupiedCount}/${maxCap})</span>
                </div>
                <div>
                  Pets: <strong>${petNames}</strong>
                  <div style="font-size: 0.74rem; opacity: 0.92;">เหลือรับเพิ่มได้: 0/${maxCap} ตัว</div>
                </div>
                <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.75rem;">
                  <span>Due Checkout: ${escapeHtml(dueOut)}</span>
                  ${vaccineQuickBtn}
                </div>
              </div>
            `;
          }

          // Partially occupied room: stays green ('Available') and shows remaining pet slots + checked-in pets!
          if (stay && occupiedCount > 0) {
            const petNames = stay.pets
              .map((p) => `${escapeHtml(p.name)}${p.behavior_status === 'Aggressive' ? ' ⚠️' : ''}`)
              .join(' & ');
            const dueOut = formatShortDate(stay.check_out_date);

            return `
              <div class="room-card room-available realtime-highlight">
                <div class="room-header">
                  <span>Room ${escapeHtml(room.room_number)} (${escapeHtml(tier)})</span>
                  <span class="room-status-tag">Available (เหลือ ${remainingCount}/${maxCap})</span>
                </div>
                <div>
                  Pets: <strong>${petNames}</strong>
                  <div style="font-size: 0.74rem; opacity: 0.95;">พักอยู่ ${occupiedCount}/${maxCap} • ว่างเพิ่มได้ ${remainingCount} ตัว (เจ้าของเดิม)</div>
                </div>
                <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.75rem;">
                  <span>Due Checkout: ${escapeHtml(dueOut)}</span>
                  <button type="button" data-action="view-room-vaccine" data-room-id="${roomId}" style="padding: 2px 7px; font-size: 0.68rem; background: rgba(0,0,0,0.2); color: #FFF; border-radius: 4px;">📋 สมุดวัคซีน</button>
                </div>
              </div>
            `;
          }

          return `
            <div class="room-card room-available realtime-highlight">
              <div class="room-header">
                <span>Room ${escapeHtml(room.room_number)} (${escapeHtml(tier)})</span>
                <span class="room-status-tag">Available (ว่าง ${maxCap}/${maxCap})</span>
              </div>
              <div>Ready for Guest (รับได้ ${maxCap} ตัว)</div>
              <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.75rem;">
                <span>Base: ${Number(room.base_price_per_night).toLocaleString()} THB/night</span>
                <button type="button" data-action="toggle-room" data-room-id="${roomId}" data-next-status="Maintenance" style="padding: 2px 8px; font-size: 0.7rem; background: rgba(0,0,0,0.18); color: #FFF; border-radius: 4px;">Cleaning</button>
              </div>
            </div>
          `;
        })
        .join('');

      if (aggressiveAlerts.length > 0) {
        alertContent.innerHTML = `<strong>HIGH-RISK BEHAVIOR :</strong> ${aggressiveAlerts.join(' | ')}`;
        alertBanner.style.display = 'flex';
      } else {
        alertBanner.style.display = 'none';
      }
    } catch (err) {
      if (err.message !== 'Unauthorized' && err.message !== 'Forbidden') {
        console.error('Failed to load room grid:', err);
        grid.innerHTML = `<div style="color: var(--danger);">${escapeHtml(err.message)}</div>`;
      }
    }
  }

  async function toggleRoomMaintenance(roomId, nextStatus, btnEl) {
    if (btnEl) btnEl.disabled = true;
    try {
      const res = await apiFetch(`/api/rooms/${Number(roomId)}/status`, {
        method: 'PUT',
        body: JSON.stringify({ status: nextStatus })
      });
      const data = await safeJson(res);
      if (!res.ok) {
        alert(data.error || 'Could not update room status.');
        return;
      }
      await loadRoomsGrid();
    } catch (err) {
      if (err.message !== 'Unauthorized' && err.message !== 'Forbidden') {
        alert('Error updating room status: ' + err.message);
      }
    } finally {
      if (btnEl) btnEl.disabled = false;
    }
  }

  function populatePetSelectorForSelectedStay() {
    const logStaySelect = document.getElementById('logStay');
    const logPetSelect = document.getElementById('logPet');
    const selectedBookingId = Number(logStaySelect.value);
    const previousPetId = logPetSelect.value;

    const booking = cachedBookingsById.get(selectedBookingId);
    if (!booking || !Array.isArray(booking.pets) || booking.pets.length === 0) {
      logPetSelect.innerHTML = '<option value="">No pets in selected stay</option>';
      return;
    }

    logPetSelect.innerHTML = booking.pets
      .map(
        (p) =>
          `<option value="${Number(p.pet_id)}">${escapeHtml(p.name)} (${escapeHtml(p.species)} • ${Number(p.weight_kg)} kg)</option>`
      )
      .join('');

    if (previousPetId && booking.pets.some((p) => String(p.pet_id) === String(previousPetId))) {
      logPetSelect.value = previousPetId;
    }
  }

  async function loadActiveBookings() {
    const logStaySelect = document.getElementById('logStay');
    const logPetSelect = document.getElementById('logPet');
    const tableBody = document.getElementById('departuresTableBody');
    const previousSelectedBooking = logStaySelect.value;

    try {
      const res = await apiFetch('/api/bookings');
      const bookings = await safeJson(res);
      if (!res.ok) throw new Error(bookings.error || 'Failed to load bookings');

      cachedBookingsById = new Map(bookings.map((b) => [Number(b.booking_id), b]));

      const confirmedStays = bookings.filter((b) => b.booking_status === 'Confirmed');
      const actionableBookings = bookings.filter(
        (b) => b.booking_status === 'Confirmed' || b.booking_status === 'Pending'
      );

      if (confirmedStays.length === 0) {
        logStaySelect.innerHTML = '<option value="">No active checked-in stays</option>';
        logPetSelect.innerHTML = '<option value="">No active checked-in stays</option>';
        document.getElementById('stayLogsFeed').innerHTML =
          '<div style="color: var(--text-muted);">No active stays selected.</div>';
      } else {
        logStaySelect.innerHTML = confirmedStays
          .map((b) => {
            const petNames = (b.pets || []).map((p) => p.name).join(' & ');
            return `<option value="${Number(b.booking_id)}">Room ${escapeHtml(b.room_number)} — ${escapeHtml(petNames)} (${escapeHtml(b.owner_name)})</option>`;
          })
          .join('');

        if (
          previousSelectedBooking &&
          confirmedStays.some((b) => String(b.booking_id) === String(previousSelectedBooking))
        ) {
          logStaySelect.value = previousSelectedBooking;
        }
        populatePetSelectorForSelectedStay();
        await loadStayLogs();
      }

      if (actionableBookings.length === 0) {
        tableBody.innerHTML =
          '<tr><td colspan="4" style="color: var(--text-muted); text-align: center;">No pending arrivals or active departures right now.</td></tr>';
        return;
      }

      tableBody.innerHTML = actionableBookings
        .map((b) => {
          const bId = Number(b.booking_id);
          const petDesc =
            (b.pets || []).length === 1
              ? `${escapeHtml(b.pets[0].name)} (${Number(b.pets[0].weight_kg)} kg)`
              : (b.pets || []).map((p) => escapeHtml(p.name)).join(' &amp; ');

          const hasAnyCert = (b.pets || []).some((p) => Boolean(p.vaccine_card_url));
          const slipBtnHtml = b.payment_slip_url
            ? `<button type="button" class="slip-btn" data-action="view-slip" data-booking-id="${bId}">🧾 ดูสลิป ✓</button>`
            : '';

          const docBtnsHtml = `
            <div style="margin-top: 4px; display: flex; gap: 4px; flex-wrap: wrap;">
              <button type="button" class="vaccine-btn" data-action="view-vaccine" data-booking-id="${bId}">
                📋 สมุดวัคซีน${hasAnyCert ? ' ✓' : ''}
              </button>
              ${slipBtnHtml}
            </div>
          `;

          if (b.booking_status === 'Pending') {
            const pendingTagLabel =
              b.payment_status === 'Pending_Verification' ? 'Slip Ready' : 'Pending';
            return `
              <tr class="realtime-highlight">
                <td>#${escapeHtml(b.room_number)} <span class="tag tag-anxious" style="margin-top:0;">${pendingTagLabel}</span></td>
                <td>${escapeHtml(b.owner_name)}</td>
                <td>${petDesc}${docBtnsHtml}</td>
                <td style="display: flex; gap: 6px;">
                  <button type="button" class="btn-primary btn-sm" data-action="approve-checkin" data-booking-id="${bId}">Check-In</button>
                  <button type="button" class="btn-danger btn-sm" data-action="cancel-stay" data-booking-id="${bId}">Cancel</button>
                </td>
              </tr>
            `;
          }

          return `
            <tr class="realtime-highlight">
              <td>#${escapeHtml(b.room_number)}</td>
              <td>${escapeHtml(b.owner_name)}</td>
              <td>${petDesc}${docBtnsHtml}</td>
              <td>
                <button type="button" class="btn-primary btn-sm" data-action="preview-checkout" data-booking-id="${bId}">Checkout</button>
              </td>
            </tr>
          `;
        })
        .join('');
    } catch (err) {
      if (err.message !== 'Unauthorized' && err.message !== 'Forbidden') {
        console.error('Failed to load bookings:', err);
        tableBody.innerHTML = `<tr><td colspan="4" style="color: var(--danger);">${escapeHtml(err.message)}</td></tr>`;
      }
    }
  }

  async function approveAndCheckIn(bookingId, btnEl) {
    if (btnEl) btnEl.disabled = true;
    try {
      const res = await apiFetch('/api/payments/confirm', {
        method: 'POST',
        body: JSON.stringify({ booking_id: Number(bookingId) })
      });
      const data = await safeJson(res);
      if (!res.ok) {
        alert(data.error || 'Failed to confirm check-in.');
        return;
      }
      await refreshDashboard();
    } catch (err) {
      if (err.message !== 'Unauthorized' && err.message !== 'Forbidden') {
        alert('Error confirming check-in: ' + err.message);
      }
    } finally {
      if (btnEl) btnEl.disabled = false;
    }
  }

  async function updateStayStatus(bookingId, newStatus, btnEl) {
    if (btnEl) btnEl.disabled = true;
    try {
      const res = await apiFetch(`/api/bookings/${Number(bookingId)}/status`, {
        method: 'PUT',
        body: JSON.stringify({ status: newStatus })
      });
      const data = await safeJson(res);
      if (!res.ok) {
        alert(data.error || 'Failed to update booking status.');
        return;
      }
      await refreshDashboard();
    } catch (err) {
      if (err.message !== 'Unauthorized' && err.message !== 'Forbidden') {
        alert('Error updating status: ' + err.message);
      }
    } finally {
      if (btnEl) btnEl.disabled = false;
    }
  }

  async function loadStayLogs() {
    const bookingId = document.getElementById('logStay').value;
    const feed = document.getElementById('stayLogsFeed');
    if (!bookingId) {
      feed.innerHTML = '<div style="color: var(--text-muted);">Select an active stay to inspect logs.</div>';
      return;
    }

    try {
      const res = await apiFetch(`/api/logs/${encodeURIComponent(bookingId)}`);
      const logs = await safeJson(res);
      if (!res.ok || !Array.isArray(logs) || logs.length === 0) {
        feed.innerHTML = '<div style="color: var(--text-muted);">No routine care entries logged yet.</div>';
        return;
      }

      feed.innerHTML = logs
        .map(
          (log) => `
          <div class="realtime-highlight" style="display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px dashed var(--border);">
            <div>
              <strong>[${escapeHtml(log.activity_type)} — ${escapeHtml(log.pet_name)}]</strong> ${escapeHtml(log.details)}
            </div>
            <button type="button" class="btn-danger btn-sm" data-action="delete-log" data-log-id="${Number(log.log_id)}" style="padding: 2px 7px; font-size: 0.7rem;">✕</button>
          </div>
        `
        )
        .join('');
    } catch (err) {
      console.error('Error loading stay logs:', err);
    }
  }

  async function submitCareLog(e) {
    e.preventDefault();
    const bookingId = Number(document.getElementById('logStay').value);
    const petId = Number(document.getElementById('logPet').value);
    const activityType = document.getElementById('logType').value;
    const details = document.getElementById('logDetails').value.trim();

    if (!bookingId) {
      alert('Please select an active stay first.');
      return;
    }

    const submitBtn = document.getElementById('submitCareLogBtn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Recording...';

    try {
      const res = await apiFetch('/api/logs', {
        method: 'POST',
        body: JSON.stringify({
          booking_id: bookingId,
          pet_id: petId || undefined,
          activity_type: activityType,
          details
        })
      });
      const data = await safeJson(res);
      if (!res.ok) {
        alert(data.error || 'Failed to record care log.');
        return;
      }

      document.getElementById('logDetails').value = '';
      await loadStayLogs();
    } catch (err) {
      if (err.message !== 'Unauthorized' && err.message !== 'Forbidden') {
        alert('Error recording daily log: ' + err.message);
      }
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Record Daily Log';
    }
  }

  async function deleteCareLog(logId, btnEl) {
    if (!confirm('Remove this care log entry?')) return;
    if (btnEl) btnEl.disabled = true;

    try {
      const res = await apiFetch(`/api/logs/${Number(logId)}`, {
        method: 'DELETE'
      });
      const data = await safeJson(res);
      if (!res.ok) {
        alert(data.error || 'Failed to delete log entry.');
        return;
      }
      await loadStayLogs();
    } catch (err) {
      if (err.message !== 'Unauthorized' && err.message !== 'Forbidden') {
        alert('Error deleting care log: ' + err.message);
      }
    } finally {
      if (btnEl) btnEl.disabled = false;
    }
  }

  // Step 1: Non-mutating Invoice Preview
  async function openCheckoutPreview(bookingId, btnEl) {
    if (btnEl) btnEl.disabled = true;
    try {
      const res = await apiFetch(`/api/bookings/${Number(bookingId)}/invoice-preview`);
      const data = await safeJson(res);
      if (!res.ok) {
        alert(data.error || 'Could not load invoice preview.');
        return;
      }

      const inv = data.invoice || {};
      pendingCheckoutBookingId = Number(bookingId);

      document.getElementById('billPet').innerText = inv.guest_pets || `Booking #${bookingId}`;
      document.getElementById('billNights').innerText = inv.stay_nights || 1;
      document.getElementById('billRoomCharge').innerText = `${Number(inv.lodging_charge || 0).toLocaleString()} THB`;
      document.getElementById('billMultiPet').innerText = `${Number(inv.multi_pet_surcharge || 0).toLocaleString()} THB`;
      document.getElementById('billGrooming').innerText = `${Number(inv.grooming_fee || 0).toLocaleString()} THB`;
      document.getElementById('billTotal').innerText = `${Number(inv.total_price || 0).toLocaleString()} THB`;

      document.getElementById('receiptModal').style.display = 'flex';
    } catch (err) {
      if (err.message !== 'Unauthorized' && err.message !== 'Forbidden') {
        alert('Error previewing invoice: ' + err.message);
      }
    } finally {
      if (btnEl) btnEl.disabled = false;
    }
  }

  function closeReceipt() {
    pendingCheckoutBookingId = null;
    document.getElementById('receiptModal').style.display = 'none';
  }

  // Step 2: Execute Stored Procedure sp_finalize_and_calculate_bill & release room
  async function completeCheckout() {
    if (!pendingCheckoutBookingId) return;
    const bookingId = pendingCheckoutBookingId;
    const btn = document.getElementById('completeCheckoutBtn');
    btn.disabled = true;
    btn.textContent = 'Finalizing...';

    try {
      const res = await apiFetch(`/api/bookings/${bookingId}/checkout`, {
        method: 'POST'
      });
      const data = await safeJson(res);
      if (!res.ok) {
        alert(data.error || 'Checkout Stored Procedure failed.');
        return;
      }

      const roomNum =
        (data.invoice && data.invoice.room_number) ||
        (data.room && data.room.room_number) ||
        '';
      closeReceipt();
      showToast(
        `🏁 Checkout finalized via sp_finalize_and_calculate_bill! Room #${roomNum} is now Available.`
      );
      await refreshDashboard();
    } catch (err) {
      if (err.message !== 'Unauthorized' && err.message !== 'Forbidden') {
        alert('Error executing checkout procedure: ' + err.message);
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Mark Paid & Release Room';
    }
  }

  async function refreshDashboard() {
    await Promise.all([loadRoomsGrid(), loadActiveBookings()]);
  }

  function bindEvents() {
    document.getElementById('logoutBtn').addEventListener('click', handleLogout);
    document.getElementById('closeVaccineModalBtn').addEventListener('click', closeVaccineModal);
    document.getElementById('closeReceiptBtn').addEventListener('click', closeReceipt);
    document.getElementById('completeCheckoutBtn').addEventListener('click', completeCheckout);

    document.getElementById('logStay').addEventListener('change', () => {
      populatePetSelectorForSelectedStay();
      loadStayLogs();
    });

    document.getElementById('careLogForm').addEventListener('submit', submitCareLog);

    // Event delegation for Room Grid
    document.getElementById('adminRoomGrid').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.getAttribute('data-action');
      if (action === 'view-vaccine') {
        openVaccineModal(Number(btn.getAttribute('data-booking-id')));
      } else if (action === 'view-room-vaccine') {
        openRoomVaccineModal(Number(btn.getAttribute('data-room-id')));
      } else if (action === 'toggle-room') {
        toggleRoomMaintenance(
          Number(btn.getAttribute('data-room-id')),
          btn.getAttribute('data-next-status'),
          btn
        );
      }
    });

    // Event delegation for Care Logs Feed
    document.getElementById('stayLogsFeed').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action="delete-log"]');
      if (btn) {
        deleteCareLog(Number(btn.getAttribute('data-log-id')), btn);
      }
    });

    // Event delegation for Departures & Billing Table
    document.getElementById('departuresTableBody').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const bookingId = Number(btn.getAttribute('data-booking-id'));
      const action = btn.getAttribute('data-action');

      if (action === 'view-vaccine') {
        openVaccineModal(bookingId);
      } else if (action === 'view-slip') {
        openSlipModal(bookingId);
      } else if (action === 'approve-checkin') {
        approveAndCheckIn(bookingId, btn);
      } else if (action === 'cancel-stay') {
        if (confirm(`Cancel Pending reservation #${bookingId}?`)) {
          updateStayStatus(bookingId, 'Cancelled', btn);
        }
      } else if (action === 'preview-checkout') {
        openCheckoutPreview(bookingId, btn);
      }
    });
  }

  async function initStaffDashboard() {
    bindEvents();
    const user = await verifyAuth();
    if (!user) return;
    initRealtimeSocket();
    await refreshDashboard();
  }

  document.addEventListener('DOMContentLoaded', initStaffDashboard);
})();

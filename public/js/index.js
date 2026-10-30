// public/js/index.js
(function () {
  const ALLOWED_ROLES = ['User', 'Admin', 'Developer'];
  const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  const MAX_UPLOAD_SIZE = 5 * 1024 * 1024;

  let currentUser = null;
  let ownerPets = [];
  let myCachedBookings = [];
  let isFirstPetLoad = true;
  let socket = null;
  let currentActiveBookingIds = [];
  let selectedRoomIsAddon = false;
  let selectedRoomMaxCapacity = 2;
  let toastTimer = null;

  function showToast(msg) {
    const el = document.getElementById('rtToast');
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.style.display = 'none';
    }, 4200);
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
    const isFormData = options.body instanceof FormData;
    const headers = {
      'X-Requested-With': 'PawStay-Client',
      ...(options.headers || {})
    };
    if (!isFormData && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(url, {
      ...options,
      credentials: 'include',
      headers
    });

    if (res.status === 401) {
      window.location.replace('login.html?reason=unauthorized');
      throw new Error('Unauthorized');
    }
    return res;
  }

  function formatLocalYMD(dateObj) {
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const d = String(dateObj.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function initBookingDateDefaults() {
    const checkInEl = document.getElementById('checkIn');
    const checkOutEl = document.getElementById('checkOut');
    const today = new Date();
    const checkOutDefault = new Date(today.getTime() + 3 * 86400000);
    const tomorrow = new Date(today.getTime() + 86400000);

    const todayStr = formatLocalYMD(today);
    checkInEl.min = todayStr;
    checkOutEl.min = formatLocalYMD(tomorrow);

    if (!checkInEl.value || checkInEl.value < todayStr) {
      checkInEl.value = todayStr;
    }
    if (!checkOutEl.value || checkOutEl.value <= checkInEl.value) {
      checkOutEl.value = formatLocalYMD(checkOutDefault);
    }
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

      currentUser = user;
      document.getElementById('currentUserName').textContent = `👤 ${user.name}`;
      const roleBadge = document.getElementById('currentUserRole');
      roleBadge.textContent = user.role;
      roleBadge.className =
        'role-badge' + (user.role === 'Admin' ? ' admin' : user.role === 'Developer' ? ' dev' : '');

      if (user.role === 'Admin' || user.role === 'Developer') {
        document.getElementById('navAdminLink').style.display = 'inline';
      }
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

    socket.on('connect', () => {
      for (const bId of currentActiveBookingIds) {
        socket.emit('join:booking', bId);
      }
    });

    socket.on('log:added', async (payload) => {
      showToast(
        `🐾 Live Care Update: New ${payload && payload.log ? payload.log.activity_type : 'care'} update posted!`
      );
      await loadBookingsAndTimeline(true);
    });

    socket.on('room:status_changed', async (payload) => {
      if (payload && payload.reason === 'checkout_completed') {
        showToast('🏁 Checkout finalized — stay invoice settled!');
      } else if (payload && payload.reason === 'booking_status_updated') {
        showToast(`🔔 Booking #${payload.booking_id} status changed to '${payload.booking_status}'`);
      }
      await loadBookingsAndTimeline(false);
      await filterRooms();
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

  function formatSuiteLabel(roomType) {
    if (roomType === 'Suite') return 'VIP Family Suite';
    if (roomType === 'Deluxe') return 'Deluxe Suite';
    return 'Standard Suite';
  }

  function formatShortDate(dtStr) {
    if (!dtStr) return '';
    const d = new Date(dtStr);
    if (Number.isNaN(d.getTime())) return dtStr;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function formatLogTime(dtStr) {
    if (!dtStr) return '';
    const d = new Date(dtStr);
    if (Number.isNaN(d.getTime())) return dtStr;
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function calculateNights() {
    const checkIn = document.getElementById('checkIn').value;
    const checkOut = document.getElementById('checkOut').value;
    if (!checkIn || !checkOut) return 1;
    const d1 = new Date(checkIn + 'T00:00:00Z');
    const d2 = new Date(checkOut + 'T00:00:00Z');
    const diffDays = Math.round((d2 - d1) / 86400000);
    return diffDays > 0 ? diffDays : 1;
  }

  function groomingFeeByWeight(weightKg) {
    const w = Number(weightKg);
    if (w < 8) return 500;
    if (w <= 20) return 800;
    return 1200;
  }

  function validateImageInput(fileInput, label, required = false) {
    if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
      if (required) {
        alert(`${label}: Please select a transfer slip image file (JPG, PNG, WEBP).`);
        return false;
      }
      return true;
    }
    const file = fileInput.files[0];
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
      alert(`${label}: Only JPG, JPEG, PNG, and WEBP image files are allowed.`);
      return false;
    }
    if (file.size > MAX_UPLOAD_SIZE) {
      alert(`${label}: File size exceeds 5MB limit.`);
      return false;
    }
    return true;
  }

  function openPetModal(pet = null) {
    const modal = document.getElementById('petModal');
    document.getElementById('modalPetPhoto').value = '';
    document.getElementById('modalVaccineCard').value = '';

    if (pet) {
      document.getElementById('petModalTitle').innerText = 'Edit Pet Profile';
      document.getElementById('editingPetId').value = pet.pet_id;
      document.getElementById('modalPetName').value = pet.name;
      document.getElementById('modalSpecies').value = pet.species;
      document.getElementById('modalBreed').value = pet.breed || '';
      document.getElementById('modalWeight').value = Number(pet.weight_kg);
      document.getElementById('modalBehavior').value = pet.behavior_status;
      document.getElementById('modalMedicalNotes').value = pet.medical_notes || '';
    } else {
      document.getElementById('petModalTitle').innerText = 'Add New Pet Profile';
      document.getElementById('editingPetId').value = '';
      document.getElementById('modalPetName').value = '';
      document.getElementById('modalSpecies').value = 'Dog';
      document.getElementById('modalBreed').value = '';
      document.getElementById('modalWeight').value = '';
      document.getElementById('modalBehavior').value = 'Friendly';
      document.getElementById('modalMedicalNotes').value = '';
    }
    modal.style.display = 'flex';
  }

  function closePetModal() {
    document.getElementById('petModal').style.display = 'none';
  }

  async function loadPets() {
    const previouslyChecked = new Set(
      Array.from(document.querySelectorAll('input[name="selectedPets"]:checked')).map((el) => Number(el.value))
    );

    try {
      const res = await apiFetch('/api/pets');
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data.error || 'Failed to load pets');

      ownerPets = data;
      const petList = document.getElementById('petList');
      const checkboxContainer = document.getElementById('petCheckboxList');

      if (ownerPets.length === 0) {
        petList.innerHTML =
          '<div style="color: var(--text-muted); font-size: 0.9rem;">No pets registered yet. Click "+ Add New Pet" to create one.</div>';
        checkboxContainer.innerHTML =
          '<span style="color: var(--text-muted); font-size: 0.85rem;">Register a pet above first.</span>';
        updateEstimatedCost();
        return;
      }

      petList.innerHTML = ownerPets
        .map((pet) => {
          const petId = Number(pet.pet_id);
          const fallbackEmoji = pet.species === 'Cat' ? '🐈' : '🐕';
          const avatarContent = pet.photo_url
            ? `<img src="${escapeHtml(pet.photo_url)}" alt="${escapeHtml(pet.name)}">`
            : fallbackEmoji;

          const safeBehaviorClass = ['friendly', 'aggressive', 'anxious', 'high-energy'].includes(
            String(pet.behavior_status).toLowerCase()
          )
            ? `tag-${String(pet.behavior_status).toLowerCase()}`
            : 'tag-friendly';

          const breedText = pet.breed ? escapeHtml(pet.breed) : escapeHtml(pet.species);
          const vaccineBadge = pet.vaccine_card_url
            ? `<a href="${escapeHtml(pet.vaccine_card_url)}" target="_blank" rel="noopener" class="tag" style="background: #E0E7FF; color: #3730A3; text-decoration: none; margin-left: 4px;">📋 Vaccine Card</a>`
            : '';
          const notesLine = pet.medical_notes
            ? `<div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 4px;">${escapeHtml(pet.medical_notes)}</div>`
            : '';

          return `
            <div class="pet-card">
              <div style="position: absolute; top: 10px; right: 10px; display: flex; gap: 4px;">
                <button type="button" class="btn-sm" data-action="edit-pet" data-pet-id="${petId}" style="padding: 3px 8px; font-size: 0.72rem; background: #E2E8F0; color: var(--text-main);">Edit</button>
                <button type="button" class="btn-danger btn-sm" data-action="delete-pet" data-pet-id="${petId}" style="padding: 3px 8px; font-size: 0.72rem;">Delete</button>
              </div>
              <div class="pet-avatar">${avatarContent}</div>
              <div class="pet-info" style="padding-right: 76px;">
                <h4>${escapeHtml(pet.name)}</h4>
                <div class="pet-meta">${breedText} • ${Number(pet.weight_kg)} kg</div>
                <div>
                  <span class="tag ${safeBehaviorClass}">${escapeHtml(pet.behavior_status)}</span>
                  ${vaccineBadge}
                </div>
                ${notesLine}
              </div>
            </div>
          `;
        })
        .join('');

      checkboxContainer.innerHTML = ownerPets
        .map((pet, idx) => {
          const petId = Number(pet.pet_id);
          const shouldCheck = isFirstPetLoad ? idx < 2 : previouslyChecked.has(petId);
          return `
            <label style="display: inline-flex; align-items: center; gap: 6px; cursor: pointer;">
              <input type="checkbox" name="selectedPets" value="${petId}" data-weight="${Number(pet.weight_kg)}" ${shouldCheck ? 'checked' : ''} style="width: auto; margin: 0;">
              ${escapeHtml(pet.name)} (${Number(pet.weight_kg)} kg)
            </label>
          `;
        })
        .join('');

      isFirstPetLoad = false;
      syncPetCheckboxAvailability();
      updateEstimatedCost();
    } catch (err) {
      console.error('Error loading pets:', err);
    }
  }

  function toYmdPart(dtVal) {
    if (!dtVal) return '';
    const d = new Date(dtVal);
    if (!Number.isNaN(d.getTime())) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
    return String(dtVal).slice(0, 10);
  }

  function syncPetCheckboxAvailability() {
    const checkIn = document.getElementById('checkIn').value;
    const checkOut = document.getElementById('checkOut').value;
    const bookedPetIds = new Set();

    if (checkIn && checkOut && checkOut > checkIn) {
      for (const b of myCachedBookings) {
        if (b.booking_status !== 'Pending' && b.booking_status !== 'Confirmed') continue;
        const bIn = toYmdPart(b.check_in_date);
        const bOut = toYmdPart(b.check_out_date);
        if (bIn < checkOut && bOut > checkIn) {
          for (const p of b.pets || []) {
            bookedPetIds.add(Number(p.pet_id));
          }
        }
      }
    }

    const checkboxes = Array.from(document.querySelectorAll('input[name="selectedPets"]'));
    let anyChecked = false;

    for (const cb of checkboxes) {
      const pId = Number(cb.value);
      const labelEl = cb.closest('label');
      let noteEl = labelEl ? labelEl.querySelector('.pet-booked-note') : null;

      if (bookedPetIds.has(pId)) {
        cb.checked = false;
        cb.disabled = true;
        if (labelEl) labelEl.style.opacity = '0.55';
        if (labelEl && !noteEl) {
          noteEl = document.createElement('small');
          noteEl.className = 'pet-booked-note';
          noteEl.style.color = 'var(--text-muted)';
          noteEl.textContent = '(Already Booked)';
          labelEl.appendChild(noteEl);
        }
      } else {
        cb.disabled = false;
        if (labelEl) labelEl.style.opacity = '1';
        if (noteEl) noteEl.remove();
        if (cb.checked) anyChecked = true;
      }
    }

    // Auto-select the first unbooked pet if all previously checked pets were already booked
    if (!anyChecked) {
      const firstAvailable = checkboxes.find((cb) => !cb.disabled);
      if (firstAvailable) {
        firstAvailable.checked = true;
      }
    }
  }

  async function savePet(e) {
    e.preventDefault();
    const photoInput = document.getElementById('modalPetPhoto');
    const vaccineInput = document.getElementById('modalVaccineCard');

    if (
      !validateImageInput(photoInput, 'Pet Avatar', false) ||
      !validateImageInput(vaccineInput, 'Vaccine Certificate', false)
    ) {
      return;
    }

    const editingId = document.getElementById('editingPetId').value;
    const formData = new FormData();
    formData.append('name', document.getElementById('modalPetName').value.trim());
    formData.append('species', document.getElementById('modalSpecies').value);
    formData.append('breed', document.getElementById('modalBreed').value.trim());
    formData.append('weight_kg', document.getElementById('modalWeight').value);
    formData.append('behavior_status', document.getElementById('modalBehavior').value);
    formData.append('medical_notes', document.getElementById('modalMedicalNotes').value.trim());

    if (photoInput.files && photoInput.files[0]) {
      formData.append('photo', photoInput.files[0]);
    }
    if (vaccineInput.files && vaccineInput.files[0]) {
      formData.append('vaccine_card', vaccineInput.files[0]);
    }

    const saveBtn = document.getElementById('savePetBtn');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    try {
      const url = editingId ? `/api/pets/${encodeURIComponent(editingId)}` : '/api/pets';
      const method = editingId ? 'PUT' : 'POST';

      const res = await apiFetch(url, {
        method,
        body: formData
      });
      const data = await safeJson(res);
      if (!res.ok) {
        alert(data.error || 'Failed to save pet profile.');
        return;
      }

      closePetModal();
      await loadPets();
    } catch (err) {
      if (err.message !== 'Unauthorized') {
        alert('Network error while saving pet: ' + err.message);
      }
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Pet';
    }
  }

  async function deletePet(petId) {
    const targetPet = ownerPets.find((p) => Number(p.pet_id) === Number(petId));
    const petName = targetPet ? targetPet.name : `#${petId}`;
    if (!confirm(`Remove pet profile "${petName}"?`)) return;

    try {
      const res = await apiFetch(`/api/pets/${Number(petId)}`, {
        method: 'DELETE'
      });
      const data = await safeJson(res);
      if (!res.ok) {
        alert(data.error || 'Could not delete pet profile.');
        return;
      }
      await loadPets();
    } catch (err) {
      if (err.message !== 'Unauthorized') {
        alert('Error deleting pet: ' + err.message);
      }
    }
  }

  function selectRoomCard(cardEl) {
    document.querySelectorAll('.room-select-card').forEach((card) => card.classList.remove('selected'));
    cardEl.classList.add('selected');

    const roomId = cardEl.getAttribute('data-room-id');
    const roomName = cardEl.getAttribute('data-room-name');
    const roomRate = cardEl.getAttribute('data-room-rate');
    const remainingCapacity = Number(cardEl.getAttribute('data-room-capacity')) || 1;
    const roomMax = Number(cardEl.getAttribute('data-room-max')) || remainingCapacity;
    const isAddon = cardEl.getAttribute('data-room-addon') === '1';

    selectedRoomIsAddon = isAddon;
    selectedRoomMaxCapacity = roomMax;

    document.getElementById('selectedRoomId').value = roomId;
    document.getElementById('selectedRoomRate').value = roomRate;
    document.getElementById('selectedRoomName').value = roomName;
    document.getElementById('selectedRoomCapacity').value = remainingCapacity;
    document.getElementById('selectedRoomDisplay').innerText = isAddon
      ? `${roomName} — Add-on to Your Suite (${remainingCapacity}/${roomMax} slot${remainingCapacity > 1 ? 's' : ''} left)`
      : `${roomName} — ${remainingCapacity}/${roomMax} pet slot${remainingCapacity > 1 ? 's' : ''} available`;

    updateEstimatedCost();
  }

  function updateEstimatedCost() {
    const roomRate = Number(document.getElementById('selectedRoomRate').value) || 0;
    const nights = calculateNights();
    const checkedPetInputs = Array.from(document.querySelectorAll('input[name="selectedPets"]:checked'));
    const selectedCount = checkedPetInputs.length;
    const grooming = document.getElementById('groomingToggle').checked;

    let total = 0;
    if (selectedRoomIsAddon) {
      total = selectedCount * 300 * nights;
    } else {
      total = roomRate * nights;
      if (selectedCount > 1) {
        total += (selectedCount - 1) * 300 * nights;
      }
    }

    if (grooming) {
      for (const checkbox of checkedPetInputs) {
        total += groomingFeeByWeight(checkbox.dataset.weight || 10);
      }
    }

    document.getElementById('pricePreview').innerText = total.toLocaleString();
    document.getElementById('priceNote').innerText = selectedRoomIsAddon
      ? `*Add-on pet rate for your reserved suite (${nights} night${nights > 1 ? 's' : ''} × 300 THB/pet + weight-tiered grooming)`
      : `*Includes ${nights} night${nights > 1 ? 's' : ''} stay + extra pet fee + weight-tiered grooming`;
  }

  async function filterRooms() {
    const checkIn = document.getElementById('checkIn').value;
    const checkOut = document.getElementById('checkOut').value;
    const roomGrid = document.getElementById('roomGrid');

    if (!checkIn || !checkOut || checkOut <= checkIn) {
      roomGrid.innerHTML =
        '<div style="grid-column: 1 / -1; color: var(--danger); font-size: 0.85rem;">Check-out date must be after check-in date.</div>';
      updateEstimatedCost();
      return;
    }

    syncPetCheckboxAvailability();

    try {
      const queryStr = `check_in=${encodeURIComponent(checkIn)}&check_out=${encodeURIComponent(checkOut)}`;
      const [allRes, availRes] = await Promise.all([
        apiFetch(`/api/rooms?${queryStr}`),
        apiFetch(`/api/rooms/available?${queryStr}`)
      ]);

      const allRooms = await safeJson(allRes);
      const availableRooms = await safeJson(availRes);
      if (!allRes.ok || !availRes.ok) {
        throw new Error(
          (allRooms && allRooms.error) || (availableRooms && availableRooms.error) || 'Failed to load rooms'
        );
      }

      const availByRoomId = new Map(availableRooms.map((r) => [r.room_id, r]));
      const previousRoomId = Number(document.getElementById('selectedRoomId').value);
      const chosenRoom = availableRooms.find((r) => r.room_id === previousRoomId) || availableRooms[0] || null;

      roomGrid.innerHTML = allRooms
        .map((room) => {
          const availInfo = availByRoomId.get(room.room_id) || null;
          const isMaintenance = room.status === 'Maintenance';
          const isSelected = chosenRoom && chosenRoom.room_id === room.room_id;
          const displayType = room.room_type === 'Suite' ? 'VIP' : room.room_type;
          const roomLabel = `Room ${room.room_number} (${displayType})`;
          const priceFormatted = Number(room.base_price_per_night).toLocaleString();
          const maxCap = Number(room.max_capacity);
          const myOcc = Number(room.my_occupied_pets || 0);

          if (!availInfo) {
            let badgeHtml = '<span class="badge-status badge-occupied">🔴 Occupied</span>';
            let slotSubtext = `${escapeHtml(formatSuiteLabel(room.room_type))} (Max ${maxCap})`;

            if (isMaintenance) {
              badgeHtml = '<span class="badge-status badge-maintenance">🛠️ Maintenance</span>';
            } else if (myOcc >= maxCap) {
              badgeHtml = `<span class="badge-status badge-occupied">🔴 Occupied (Full ${maxCap}/${maxCap})</span>`;
              slotSubtext = `${escapeHtml(formatSuiteLabel(room.room_type))} (0/${maxCap} slots left)`;
            }

            return `
              <div class="room-select-card disabled">
                <strong style="display:block;">Room ${escapeHtml(room.room_number)}</strong>
                <small style="color: var(--text-muted);">${slotSubtext}</small>
                <div>${priceFormatted} THB/night</div>
                ${badgeHtml}
              </div>
            `;
          }

          const remCap = Number(availInfo.remaining_capacity);
          const occPets = Number(availInfo.occupied_pets || 0);
          const isAddon = Boolean(availInfo.is_owner_addon);

          const slotText = isAddon
            ? `${escapeHtml(formatSuiteLabel(room.room_type))} (${occPets}/${maxCap} in room • ${remCap} left)`
            : `${escapeHtml(formatSuiteLabel(room.room_type))} (${remCap}/${maxCap} slots open)`;

          const priceDisplay = isAddon
            ? '+300 THB/night/pet'
            : `${priceFormatted} THB/night`;

          const availBadgeText = isAddon
            ? `🟢 Available (${remCap}/${maxCap} left)`
            : `🟢 Available (${remCap}/${maxCap} open)`;

          return `
            <div class="room-select-card ${isSelected ? 'selected' : ''}"
                 data-room-id="${Number(room.room_id)}"
                 data-room-name="${escapeHtml(roomLabel)}"
                 data-room-rate="${Number(room.base_price_per_night)}"
                 data-room-capacity="${remCap}"
                 data-room-max="${maxCap}"
                 data-room-addon="${isAddon ? '1' : '0'}">
              <strong style="display:block;">Room ${escapeHtml(room.room_number)}</strong>
              <small style="color: var(--text-muted);">${slotText}</small>
              <div>${priceDisplay}</div>
              <span class="badge-status badge-available">${availBadgeText}</span>
            </div>
          `;
        })
        .join('');

      if (chosenRoom) {
        const displayType = chosenRoom.room_type === 'Suite' ? 'VIP' : chosenRoom.room_type;
        const label = `Room ${chosenRoom.room_number} (${displayType})`;
        const remCap = Number(chosenRoom.remaining_capacity);
        const maxCap = Number(chosenRoom.max_capacity);
        const isAddon = Boolean(chosenRoom.is_owner_addon);

        selectedRoomIsAddon = isAddon;
        selectedRoomMaxCapacity = maxCap;

        document.getElementById('selectedRoomId').value = chosenRoom.room_id;
        document.getElementById('selectedRoomRate').value = Number(chosenRoom.base_price_per_night);
        document.getElementById('selectedRoomName').value = label;
        document.getElementById('selectedRoomCapacity').value = remCap;
        document.getElementById('selectedRoomDisplay').innerText = isAddon
          ? `${label} — Add-on to Your Suite (${remCap}/${maxCap} slot${remCap > 1 ? 's' : ''} left)`
          : `${label} — ${remCap}/${maxCap} pet slot${remCap > 1 ? 's' : ''} available`;
      } else {
        selectedRoomIsAddon = false;
        document.getElementById('selectedRoomId').value = '';
        document.getElementById('selectedRoomRate').value = 0;
        document.getElementById('selectedRoomDisplay').innerText = 'No rooms available for selected dates';
      }

      updateEstimatedCost();
    } catch (err) {
      console.error('Error filtering rooms:', err);
    }
  }

  async function openPaymentModal(bookingId) {
    try {
      const res = await apiFetch('/api/payments/generate-qr', {
        method: 'POST',
        body: JSON.stringify({ booking_id: Number(bookingId) })
      });
      const data = await safeJson(res);
      if (!res.ok) {
        alert(data.error || 'Could not generate PromptPay QR code.');
        return;
      }

      document.getElementById('activePaymentBookingId').value = data.booking_id;
      document.getElementById('qrCodeImg').src = data.qr_data_url;
      document.getElementById('qrPromptPayId').textContent = data.promptpay_id;
      document.getElementById('qrBookingLabel').textContent = `#${data.booking_id}`;
      document.getElementById('qrRoomLabel').textContent = `#${data.room_number} (${data.room_type})`;
      document.getElementById('qrAmountDisplay').textContent = Number(data.amount).toLocaleString();
      document.getElementById('paymentSlipInput').value = '';

      const existingNotice = document.getElementById('existingSlipNotice');
      if (data.payment_slip_url) {
        existingNotice.style.display = 'block';
        existingNotice.innerHTML = `✓ Slip uploaded (<a href="${escapeHtml(data.payment_slip_url)}" target="_blank" rel="noopener" style="color: var(--primary); font-weight: 700;">View Current Slip</a>) — upload a new image to replace`;
      } else {
        existingNotice.style.display = 'none';
        existingNotice.textContent = '';
      }

      const confirmBtn = document.getElementById('confirmPaidBtn');
      if (currentUser && (currentUser.role === 'Admin' || currentUser.role === 'Developer')) {
        confirmBtn.textContent = '✅ Approve Payment Immediately (Staff Override)';
      } else {
        confirmBtn.textContent = '✅ Submit Transfer Slip';
      }

      document.getElementById('paymentModal').style.display = 'flex';
    } catch (err) {
      if (err.message !== 'Unauthorized') {
        alert('Error generating PromptPay QR: ' + err.message);
      }
    }
  }

  function closePaymentModal() {
    document.getElementById('paymentModal').style.display = 'none';
  }

  async function confirmPromptPayPayment() {
    const bookingId = Number(document.getElementById('activePaymentBookingId').value);
    if (!bookingId) return;

    const slipInput = document.getElementById('paymentSlipInput');
    const isStaff = currentUser && (currentUser.role === 'Admin' || currentUser.role === 'Developer');

    if (!validateImageInput(slipInput, 'Payment Slip', !isStaff)) {
      return;
    }

    const formData = new FormData();
    formData.append('booking_id', String(bookingId));
    if (slipInput.files && slipInput.files[0]) {
      formData.append('slip', slipInput.files[0]);
    }

    const btn = document.getElementById('confirmPaidBtn');
    const prevLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Submitting Payment...';

    try {
      const res = await apiFetch('/api/payments/confirm', {
        method: 'POST',
        body: formData
      });
      const data = await safeJson(res);
      if (!res.ok) {
        alert(data.error || 'Payment submission failed.');
        return;
      }

      closePaymentModal();
      showToast(data.message || `✅ Payment slip submitted for Booking #${bookingId}`);
      await loadBookingsAndTimeline(true);
      await filterRooms();
    } catch (err) {
      if (err.message !== 'Unauthorized') {
        alert('Error confirming payment: ' + err.message);
      }
    } finally {
      btn.disabled = false;
      btn.textContent = prevLabel;
    }
  }

  async function handleBooking(e) {
    e.preventDefault();
    const roomId = Number(document.getElementById('selectedRoomId').value);
    const maxCapacity = Number(document.getElementById('selectedRoomCapacity').value) || 1;
    const checkIn = document.getElementById('checkIn').value;
    const checkOut = document.getElementById('checkOut').value;
    const hasGrooming = document.getElementById('groomingToggle').checked;
    const petIds = Array.from(document.querySelectorAll('input[name="selectedPets"]:checked')).map((el) =>
      Number(el.value)
    );

    if (!roomId) {
      alert('Please select an available room first.');
      return;
    }
    if (petIds.length === 0) {
      alert('Please select at least one pet for this reservation.');
      return;
    }
    if (petIds.length > maxCapacity) {
      alert(
        selectedRoomIsAddon
          ? `This suite has ${maxCapacity} remaining pet slot(s) out of ${selectedRoomMaxCapacity} for these dates. Please select at most ${maxCapacity} pet(s).`
          : `Selected suite accommodates at most ${maxCapacity} pet(s). Please select fewer pets or choose a larger suite.`
      );
      return;
    }

    const submitBtn = document.getElementById('bookingSubmitBtn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating Reservation...';

    try {
      const res = await apiFetch('/api/bookings', {
        method: 'POST',
        body: JSON.stringify({
          room_id: roomId,
          check_in_date: checkIn,
          check_out_date: checkOut,
          pet_ids: petIds,
          has_grooming: hasGrooming
        })
      });

      const data = await safeJson(res);
      if (!res.ok) {
        alert(data.error || 'Reservation failed.');
        return;
      }

      await loadBookingsAndTimeline(false);
      await filterRooms();
      await openPaymentModal(data.booking.booking_id);
    } catch (err) {
      if (err.message !== 'Unauthorized') {
        alert('Network error submitting reservation: ' + err.message);
      }
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Confirm Reservation & Pay via PromptPay';
    }
  }

  async function cancelReservation(bookingId, triggerBtn) {
    if (!confirm(`Cancel upcoming Pending reservation #${bookingId}?`)) return;
    if (triggerBtn) triggerBtn.disabled = true;

    try {
      const res = await apiFetch(`/api/bookings/${Number(bookingId)}/status`, {
        method: 'PUT',
        body: JSON.stringify({ status: 'Cancelled' })
      });
      const data = await safeJson(res);
      if (!res.ok) {
        alert(data.error || 'Could not cancel reservation.');
        return;
      }
      await loadBookingsAndTimeline(false);
      await filterRooms();
    } catch (err) {
      if (err.message !== 'Unauthorized') {
        alert('Error cancelling reservation: ' + err.message);
      }
    } finally {
      if (triggerBtn) triggerBtn.disabled = false;
    }
  }

  async function loadBookingsAndTimeline(animateFirst = false) {
    const banner = document.getElementById('activeStayBanner');
    const pendingList = document.getElementById('pendingStaysList');
    const timeline = document.getElementById('careTimeline');

    try {
      const res = await apiFetch('/api/bookings/my');
      const bookings = await safeJson(res);
      if (!res.ok) throw new Error(bookings.error || 'Failed to load bookings');

      myCachedBookings = Array.isArray(bookings) ? bookings : [];
      syncPetCheckboxAvailability();
      updateEstimatedCost();

      const confirmedStays = myCachedBookings.filter((b) => b.booking_status === 'Confirmed');
      const targetStays =
        confirmedStays.length > 0
          ? confirmedStays
          : myCachedBookings.filter((b) => b.booking_status === 'Completed').slice(0, 1);
      const pendingStays = myCachedBookings.filter((b) => b.booking_status === 'Pending');

      if (pendingStays.length > 0) {
        pendingList.innerHTML = pendingStays
          .map((b) => {
            const bId = Number(b.booking_id);
            const petNames = (b.pets || []).map((p) => p.name).join(' & ') || 'Pets';
            const isPendingVerify = b.payment_status === 'Pending_Verification';
            const payBadge = isPendingVerify
              ? `<span class="tag" style="background: #FEF3C7; color: #92400E; margin-top: 2px;">⏳ Pending Staff Slip Verification</span>`
              : '';
            const slipLink = b.payment_slip_url
              ? ` • <a href="${escapeHtml(b.payment_slip_url)}" target="_blank" rel="noopener" style="color: var(--primary); font-weight: 600;">View Slip</a>`
              : '';
            const payBtnLabel = isPendingVerify ? '🧾 Update Slip' : '💳 Pay QR';

            return `
              <div class="realtime-highlight" style="display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 8px 10px; margin-bottom: 8px; background: #F8FAFC; border: 1px solid var(--border); border-radius: 8px; font-size: 0.82rem;">
                <div>
                  <strong>Pending Reservation #${bId}:</strong> Room #${escapeHtml(b.room_number)} (${escapeHtml(petNames)})
                  <div style="color: var(--text-muted); font-size: 0.76rem;">${escapeHtml(formatShortDate(b.check_in_date))} → ${escapeHtml(formatShortDate(b.check_out_date))} • ${Number(b.total_price).toLocaleString()} THB${slipLink}</div>
                  ${payBadge}
                </div>
                <div style="display: flex; gap: 6px; flex-shrink: 0;">
                  <button type="button" class="btn-primary btn-sm" data-action="pay-qr" data-booking-id="${bId}">${payBtnLabel}</button>
                  <button type="button" class="btn-danger btn-sm" data-action="cancel-booking" data-booking-id="${bId}">Cancel</button>
                </div>
              </div>
            `;
          })
          .join('');
      } else {
        pendingList.innerHTML = '';
      }

      if (targetStays.length === 0) {
        currentActiveBookingIds = [];
        banner.innerHTML =
          '<strong>No Active Checked-In Stay</strong><div style="font-size: 0.8rem; color: #92400E;">Scan PromptPay QR, upload your transfer slip, and await staff check-in to view live care updates.</div>';
        timeline.innerHTML =
          '<li class="timeline-item"><span class="timeline-dot"></span><div class="timeline-content" style="color: var(--text-muted);">No care activity logs recorded yet.</div></li>';
        return;
      }

      currentActiveBookingIds = targetStays.map((s) => Number(s.booking_id));
      if (socket && socket.connected) {
        for (const bId of currentActiveBookingIds) {
          socket.emit('join:booking', bId);
        }
      }

      // Group active stays by room so add-on bookings in the same suite appear unified
      const primaryStay = targetStays[0];
      const sameRoomStays = targetStays.filter((s) => Number(s.room_id) === Number(primaryStay.room_id));
      const allActivePetNames = [
        ...new Set(sameRoomStays.flatMap((s) => (s.pets || []).map((p) => p.name)))
      ].join(' & ');
      const suiteLabel = formatSuiteLabel(primaryStay.room_type);
      const statusLabel =
        primaryStay.booking_status === 'Confirmed' ? 'Current Active Stay' : 'Recent Completed Stay';

      banner.innerHTML = `
        <strong>${statusLabel}:</strong> ${escapeHtml(suiteLabel)} #${escapeHtml(primaryStay.room_number)} (${escapeHtml(allActivePetNames)})
        <div style="font-size: 0.8rem; color: #92400E;">Check-in: ${escapeHtml(formatShortDate(primaryStay.check_in_date))} • Due Checkout: ${escapeHtml(formatShortDate(primaryStay.check_out_date))}</div>
      `;

      const logResponses = await Promise.all(
        currentActiveBookingIds.map((bId) => apiFetch(`/api/logs/${bId}`).then((r) => safeJson(r).then((d) => ({ ok: r.ok, data: d }))))
      );

      const mergedLogs = [];
      for (const item of logResponses) {
        if (item.ok && Array.isArray(item.data)) {
          mergedLogs.push(...item.data);
        }
      }
      mergedLogs.sort((a, b) => new Date(b.log_time) - new Date(a.log_time));

      if (mergedLogs.length === 0) {
        timeline.innerHTML = `
          <li class="timeline-item">
            <span class="timeline-dot"></span>
            <div class="timeline-content" style="color: var(--text-muted);">No care logs posted for this stay yet.</div>
          </li>
        `;
        return;
      }

      timeline.innerHTML = mergedLogs
        .map(
          (log, idx) => `
          <li class="timeline-item ${animateFirst && idx === 0 ? 'realtime-highlight' : ''}">
            <span class="timeline-dot"></span>
            <span class="timeline-time">${escapeHtml(formatLogTime(log.log_time))}</span>
            <div class="timeline-content"><strong>[${escapeHtml(log.activity_type)} — ${escapeHtml(log.pet_name)}]</strong> ${escapeHtml(log.details)}</div>
          </li>
        `
        )
        .join('');
    } catch (err) {
      console.error('Error loading bookings/timeline:', err);
    }
  }

  function bindEvents() {
    document.getElementById('logoutBtn').addEventListener('click', handleLogout);
    document.getElementById('openPetModalBtn').addEventListener('click', () => openPetModal(null));
    document.getElementById('closePetModalBtn').addEventListener('click', closePetModal);
    document.getElementById('petForm').addEventListener('submit', savePet);

    document.getElementById('checkIn').addEventListener('change', () => {
      const checkInVal = document.getElementById('checkIn').value;
      const checkOutEl = document.getElementById('checkOut');
      if (checkInVal && checkOutEl.value <= checkInVal) {
        const nextDay = new Date(checkInVal + 'T00:00:00');
        nextDay.setDate(nextDay.getDate() + 1);
        checkOutEl.value = formatLocalYMD(nextDay);
      }
      filterRooms();
    });
    document.getElementById('checkOut').addEventListener('change', filterRooms);
    document.getElementById('groomingToggle').addEventListener('change', updateEstimatedCost);
    document.getElementById('bookingForm').addEventListener('submit', handleBooking);

    document.getElementById('confirmPaidBtn').addEventListener('click', confirmPromptPayPayment);
    document.getElementById('closePaymentModalBtn').addEventListener('click', closePaymentModal);

    // Event delegation for Pet Cards
    document.getElementById('petList').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const petId = Number(btn.getAttribute('data-pet-id'));
      const action = btn.getAttribute('data-action');
      if (action === 'edit-pet') {
        const pet = ownerPets.find((p) => Number(p.pet_id) === petId);
        if (pet) openPetModal(pet);
      } else if (action === 'delete-pet') {
        deletePet(petId);
      }
    });

    // Event delegation for Multi-pet checkboxes
    document.getElementById('petCheckboxList').addEventListener('change', (e) => {
      if (e.target.matches('input[name="selectedPets"]')) {
        updateEstimatedCost();
      }
    });

    // Event delegation for Room Selector Cards
    document.getElementById('roomGrid').addEventListener('click', (e) => {
      const card = e.target.closest('.room-select-card[data-room-id]:not(.disabled)');
      if (card) selectRoomCard(card);
    });

    // Event delegation for Pending Stays actions
    document.getElementById('pendingStaysList').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const bookingId = Number(btn.getAttribute('data-booking-id'));
      const action = btn.getAttribute('data-action');
      if (action === 'pay-qr') {
        openPaymentModal(bookingId);
      } else if (action === 'cancel-booking') {
        cancelReservation(bookingId, btn);
      }
    });
  }

  async function initPortal() {
    initBookingDateDefaults();
    bindEvents();
    const user = await verifyAuth();
    if (!user) return;
    initRealtimeSocket();
    await loadPets();
    await loadBookingsAndTimeline(false);
    await filterRooms();
  }

  document.addEventListener('DOMContentLoaded', initPortal);
})();

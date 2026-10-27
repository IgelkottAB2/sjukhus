
(() => {
  const cfg = window.HOSPITAL_CONFIG || {};
  const configured =
    cfg.SUPABASE_URL &&
    cfg.SUPABASE_ANON_KEY &&
    !String(cfg.SUPABASE_URL).includes('DIN_SUPABASE') &&
    !String(cfg.SUPABASE_ANON_KEY).includes('DIN_SUPABASE');

  const $ = id => document.getElementById(id);

  let db = null;
  let currentUser = null;
  let profile = null;
  let queueTimer = null;
  let deskStream = null;
  let deskScanActive = false;

  const alertedQueues = new Set();

  const say = (id, msg, error = false) => {
    const el = $(id);
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    el.classList.toggle('error-text', error);
  };

  const clearSay = id => {
    const el = $(id);
    if (el) el.classList.add('hidden');
  };

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));

  const fmtDate = s =>
    s ? new Date(`${s}T12:00:00`).toLocaleDateString('sv-SE') : 'Ej angivet';

  function todayLocal() {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Stockholm',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date());

    const values = {};
    parts.forEach(part => values[part.type] = part.value);

    return `${values.year}-${values.month}-${values.day}`;
  }

  async function init() {
    if (!configured || !window.supabase) {
      say('authMessage',
        'Konfigurera config.js med Supabase Project URL och anon/public key först.',
        true
      );
      return;
    }

    db = window.supabase.createClient(
      cfg.SUPABASE_URL,
      cfg.SUPABASE_ANON_KEY
    );

    $('loginForm')?.addEventListener('submit', login);
    $('signupForm')?.addEventListener('submit', signup);

    document.querySelectorAll('[data-auth-tab]').forEach(button => {
      button.addEventListener('click', () => authTab(button.dataset.authTab));
    });

    $('logoutBtn')?.addEventListener('click', logout);

    document.querySelectorAll('[data-view]').forEach(button => {
      button.addEventListener('click', () => showView(button.dataset.view));
    });

    document.querySelectorAll('[data-open-view]').forEach(button => {
      button.addEventListener('click', () => showView(button.dataset.openView));
    });

    document.querySelectorAll('[data-pharmacy-tab]').forEach(button => {
      button.addEventListener('click', () => pharmacyTab(button.dataset.pharmacyTab));
    });

    $('startDeskScan')?.addEventListener('click', startDeskScan);
    $('refreshVaccine')?.addEventListener('click', loadVaccines);
    $('vaccineBookingForm')?.addEventListener('submit', bookVaccine);

    const { data, error } = await db.auth.getSession();

    if (error) {
      say('authMessage', 'Kunde inte kontrollera inloggningen: ' + error.message, true);
      return;
    }

    if (data.session) await loadUser(data.session.user);

    db.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        loadUser(session.user);
      } else {
        resetUI();
      }
    });
  }

  function authTab(which) {
    document.querySelectorAll('[data-auth-tab]').forEach(button => {
      button.classList.toggle('active', button.dataset.authTab === which);
    });

    $('loginForm').classList.toggle('hidden', which !== 'login');
    $('signupForm').classList.toggle('hidden', which !== 'signup');
    clearSay('authMessage');
  }

  async function login(event) {
    event.preventDefault();

    const form = new FormData(event.currentTarget);

    const { error } = await db.auth.signInWithPassword({
      email: form.get('email'),
      password: form.get('password')
    });

    if (error) {
      say('authMessage', error.message, true);
    } else {
      clearSay('authMessage');
    }
  }

  async function signup(event) {
    event.preventDefault();

    const form = new FormData(event.currentTarget);

    const { data, error } = await db.auth.signUp({
      email: form.get('email'),
      password: form.get('password'),
      options: {
        data: {
          full_name: form.get('full_name')
        }
      }
    });

    if (error) {
      return say('authMessage', error.message, true);
    }

    if (!data.session) {
      say(
        'authMessage',
        'Kontot skapades. Kontrollera e-posten om Supabase kräver e-postbekräftelse. Logga sedan in.'
      );
    } else {
      say('authMessage', 'Kontot skapades.');
    }
  }

  async function logout() {
    if (db) await db.auth.signOut();
    resetUI();
  }

  async function loadUser(user) {
    currentUser = user;

    const { data, error } = await db
      .from('profiles')
      .select('full_name,role')
      .eq('id', user.id)
      .maybeSingle();

    if (error) {
      say('globalMessage', 'Profilen kunde inte laddas: ' + error.message, true);
      return;
    }

    profile = data;

    if (profile?.role && profile.role !== 'patient') {
      location.href = 'staff.html';
      return;
    }

    $('authPanel').classList.add('hidden');
    $('appPanel').classList.remove('hidden');
    $('logoutBtn').classList.remove('hidden');

    $('signedInAs').textContent = user.email || '';
    $('customerName').textContent =
      profile?.full_name || user.user_metadata?.full_name || 'välkommen';

    await Promise.all([
      loadQueue(),
      loadVaccines(),
      loadPharmacy()
    ]);

    if (queueTimer) clearInterval(queueTimer);
    queueTimer = setInterval(loadQueue, 8000);
  }

  function resetUI() {
    currentUser = null;
    profile = null;

    if (queueTimer) clearInterval(queueTimer);
    queueTimer = null;

    stopDeskScan();

    $('authPanel')?.classList.remove('hidden');
    $('appPanel')?.classList.add('hidden');
    $('logoutBtn')?.classList.add('hidden');

    if ($('signedInAs')) $('signedInAs').textContent = '';
  }

  function showView(name) {
    document.querySelectorAll('.view').forEach(view => {
      view.classList.add('hidden');
    });

    $('view-' + name)?.classList.remove('hidden');

    document.querySelectorAll('[data-view]').forEach(button => {
      button.classList.toggle('active', button.dataset.view === name);
    });

    if (name === 'pharmacy') loadPharmacy();
    if (name === 'vaccine') loadVaccines();
    if (name === 'queue') loadQueue();
  }

  function pharmacyTab(which) {
    document.querySelectorAll('[data-pharmacy-tab]').forEach(button => {
      button.classList.toggle('active', button.dataset.pharmacyTab === which);
    });

    $('pharmacyReceipts').classList.toggle('hidden', which !== 'receipts');
    $('pharmacyPrescriptions').classList.toggle('hidden', which !== 'prescriptions');
  }

  async function loadQueue() {
    if (!db || !currentUser) return;

    const { data, error } = await db
      .from('queue_entries')
      .select('id,queue_number,queue_date,status,created_at,called_room')
      .eq('patient_id', currentUser.id)
      .in('status', ['waiting', 'called', 'serving'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      $('queueHelp').textContent =
        'Köstatus kunde inte laddas. Kontrollera tabeller och behörigheter i Supabase.';
      return;
    }

    if (!data) {
      $('queueTicket').classList.add('hidden');
      $('turnNotice').classList.add('hidden');
      $('queueHelp').textContent =
        'Ingen aktiv kölapp just nu. Skanna QR-koden vid informationsdisken för att ta en.';
      return;
    }

    $('queueTicket').classList.remove('hidden');
    $('queueNumber').textContent = `#${data.queue_number}`;

    if (data.status === 'called') {
      $('queueState').textContent = 'Du har blivit kallad fram';
    } else if (data.status === 'serving') {
      $('queueState').textContent = 'Du är hos personalen';
    } else {
      $('queueState').textContent = 'Väntar på informationsdisken';
    }

    const { data: aheadCount, error: aheadError } = await db.rpc(
      'queue_people_ahead',
      {
        p_queue_date: data.queue_date,
        p_queue_number: data.queue_number
      }
    );

    if (data.status === 'called' || data.status === 'serving') {
      $('queueAhead').textContent = '0 PERSONER FRAMFÖR DIG';
    } else if (aheadError) {
      $('queueAhead').textContent = 'KÖPLATSEN KUNDE INTE HÄMTAS';
    } else {
      $('queueAhead').textContent = `${aheadCount ?? 0} PERSONER FRAMFÖR DIG`;
    }

    if (data.called_room) {
      $('queueRoom').textContent = data.called_room;
      $('queueRoom').classList.remove('hidden');
    } else {
      $('queueRoom').classList.add('hidden');
      $('queueRoom').textContent = '';
    }

    const turn = data.status === 'called' || data.status === 'serving';
    $('turnNotice').classList.toggle('hidden', !turn);

    if (turn) notifyTurn(data.id);
  }

  function notifyTurn(id) {
    if (alertedQueues.has(id)) return;
    alertedQueues.add(id);

    try {
      if ('vibrate' in navigator) navigator.vibrate([90, 45, 90]);

      const AudioContextClass = window.AudioContext || window.webkitAudioContext;

      if (AudioContextClass) {
        const context = new AudioContextClass();
        const oscillator = context.createOscillator();
        const gain = context.createGain();

        oscillator.frequency.value = 740;
        gain.gain.value = 0.025;

        oscillator.connect(gain);
        gain.connect(context.destination);

        oscillator.start();
        oscillator.stop(context.currentTime + 0.13);
      }
    } catch (_) {}
  }

  async function startDeskScan() {
    if (!currentUser) {
      return say('deskScanStatus', 'Logga in först för att ta en kölapp.', true);
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      return say(
        'deskScanStatus',
        'Kameran stöds inte. Öppna sidan via HTTPS och kontrollera kameraåtkomst.',
        true
      );
    }

    if (!window.jsQR && !('BarcodeDetector' in window)) {
      return say(
        'deskScanStatus',
        'QR-biblioteket kunde inte laddas. Ladda om sidan och försök igen.',
        true
      );
    }

    stopDeskScan();

    try {
      deskStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false
      });

      deskScanActive = true;

      const video = $('deskVideo');
      const canvas = $('deskCanvas');

      video.srcObject = deskStream;
      video.classList.remove('hidden');

      await video.play();

      say(
        'deskScanStatus',
        'Rikta kameran mot QR-koden vid informationsdisken.'
      );

      const context = canvas.getContext('2d', { willReadFrequently: true });
      let detector = null;

      if (!window.jsQR && 'BarcodeDetector' in window) {
        try {
          detector = new BarcodeDetector({ formats: ['qr_code'] });
        } catch (_) {}
      }

      const scan = async () => {
        if (!deskScanActive || !deskStream) return;

        try {
          if (
            video.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA &&
            video.videoWidth > 0
          ) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;

            context.drawImage(video, 0, 0, canvas.width, canvas.height);

            let raw = null;

            if (window.jsQR) {
              const frame = context.getImageData(
                0, 0, canvas.width, canvas.height
              );

              const code = window.jsQR(
                frame.data,
                frame.width,
                frame.height,
                { inversionAttempts: 'dontInvert' }
              );

              if (code) raw = code.data;
            } else if (detector) {
              const codes = await detector.detect(video);
              if (codes.length) raw = codes[0].rawValue;
            }

            if (raw) {
              stopDeskScan();
              await joinQueue(raw);
              return;
            }
          }
        } catch (_) {}

        if (deskScanActive) requestAnimationFrame(scan);
      };

      requestAnimationFrame(scan);
    } catch (error) {
      stopDeskScan();

      say(
        'deskScanStatus',
        'Kunde inte starta kameran. Tillåt kameraåtkomst och använd HTTPS. ' +
          error.message,
        true
      );
    }
  }

  function stopDeskScan() {
    deskScanActive = false;

    if (deskStream) {
      deskStream.getTracks().forEach(track => track.stop());
    }

    deskStream = null;

    const video = $('deskVideo');

    if (video) {
      video.pause();
      video.srcObject = null;
      video.classList.add('hidden');
    }
  }

  async function joinQueue(raw) {
    let token;

    try {
      const parsed = JSON.parse(raw);
      token = parsed.desk_token;
    } catch (_) {
      token = raw;
    }

    if (!token) {
      return say(
        'deskScanStatus',
        'QR-koden saknar en disk-token. Skanna QR-koden från personalsidan.',
        true
      );
    }

    const { data: desk, error: deskError } = await db
      .from('desk_qr_tokens')
      .select('id,active')
      .eq('token', token)
      .eq('active', true)
      .maybeSingle();

    if (deskError || !desk) {
      return say(
        'deskScanStatus',
        'QR-koden är inte giltig eller har stängts av.',
        true
      );
    }

    const today = todayLocal();

    const { data: existing, error: existingError } = await db
      .from('queue_entries')
      .select('id,queue_number')
      .eq('patient_id', currentUser.id)
      .eq('queue_date', today)
      .in('status', ['waiting', 'called', 'serving'])
      .limit(1)
      .maybeSingle();

    if (existingError) {
      return say(
        'deskScanStatus',
        'Kunde inte kontrollera om du redan har en kölapp: ' +
          existingError.message,
        true
      );
    }

    if (existing) {
      await loadQueue();
      return say(
        'deskScanStatus',
        `Du har redan en aktiv kölapp i dag: #${existing.queue_number}.`
      );
    }

    const { data: row, error } = await db
      .from('queue_entries')
      .insert({
        patient_id: currentUser.id,
        queue_date: today,
        status: 'waiting',
        desk_token_id: desk.id
      })
      .select('id,queue_number')
      .single();

    if (error) {
      return say('deskScanStatus', 'Kölappen kunde inte skapas: ' + error.message, true);
    }

    await loadQueue();

    say(
      'deskScanStatus',
      `Din digitala kölapp är skapad: nummer ${row.queue_number}.`
    );
  }

  async function loadVaccines() {
    if (!db || !currentUser) return;

    const list = $('vaccineList');
    list.innerHTML = '<p class="muted">Laddar schema …</p>';

    const { data, error } = await db
      .from('vaccine_bookings')
      .select('id,vaccine_name,stop_name,appointment_date,appointment_time,status,qr_token')
      .eq('patient_id', currentUser.id)
      .order('appointment_date', { ascending: true });

    if (error) {
      list.innerHTML = '<p class="muted">Schemat kunde inte laddas. Kontrollera schema.sql.</p>';
      return;
    }

    if (!data?.length) {
      list.innerHTML = '<p class="muted">Du har varken bokat tid för eller tagit vaccinet.</p>';
      return;
    }

    list.innerHTML = '';

    data.forEach(booking => {
      const el = document.createElement('article');
      el.className = 'item-card';

      const details = document.createElement('div');

      details.innerHTML = `
        <h4>${esc(booking.vaccine_name)}</h4>
        <p>${esc(fmtDate(booking.appointment_date))} kl.
          ${esc(booking.appointment_time || '—')} · ${esc(booking.stop_name)}</p>
        <span class="status ${
          booking.status === 'booked' ? 'blue' :
          booking.status === 'completed' ? 'green' : 'amber'
        }">${
          booking.status === 'booked' ? 'BOKAD' :
          booking.status === 'completed' ? 'GENOMFÖRD' :
          esc(booking.status.toUpperCase())
        }</span>
      `;

      const actions = document.createElement('div');
      actions.className = 'item-actions';

      if (booking.status === 'booked' && booking.qr_token) {
        const button = document.createElement('button');
        button.className = 'button button-primary';
        button.textContent = 'FRAMME';
        button.addEventListener('click', () => showVaccineQr(booking));
        actions.append(button);
      }

      el.append(details, actions);
      list.append(el);
    });
  }

  function showVaccineQr(booking) {
    const modal = document.createElement('div');
    modal.className = 'modal-backdrop';

    modal.innerHTML = `
      <div class="modal-card">
        <button class="modal-close" aria-label="Stäng">×</button>
        <span class="eyebrow">VACCINBUSS · BOKNINGSKONTROLL</span>
        <h2>${esc(booking.vaccine_name)}</h2>
        <p>${esc(booking.stop_name)} · ${esc(fmtDate(booking.appointment_date))}
          kl. ${esc(booking.appointment_time)}</p>
        <div id="vaccineQr" class="qr-box"></div>
        <p class="small muted">Visa koden för vaccinpersonalens QR-läsare. Efter godkänd skanning försvinner QR-koden.</p>
        <button class="button button-outline modal-done">Stäng</button>
      </div>
    `;

    document.body.append(modal);

    const close = () => modal.remove();

    modal.querySelector('.modal-close').onclick = close;
    modal.querySelector('.modal-done').onclick = close;

    if (window.QRCode) {
      new QRCode(modal.querySelector('#vaccineQr'), {
        text: JSON.stringify({
          type: 'vaccine_booking',
          token: booking.qr_token
        }),
        width: 220,
        height: 220
      });
    } else {
      modal.querySelector('#vaccineQr').textContent =
        'QR-biblioteket kunde inte laddas.';
    }
  }

  async function bookVaccine(event) {
    event.preventDefault();

    const form = new FormData(event.currentTarget);
    const token = crypto.randomUUID();

    const { error } = await db.from('vaccine_bookings').insert({
      patient_id: currentUser.id,
      vaccine_name: form.get('vaccine_name'),
      stop_name: form.get('stop_name'),
      appointment_date: form.get('appointment_date'),
      appointment_time: form.get('appointment_time'),
      status: 'booked',
      qr_token: token
    });

    if (error) {
      return say('globalMessage', 'Bokningen misslyckades: ' + error.message, true);
    }

    event.currentTarget.reset();
    say('globalMessage', 'Testtiden är bokad. Den visas nu under SCHEMA.');
    await loadVaccines();
  }

  async function loadPharmacy() {
    if (!db || !currentUser) return;

    const receipts = $('pharmacyReceipts');
    const prescriptions = $('pharmacyPrescriptions');

    receipts.innerHTML = '<p class="muted">Laddar kvitton …</p>';
    prescriptions.innerHTML = '<p class="muted">Laddar recept …</p>';

    const [receiptResult, prescriptionResult] = await Promise.all([
      db.from('pharmacy_receipts')
        .select('id,medicine_name,return_code,dispensed_at')
        .eq('patient_id', currentUser.id)
        .order('dispensed_at', { ascending: false }),

      db.from('prescriptions')
        .select('id,medicine_name,valid_until,remaining_refills,qr_token,status')
        .eq('patient_id', currentUser.id)
        .eq('status', 'active')
        .order('created_at', { ascending: false })
    ]);

    receipts.innerHTML = '';

    if (receiptResult.error) {
      receipts.innerHTML = '<p class="muted">Kvitton kunde inte laddas.</p>';
    } else if (!receiptResult.data?.length) {
      receipts.innerHTML = '<p class="muted">Inga kvitton ännu.</p>';
    } else {
      receiptResult.data.forEach(receipt => {
        const el = document.createElement('article');
        el.className = 'item-card';

        el.innerHTML = `
          <div>
            <h4>${esc(receipt.medicine_name)}</h4>
            <p>Uthämtat ${
              esc(new Date(receipt.dispensed_at).toLocaleDateString('sv-SE'))
            }</p>
          </div>
          <div class="item-actions">
            <span class="status">RETURKOD</span>
            <b>${esc(receipt.return_code)}</b>
          </div>
        `;

        receipts.append(el);
      });
    }

    prescriptions.innerHTML = '';

    if (prescriptionResult.error) {
      prescriptions.innerHTML = '<p class="muted">Recept kunde inte laddas.</p>';
    } else if (!prescriptionResult.data?.length) {
      prescriptions.innerHTML = '<p class="muted">Inga aktuella recept.</p>';
    } else {
      prescriptionResult.data.forEach(prescription => {
        const el = document.createElement('article');
        el.className = 'item-card';

        el.innerHTML = `
          <div>
            <h4>${esc(prescription.medicine_name)}</h4>
            <p>Giltigt till ${esc(fmtDate(prescription.valid_until))} ·
              Återstående uttag: ${esc(prescription.remaining_refills)}</p>
          </div>
          <div class="item-actions">
            <span class="status green">AKTUELLT</span>
            <div class="qr-mini"></div>
          </div>
        `;

        prescriptions.append(el);

        const qrBox = el.querySelector('.qr-mini');

        if (prescription.qr_token && window.QRCode) {
          new QRCode(qrBox, {
            text: JSON.stringify({
              type: 'prescription',
              token: prescription.qr_token
            }),
            width: 110,
            height: 110
          });
        } else {
          qrBox.textContent = 'QR saknas';
        }
      });
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();

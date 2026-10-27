(() => {
  const cfg = window.HOSPITAL_CONFIG || {};
  const configured = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && !String(cfg.SUPABASE_URL).includes('DIN_SUPABASE') && !String(cfg.SUPABASE_ANON_KEY).includes('DIN_SUPABASE');
  const $ = (id) => document.getElementById(id);
  let db = null, currentUser = null, profile = null, queueTimer = null, activeQueue = null, deskStream = null;
  const say = (id, msg, error = false) => { const el = $(id); if (!el) return; el.textContent = msg; el.classList.remove('hidden'); el.classList.toggle('error-text', error); };
  const clearSay = (id) => { const el = $(id); if (el) el.classList.add('hidden'); };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmtDate = (s) => s ? new Date(`${s}T12:00:00`).toLocaleDateString('sv-SE') : 'Ej angivet';
  async function init() {
    if (!configured || !window.supabase) { say('authMessage', 'Konfigurera config.js med Supabase Project URL och anon/public key först.', true); return; }
    db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    $('loginForm')?.addEventListener('submit', login); $('signupForm')?.addEventListener('submit', signup);
    document.querySelectorAll('[data-auth-tab]').forEach(b => b.addEventListener('click', () => authTab(b.dataset.authTab)));
    $('logoutBtn')?.addEventListener('click', logout);
    document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
    document.querySelectorAll('[data-open-view]').forEach(b => b.addEventListener('click', () => showView(b.dataset.openView)));
    document.querySelectorAll('[data-pharmacy-tab]').forEach(b => b.addEventListener('click', () => pharmacyTab(b.dataset.pharmacyTab)));
    $('startDeskScan')?.addEventListener('click', startDeskScan); $('refreshVaccine')?.addEventListener('click', loadVaccines);
    $('vaccineBookingForm')?.addEventListener('submit', bookVaccine);
    const { data } = await db.auth.getSession(); if (data.session) await loadUser(data.session.user);
    db.auth.onAuthStateChange((_event, session) => { if (session?.user) loadUser(session.user); else resetUI(); });
  }
  function authTab(which) { document.querySelectorAll('[data-auth-tab]').forEach(b => b.classList.toggle('active', b.dataset.authTab === which)); $('loginForm').classList.toggle('hidden', which !== 'login'); $('signupForm').classList.toggle('hidden', which !== 'signup'); clearSay('authMessage'); }
  async function login(e) { e.preventDefault(); const f = new FormData(e.currentTarget); const { error } = await db.auth.signInWithPassword({ email:f.get('email'), password:f.get('password') }); if (error) say('authMessage', error.message, true); else clearSay('authMessage'); }
  async function signup(e) { e.preventDefault(); const f = new FormData(e.currentTarget); const { data, error } = await db.auth.signUp({ email:f.get('email'), password:f.get('password'), options:{ data:{ full_name:f.get('full_name') } } }); if (error) return say('authMessage', error.message, true); if (!data.session) say('authMessage', 'Kontot skapades. Kontrollera e-posten om Supabase kräver e-postbekräftelse. Logga sedan in.'); else say('authMessage', 'Kontot skapades.'); }
  async function logout() { if (db) await db.auth.signOut(); resetUI(); }
  async function loadUser(user) { currentUser = user; const { data } = await db.from('profiles').select('full_name,role').eq('id',user.id).maybeSingle(); profile = data; if (profile?.role && profile.role !== 'patient') { location.href = 'staff.html'; return; } $('authPanel').classList.add('hidden'); $('appPanel').classList.remove('hidden'); $('logoutBtn').classList.remove('hidden'); $('signedInAs').textContent = user.email || ''; $('customerName').textContent = profile?.full_name || user.user_metadata?.full_name || 'välkommen'; await Promise.all([loadQueue(), loadVaccines(), loadPharmacy()]); if (queueTimer) clearInterval(queueTimer); queueTimer = setInterval(() => { loadQueue(); }, 12000); }
  function resetUI() { currentUser = null; profile = null; activeQueue = null; if (queueTimer) clearInterval(queueTimer); if (deskStream) deskStream.getTracks().forEach(t=>t.stop()); $('authPanel')?.classList.remove('hidden'); $('appPanel')?.classList.add('hidden'); $('logoutBtn')?.classList.add('hidden'); $('signedInAs').textContent=''; }
  function showView(name) { document.querySelectorAll('.view').forEach(v => v.classList.add('hidden')); $('view-'+name)?.classList.remove('hidden'); document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active',b.dataset.view===name)); if (name==='pharmacy') loadPharmacy(); if (name==='vaccine') loadVaccines(); if (name==='queue') loadQueue(); }
  function pharmacyTab(which) { document.querySelectorAll('[data-pharmacy-tab]').forEach(b => b.classList.toggle('active',b.dataset.pharmacyTab===which)); $('pharmacyReceipts').classList.toggle('hidden',which!=='receipts'); $('pharmacyPrescriptions').classList.toggle('hidden',which!=='prescriptions'); }
  async function loadQueue() {
    if (!db || !currentUser) return;
    const { data, error } = await db.from('queue_entries').select('id,queue_number,status,created_at,called_room').eq('patient_id',currentUser.id).in('status',['waiting','called','serving']).order('created_at',{ascending:false}).limit(1).maybeSingle();
    if (error) { $('queueHelp').textContent = 'Köstatus kunde inte laddas. Kontrollera att schema.sql har körts.'; return; }
    activeQueue = data;
    if (!data) { $('queueTicket').classList.add('hidden'); $('turnNotice').classList.add('hidden'); $('queueHelp').textContent = 'Ingen aktiv kölapp just nu. Skanna QR-koden vid informationsdisken för att ta en.'; return; }
    $('queueTicket').classList.remove('hidden'); $('queueNumber').textContent = `#${data.queue_number}`; $('queueState').textContent = data.status==='called' ? 'Du har blivit kallad fram' : data.status==='serving' ? 'Du är hos personalen' : 'Väntar på informationsdisken';
    const { data: aheadCount } = await db.rpc('queue_people_ahead', {p_queue_date:new Date().toISOString().slice(0,10), p_queue_number:data.queue_number});
    const ahead = data.status==='called' || data.status==='serving' ? 0 : (aheadCount ?? 0); $('queueAhead').textContent = `${ahead} PERSONER FRAMFÖR DIG`;
    if (data.called_room) { $('queueRoom').textContent=data.called_room; $('queueRoom').classList.remove('hidden'); } else $('queueRoom').classList.add('hidden');
    const turn = data.status==='called' || data.status==='serving' || ahead===0; $('turnNotice').classList.toggle('hidden',!turn); if (turn) notifyTurn(data.id);
  }
  const alertedQueues = new Set(); function notifyTurn(id) { if (alertedQueues.has(id)) return; alertedQueues.add(id); try { if ('vibrate' in navigator) navigator.vibrate([90,45,90]); const Ctx=window.AudioContext||window.webkitAudioContext; if (Ctx) { const ctx=new Ctx(); const osc=ctx.createOscillator(), gain=ctx.createGain(); osc.frequency.value=740; gain.gain.value=0.025; osc.connect(gain); gain.connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime+0.13); } } catch(_){} }
  async function startDeskScan() {
    if (!navigator.mediaDevices?.getUserMedia || !('BarcodeDetector' in window)) { say('deskScanStatus','Den här webbläsaren saknar QR-skanning. Öppna sidan i en webbläsare med stöd för BarcodeDetector eller använd personaldatorn för att skapa kölappen.',true); return; }
    try { deskStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}}); const v=$('deskVideo'); v.srcObject=deskStream; v.classList.remove('hidden'); await v.play(); const detector=new BarcodeDetector({formats:['qr_code']}); say('deskScanStatus','Rikta kameran mot QR-koden vid informationsdisken.'); const scan=async()=>{ if (!deskStream) return; try { const codes=await detector.detect(v); if (codes.length) { stopDeskScan(); await joinQueue(codes[0].rawValue); return; } } catch(_){} requestAnimationFrame(scan); }; scan(); } catch(e) { say('deskScanStatus','Kunde inte starta kameran. Tillåt kameraåtkomst i webbläsaren. '+e.message,true); }
  }
  function stopDeskScan(){ if(deskStream) deskStream.getTracks().forEach(t=>t.stop()); deskStream=null; $('deskVideo').classList.add('hidden'); }
  async function joinQueue(raw) {
    let token; try { const parsed=JSON.parse(raw); token=parsed.desk_token; } catch(_) { token=raw; }
    const { data: desk, error: de } = await db.from('desk_qr_tokens').select('id,active').eq('token',token).eq('active',true).maybeSingle(); if (de || !desk) return say('deskScanStatus','QR-koden är inte giltig för informationsdisken.',true);
    const today=new Date().toISOString().slice(0,10); const { data: existing }=await db.from('queue_entries').select('id,queue_number').eq('patient_id',currentUser.id).eq('queue_date',today).in('status',['waiting','called','serving']).maybeSingle();
    if(existing) { await loadQueue(); return say('deskScanStatus','Du har redan en aktiv kölapp för i dag.'); }
    const { data: row, error }=await db.from('queue_entries').insert({patient_id:currentUser.id,queue_date:today,status:'waiting',desk_token_id:desk.id}).select('id,queue_number').single(); if(error) return say('deskScanStatus','Kölappen kunde inte skapas: '+error.message,true); await loadQueue(); say('deskScanStatus',`Din digitala kölapp är skapad: nummer ${row.queue_number}.`);
  }
  async function loadVaccines() {
    if (!db || !currentUser) return; const list=$('vaccineList'); list.innerHTML='<p class="muted">Laddar schema …</p>';
    const { data, error }=await db.from('vaccine_bookings').select('id,vaccine_name,stop_name,appointment_date,appointment_time,status,qr_token').eq('patient_id',currentUser.id).order('appointment_date',{ascending:true});
    if(error) { list.innerHTML='<p class="muted">Schemat kunde inte laddas. Kontrollera schema.sql.</p>'; return; }
    if(!data?.length) { list.innerHTML='<p class="muted">Du har varken bokat tid för eller tagit vaccinet.</p>'; return; }
    list.innerHTML=''; data.forEach(b=>{ const el=document.createElement('article'); el.className='item-card'; const details=document.createElement('div'); details.innerHTML=`<h4>${esc(b.vaccine_name)}</h4><p>${esc(fmtDate(b.appointment_date))} kl. ${esc(b.appointment_time||'—')} · ${esc(b.stop_name)}</p><span class="status ${b.status==='booked'?'blue':b.status==='completed'?'green':'amber'}">${b.status==='booked'?'BOKAD':b.status==='completed'?'GENOMFÖRD':esc(b.status.toUpperCase())}</span>`; const actions=document.createElement('div'); actions.className='item-actions'; if(b.status==='booked' && b.qr_token) { const btn=document.createElement('button'); btn.className='button button-primary'; btn.textContent='FRAMME'; btn.addEventListener('click',()=>showVaccineQr(b)); actions.append(btn); } el.append(details,actions); list.append(el); });
  }
  function showVaccineQr(b) { const modal=document.createElement('div'); modal.className='modal-backdrop'; modal.innerHTML=`<div class="modal-card"><button class="modal-close" aria-label="Stäng">×</button><span class="eyebrow">VACCINBUSS · BOKNINGSKONTROLL</span><h2>${esc(b.vaccine_name)}</h2><p>${esc(b.stop_name)} · ${esc(fmtDate(b.appointment_date))} kl. ${esc(b.appointment_time)}</p><div id="vaccineQr" class="qr-box"></div><p class="small muted">Visa koden för vaccinpersonalens QR-läsare. Efter godkänd skanning försvinner QR-koden.</p><button class="button button-outline modal-done">Stäng</button></div>`; document.body.append(modal); const close=()=>modal.remove(); modal.querySelector('.modal-close').onclick=close; modal.querySelector('.modal-done').onclick=close; if(window.QRCode) new QRCode(modal.querySelector('#vaccineQr'),{text:JSON.stringify({type:'vaccine_booking',token:b.qr_token}),width:220,height:220}); else modal.querySelector('#vaccineQr').textContent='QR-biblioteket kunde inte laddas.'; }
  async function bookVaccine(e) { e.preventDefault(); const f=new FormData(e.currentTarget); const token=crypto.randomUUID(); const { error }=await db.from('vaccine_bookings').insert({patient_id:currentUser.id,vaccine_name:f.get('vaccine_name'),stop_name:f.get('stop_name'),appointment_date:f.get('appointment_date'),appointment_time:f.get('appointment_time'),status:'booked',qr_token:token}); if(error) return say('globalMessage','Bokningen misslyckades: '+error.message,true); e.currentTarget.reset(); say('globalMessage','Testtiden är bokad. Den visas nu under SCHEMA.'); await loadVaccines(); }
  async function loadPharmacy() {
    if(!db||!currentUser) return; const r=$('pharmacyReceipts'), p=$('pharmacyPrescriptions'); r.innerHTML='<p class="muted">Laddar kvitton …</p>'; p.innerHTML='<p class="muted">Laddar recept …</p>';
    const [rr,pp]=await Promise.all([db.from('pharmacy_receipts').select('id,medicine_name,return_code,dispensed_at').eq('patient_id',currentUser.id).order('dispensed_at',{ascending:false}),db.from('prescriptions').select('id,medicine_name,valid_until,remaining_refills,qr_token,status').eq('patient_id',currentUser.id).eq('status','active').order('created_at',{ascending:false})]);
    r.innerHTML=''; if(rr.error) r.innerHTML='<p class="muted">Kvitton kunde inte laddas.</p>'; else if(!rr.data?.length) r.innerHTML='<p class="muted">Inga kvitton ännu.</p>'; else rr.data.forEach(x=>{const el=document.createElement('article');el.className='item-card';el.innerHTML=`<div><h4>${esc(x.medicine_name)}</h4><p>Uthämtat ${esc(new Date(x.dispensed_at).toLocaleDateString('sv-SE'))}</p></div><div class="item-actions"><span class="status">RETURKOD</span><b>${esc(x.return_code)}</b></div>`;r.append(el)});
    p.innerHTML=''; if(pp.error) p.innerHTML='<p class="muted">Recept kunde inte laddas.</p>'; else if(!pp.data?.length) p.innerHTML='<p class="muted">Inga aktuella recept.</p>'; else pp.data.forEach(x=>{const el=document.createElement('article');el.className='item-card';el.innerHTML=`<div><h4>${esc(x.medicine_name)}</h4><p>Giltigt till ${esc(fmtDate(x.valid_until))} · Återstående uttag: ${esc(x.remaining_refills)}</p></div><div class="item-actions"><span class="status green">AKTUELLT</span><div class="qr-mini" data-token="${esc(x.qr_token||'')}"></div></div>`;p.append(el); const q=el.querySelector('.qr-mini'); if(x.qr_token&&window.QRCode) new QRCode(q,{text:JSON.stringify({type:'prescription',token:x.qr_token}),width:110,height:110}); else q.textContent='QR saknas'; });
  }
  document.addEventListener('DOMContentLoaded', init);
})();

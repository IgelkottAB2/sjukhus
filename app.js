'use strict';
const $ = (id) => document.getElementById(id);
const show = (id, message) => { const el = $(id); if (el) el.textContent = message; };
document.querySelectorAll('[data-message]').forEach((button) => button.addEventListener('click', () => alert(button.dataset.message)));
const modal = $('loginModal');
$('loginOpen')?.addEventListener('click', () => { modal.hidden = false; });
$('loginClose')?.addEventListener('click', () => { modal.hidden = true; });
modal?.addEventListener('click', (event) => { if (event.target === modal) modal.hidden = true; });
document.querySelectorAll('.nav a').forEach((link) => link.addEventListener('click', () => {
  document.querySelectorAll('.nav a').forEach((item) => item.classList.remove('active'));
  link.classList.add('active');
}));
$('patientForm')?.addEventListener('submit', (e) => { e.preventDefault(); show('patientResult', 'Inloggning kan inte genomföras: säker patientinloggning är inte ansluten. Inga uppgifter har skickats eller sparats.'); });
$('staffForm')?.addEventListener('submit', (e) => { e.preventDefault(); show('staffResult', 'Personalinloggning är inte ansluten. Inga inloggningsuppgifter har skickats eller sparats.'); });
$('emergencyForm')?.addEventListener('submit', (e) => { e.preventDefault(); show('emergencyResult', 'Övningsformulär skickat lokalt? Nej – inget har skickats. Detta är inte ett larm. Vid akut fara, ring 112.'); });
$('qrForm')?.addEventListener('submit', (e) => { e.preventDefault(); show('qrResult', 'Koden kan inte kontrolleras eftersom inget receptsystem är anslutet.'); });
$('vaccineSearch')?.addEventListener('submit', (e) => { e.preventDefault(); show('vaccineResult', 'Inga busstider kan visas ännu. Ett verifierat schema behöver först läggas in i databasen.'); });

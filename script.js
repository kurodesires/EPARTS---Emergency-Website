const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const publicPage = $('#public-page');
const app = $('#app');
const modal = $('#auth-modal');
let registerMode = false;
let currentUser = null;
let data = { passes: [], incidents: [], patients: [] };
let currentView = 'dashboard';
let notifications = [];
let notificationTimer = null;
let chatMessages = [];
let chatTimer = null;
let cropState = null;

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Something went wrong.');
  return result;
}

function openModal(mode = false) {
  registerMode = mode;
  $('#auth-title').textContent = mode ? 'Create your account' : 'Welcome back';
  $('#auth-subtitle').textContent = mode ? 'Register your campus account.' : 'Sign in to your campus account.';
  $('#auth-submit').textContent = mode ? 'Create Account' : 'Log In';
  $('#auth-toggle').textContent = mode ? 'Already have an account? Log in' : 'Create an account';
  $('#account-type-field').hidden = false;
  updateSignupFields();
  $('input[name="password"]').autocomplete = mode ? 'new-password' : 'current-password';
  $('#auth-error').textContent = '';
  modal.classList.remove('hidden');
}

function updateSignupFields() {
  const role = $('select[name="role"]').value;
  const student = role === 'student';
  $('#identifier-field').hidden = registerMode;
  $('input[name="identifier"]').required = !registerMode;
  $('#name-field').hidden = !registerMode || student;
  $('#name-field input').required = registerMode && !student;
  $('#grade-field').hidden = true;
  $('#email-field').hidden = !registerMode || !student;
  $('#email-field input').required = registerMode && student;
  $('#admin-password-field').hidden = student;
  $('#admin-password-field input').required = !student;
  $('#password-field').hidden = !student;
  $('input[name="password"]').required = student;
  $('#email-field').firstChild.textContent = 'Email address';
  $('#identifier-field').firstChild.textContent = student ? 'Email address' : 'Nickname';
  $('input[name="identifier"]').placeholder = student ? 'you@example.com' : 'Your nickname';
  $('#name-field').firstChild.textContent = student ? 'Full name' : 'Nickname';
  $('#auth-toggle').textContent = registerMode ? 'Already have an account? Log in' : (student ? 'Create student account' : 'Create account');
}

$('select[name="role"]').addEventListener('change', updateSignupFields);

$$('[data-login]').forEach(button => button.addEventListener('click', () => openModal()));
$('#close-modal').addEventListener('click', () => modal.classList.add('hidden'));
$('#auth-toggle').addEventListener('click', () => openModal(!registerMode));
modal.addEventListener('click', event => { if (event.target === modal) modal.classList.add('hidden'); });

$('#auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  if (registerMode && values.role === 'student') values.identifier = values.email;
  else if (registerMode) values.identifier = values.name;
  $('#auth-error').textContent = '';
  try {
    const result = await api(registerMode ? '/register' : '/login', { method: 'POST', body: JSON.stringify(values) });
    currentUser = result.user;
    modal.classList.add('hidden');
    await showApp();
  } catch (error) { $('#auth-error').textContent = error.message; }
});

$('#logout').addEventListener('click', async () => {
  if (notificationTimer) clearInterval(notificationTimer);
  if (chatTimer) clearInterval(chatTimer);
  await api('/logout', { method: 'POST' });
  currentUser = null;
  chatMessages = [];
  currentView = 'dashboard';
  app.classList.add('hidden'); publicPage.classList.remove('hidden');
});

async function showApp() {
  publicPage.classList.add('hidden'); app.classList.remove('hidden');
  $('#messages-nav').hidden = !['clinic_nurse', 'ert'].includes(currentUser.role);
  $('#user-label').textContent = `${currentUser.name || 'Complete profile'} · ${currentUser.role}`;
  updateAvatar();
  await loadData(); renderView();
  await loadNotifications();
  if (notificationTimer) clearInterval(notificationTimer);
  notificationTimer = setInterval(loadNotifications, 20000);
  if (chatTimer) clearInterval(chatTimer);
  chatTimer = setInterval(async () => {
    if (currentView !== 'messages' || !['clinic_nurse', 'ert'].includes(currentUser?.role)) return;
    const feed = $('#chat-feed');
    const atBottom = feed && feed.scrollHeight - feed.scrollTop - feed.clientHeight < 70;
    if (await loadMessages()) { renderView(); if (atBottom) $('#chat-feed').scrollTop = $('#chat-feed').scrollHeight; }
  }, 6000);
}

function updateAvatar() {
  const avatar = $('#avatar');
  avatar.innerHTML = currentUser.profileImage ? `<img src="${currentUser.profileImage}" alt="Profile">` : esc((currentUser.name || 'S').slice(0, 1).toUpperCase());
}

async function loadNotifications() {
  try {
    const result = await api('/notifications'); notifications = result.notifications;
    const unread = notifications.filter(item => !(item.readBy || []).includes(currentUser.id)).length;
    $('#notification-count').textContent = String(unread);
    $('#notification-count').classList.toggle('hidden', unread === 0);
    const panel = $('#notification-panel');
    panel.innerHTML = `<h3>Notifications</h3>${notifications.length ? notifications.map(item => `<button class="notification-item ${!(item.readBy || []).includes(currentUser.id) ? 'unread' : ''}" data-notification="${esc(item.id)}" data-incident="${esc(item.incidentId || '')}" data-patient="${esc(item.patientId || '')}" data-message="${esc(item.messageId || '')}"><b>${esc(item.title)}</b><span>${esc(item.message)}</span><small>${stamp(item.createdAt)}</small></button>`).join('') : '<p class="empty">No notifications.</p>'}`;
    $$('[data-notification]', panel).forEach(button => button.addEventListener('click', async () => {
      await api('/notifications/read', { method: 'POST', body: JSON.stringify({ ids: [button.dataset.notification] }) });
      if (button.dataset.incident) { currentView = 'incidents'; $$('.side-links button').forEach(item => item.classList.toggle('active', item.dataset.view === 'incidents')); await loadData(); renderView(); }
      else if (button.dataset.patient) { currentView = 'records'; $$('.side-links button').forEach(item => item.classList.toggle('active', item.dataset.view === 'records')); await loadData(); renderView(); }
      else if (button.dataset.message) { currentView = 'messages'; $$('.side-links button').forEach(item => item.classList.toggle('active', item.dataset.view === 'messages')); await loadMessages(); renderView(); $('#chat-feed').scrollTop = $('#chat-feed').scrollHeight; }
      panel.classList.add('hidden'); await loadNotifications();
    }));
  } catch {}
}

$('#notification-button').addEventListener('click', async () => { await loadNotifications(); $('#notification-panel').classList.toggle('hidden'); });

async function loadData() { data = await api('/data'); currentUser = data.user; }
async function loadMessages() {
  if (!['clinic_nurse', 'ert'].includes(currentUser?.role)) return false;
  try {
    const previous = chatMessages.map(item => item.id).join('|');
    const result = await api('/messages'); chatMessages = result.messages;
    return previous !== chatMessages.map(item => item.id).join('|');
  } catch { return false; }
}

$$('[data-view]').forEach(button => button.addEventListener('click', async () => {
  currentView = button.dataset.view;
  $$('.side-links button').forEach(item => item.classList.toggle('active', item === button));
  if (currentView === 'messages') await loadMessages();
  $('.sidebar').classList.remove('open'); renderView();
  if (currentView === 'messages') $('#chat-feed').scrollTop = $('#chat-feed').scrollHeight;
}));
$('#menu').addEventListener('click', () => {
  if (window.matchMedia('(max-width: 650px)').matches) $('.sidebar').classList.toggle('open');
  else { $('.sidebar').classList.toggle('collapsed'); $('.workspace').classList.toggle('sidebar-hidden'); }
});

function esc(value = '') { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
function date(value) { return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
function stamp(value) { return new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
function status(value) { return `<span class="badge ${value === 'Approved' || value === 'Resolved' ? 'approved' : ''}">${esc(value)}</span>`; }
function table(headers, rows, empty = 'No records yet.') { return `<div class="table-wrap"><table><thead><tr>${headers.map(item => `<th>${item}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td class="empty" colspan="${headers.length}">${empty}</td></tr>`}</tbody></table></div>`; }
function stat(label, value, icon) { return `<article class="stat"><span>${icon} &nbsp; ${label}</span><strong>${value}</strong></article>`; }
function renderView() {
  const root = $('#view');
  const staff = ['staff', 'school_staff', 'clinic_nurse', 'ert', 'admin'].includes(currentUser.role);
  const recent = data.incidents.slice(0, 5).map(item => `<tr><td>${date(item.createdAt)}</td><td>${esc(item.description)}</td><td>${esc(item.location)}</td><td>${status(item.status)}</td></tr>`).join('');
  if (currentView === 'dashboard') root.innerHTML = `<h1>Good day, ${esc((currentUser.name || 'Student').split(' ')[0])}!</h1><p class="muted">Stay informed and be prepared. Your safety is important.</p>${currentUser.role === 'student' && (!currentUser.name || !currentUser.grade || !currentUser.section) ? '<div class="notice"><strong>Complete your student profile</strong><span>Add your full name, grade, and section in Settings before reporting.</span><button class="button" data-open-settings>Open Settings</button></div>' : ''}<div class="stats">${stat('Active Reports', data.incidents.filter(item => item.status === 'Active').length, '⚠')}${stat('Patient Records', data.patients.length, '✚')}${stat('Pass Requests', data.passes.length, '▤')}${stat('Resolved Incidents', data.incidents.filter(item => item.status === 'Resolved').length, '✓')}</div><div class="notice"><strong>⚠ In Case of Emergency</strong><span>Report an emergency immediately so the response team can act.</span><button class="button red" data-action="report">Report Emergency</button></div><div class="columns"><section class="panel"><h2>Recent Incidents</h2>${table(['Date', 'Incident', 'Location', 'Status'], recent)}</section><section class="panel"><h2>Emergency Procedures</h2><p>🔥 &nbsp; Fire emergency<br>Follow marked exits and assemble outside.</p><p>🌎 &nbsp; Earthquake<br>Drop, cover, and hold on.</p><p>✚ &nbsp; First aid<br>Contact the campus nurse or ERT.</p><p>📍 &nbsp; Evacuation<br>Use the nearest safe exit.</p></section></div>`;
  else if (currentView === 'messages') {
    if (!['clinic_nurse', 'ert'].includes(currentUser.role)) root.innerHTML = '<h1>Messages</h1><p class="error">ERT and Clinic Nurse accounts only.</p>';
    else {
      const chat = chatMessages.map(item => `<article class="chat-message ${item.senderId === currentUser.id ? 'mine' : ''}"><div class="chat-meta"><b>${esc(item.senderName)}</b><span>${item.senderRole === 'ert' ? 'ERT' : 'Clinic Nurse'}</span><time>${stamp(item.sentAt)}</time></div><p>${esc(item.text).replace(/\n/g, '<br>')}</p></article>`).join('');
      root.innerHTML = `<h1>ERT and Clinic Messages</h1><p class="muted">Private team chat for advance patient alerts and response coordination.</p><section class="panel chat-panel"><div class="chat-feed" id="chat-feed">${chat || '<p class="empty">No messages yet. Send an update so the other team can prepare.</p>'}</div><form id="message-form" class="message-compose"><label class="field"><span class="sr-only">Message to the response team</span><textarea name="text" maxlength="2000" placeholder="Share an advance patient alert or response update…" required></textarea></label><button class="button">Send Message</button><span class="error" id="message-error"></span></form></section>`;
    }
  }
  else if (currentView === 'report') root.innerHTML = `<h1>Report Emergency</h1><p class="muted">${['clinic_nurse', 'ert'].includes(currentUser.role) ? 'Your report will be added directly to Incident History.' : 'Your report will be sent to the Clinic Nurse and ERT for approval.'}</p>${currentUser.role === 'student' && (!currentUser.name || !currentUser.grade || !currentUser.section) ? '<section class="panel"><p>Complete your full name, grade level, and section in Settings before reporting an emergency.</p><button class="button" data-open-settings>Open Settings</button></section>' : `<form class="panel form-grid" id="incident-form">${currentUser.role === 'student' ? `<p class="field fullrow"><b>Reporting as:</b> ${esc(currentUser.name)} · Grade ${esc(currentUser.grade)} ${esc(currentUser.section)}</p>` : `<label class="field">Person needing help<input name="affectedPerson" value="${esc(currentUser.name)}" required></label>`}<label class="field">Location<input name="location" placeholder="Building / room" required></label><label class="field">Type of injury<input name="injury" placeholder="For example, fall or cut" required></label><label class="field">Severity<select name="severity"><option>Low</option><option selected>Moderate</option><option>High</option><option>Critical</option></select></label><label class="field fullrow">What happened?<textarea name="description" required></textarea></label><div class="field fullrow"><button class="button red">Send Emergency Report</button><span id="report-message" class="muted"></span></div></form>`}`;
  else if (currentView === 'passes') renderPasses(root, staff);
  else if (currentView === 'records') {
    const canEdit = ['clinic_nurse', 'ert'].includes(currentUser.role);
    const isStudent = currentUser.role === 'student';
    const profileReady = Boolean(currentUser.name && ['11', '12'].includes(currentUser.grade) && currentUser.section);
    const canAdd = staff || (isStudent && profileReady);
    const patientForm = canAdd ? `<form class="panel form-grid" id="patient-form"><p class="muted fullrow">${canEdit ? 'Records you add are approved immediately.' : 'New records are sent to the Clinic Nurse and ERT for approval.'}</p><label class="field">Patient name<input name="name" required value="${isStudent ? esc(currentUser.name) : ''}"></label><label class="field">Grade level<input name="grade" placeholder="Grade 11 or Grade 12" value="${isStudent ? esc(currentUser.grade) : ''}" ${isStudent ? 'readonly' : ''}></label><label class="field">Section<input name="section" placeholder="Year-Section" value="${isStudent ? esc(currentUser.section) : ''}" ${isStudent ? 'readonly' : ''}></label><label class="field">Location<input name="location" required></label><label class="field">Type of injury<input name="injury" required></label><label class="field">Severity<select name="severity"><option>Low</option><option>Moderate</option><option>High</option><option>Critical</option></select></label><label class="field fullrow">Details (optional)<textarea name="details"></textarea></label><div class="field fullrow"><button class="button">Submit Patient Record</button></div></form>` : isStudent ? '<section class="panel"><p>Complete your full name, grade level, and section in Settings before adding a patient record.</p><button class="button" data-open-settings>Open Settings</button></section>' : '';
    const patientRows = data.patients.map(item => `<tr><td>${esc(item.name)}</td><td>${esc(item.grade || '—')}</td><td>${esc(item.section || '—')}</td><td>${esc(item.location || '—')}</td><td>${esc(item.injury || '—')}</td><td>${esc(item.severity || '—')}</td><td>${status(item.status || 'Approved')}</td><td>${esc(item.recordedBy)}</td><td>${date(item.createdAt)}</td>${canEdit ? `<td class="actions">${item.status === 'Pending approval' && !item.incidentId ? `<button class="button small" data-patient-decision="Approved" data-id="${esc(item.id)}">Approve</button><button class="button small red" data-patient-decision="Rejected" data-id="${esc(item.id)}">Reject</button>` : ''}<button class="button small" data-edit-patient="${esc(item.id)}">Edit</button></td>` : ''}</tr>`).join('');
    root.innerHTML = `<h1>Patient Records</h1><p class="muted">Emergency response records saved by campus staff. Your reports appear here after submission.</p>${patientForm}<section class="panel">${table(['Patient', 'Grade', 'Section', 'Location', 'Injury', 'Severity', 'Status', 'Recorded by', 'Date', ...(canEdit ? ['Action'] : [])], patientRows)}</section>`;
  }
  else if (currentView === 'incidents') {
    const canEdit = ['clinic_nurse', 'ert'].includes(currentUser.role);
    root.innerHTML = `<h1>Incident History</h1><p class="muted">Pending reports need approval from the Clinic Nurse or ERT.</p>${table(['Date', 'Incident', 'Location', 'Reported by', 'Status', staff ? 'Action' : ''], data.incidents.map(item => `<tr><td>${stamp(item.createdAt)}</td><td>${esc(item.description)}<br><small>${esc(item.injury || '')} · ${esc(item.severity || '')}</small></td><td>${esc(item.location)}</td><td>${esc(item.reporter)}</td><td>${status(item.status)}</td>${staff ? `<td class="actions">${['clinic_nurse', 'ert'].includes(currentUser.role) && item.status === 'Pending approval' ? `<button class="button small" data-approve="${esc(item.id)}">Approve</button>` : item.status === 'Active' ? `<button class="button small" data-resolve="${esc(item.id)}">Resolve</button>` : ''}${canEdit ? `<button class="button small" data-edit-incident="${esc(item.id)}">Edit</button>` : ''}</td>` : ''}</tr>`).join(''))}`;
  }
  else if (currentView === 'procedures') root.innerHTML = `<h1>Emergency Procedures</h1><p class="muted">Basic steps for common campus emergencies.</p><div class="columns">${[['Fire emergency', 'Raise the alarm and call for help. Leave belongings behind and use the nearest safe exit. Do not use elevators. Gather at the assembly area.'], ['Earthquake', 'Drop to your hands and knees, cover your head and neck under sturdy furniture, and hold on. When shaking stops, evacuate carefully.'], ['First aid', 'Check the scene is safe, check the person, call the response team, and give care only within your training.'], ['Evacuation', 'Follow marked routes and staff directions. Walk, keep exits clear, and do not re-enter until responders say it is safe.']].map(item => `<section class="panel"><h2>${item[0]}</h2><p>${item[1]}</p></section>`).join('')}</div><section class="panel video"><h2>First aid guide</h2><p>Read step-by-step first aid guidance from the American Red Cross.</p><a class="button" href="https://www.redcross.org/take-a-class/first-aid/performing-first-aid/first-aid-steps" target="_blank" rel="noopener">Open First Aid Steps</a></section>`;
  else if (currentView === 'contacts') root.innerHTML = `<h1>Emergency Contacts</h1><p class="muted">Reach the campus response team during an emergency.</p><div class="columns"><section class="panel"><h2>Clinic Nurse</h2><p>Campus clinic</p></section><section class="panel"><h2>Emergency Response Team</h2><p>Room 201</p></section><section class="panel"><h2>Talisay Fire Department</h2><p><a href="tel:2728277">272-8277</a></p></section></div>`;
  else root.innerHTML = `<h1>Settings</h1><p class="muted">Update your account profile.</p><form class="panel form-grid" id="settings-form"><label class="field">${currentUser.role === 'student' ? 'Full name' : 'Nickname'}<input name="name" required value="${esc(currentUser.name || '')}"></label>${currentUser.role === 'student' ? `<label class="field">Grade level<input name="grade" type="number" min="11" max="12" step="1" placeholder="11 or 12" required value="${esc(currentUser.grade || '')}"></label><label class="field">Section<input name="section" required value="${esc(currentUser.section || '')}"></label><label class="field">Email<input value="${esc(currentUser.email)}" disabled></label>` : '<p class="muted shared-password-note">Staff accounts use the shared admin sign up password.</p>'}${currentUser.role === 'student' ? '<label class="field">New password<input name="password" type="password" minlength="8" placeholder="Leave blank to keep current password"></label>' : ''}<label class="field fullrow">Profile photo<input name="profileFile" type="file" accept="image/png,image/jpeg,image/webp"><small>PNG, JPG, or WebP. Maximum 1 MB.</small></label><div class="field fullrow"><button class="button">Save Settings</button><span id="settings-message" class="muted"></span></div></form>${currentUser.role === 'student' ? `<form class="panel inline-form student-id-form" id="student-id-form"><label class="field">Student ID<input name="studentId" required pattern="[0-9]{2}-[0-9]{6}" placeholder="12-345678" value="${esc(currentUser.studentId || '')}"></label><button class="button red small">${currentUser.studentId ? 'Update Student ID' : 'Submit Student ID'}</button><span class="${currentUser.studentId ? 'badge approved' : 'badge'}">${currentUser.studentId ? 'Submitted' : 'Required'}</span></form>` : ''}`;
  if (currentView === 'settings' && currentUser.role !== 'student') {
    $('#settings-form input[name="password"]')?.closest('label')?.remove();
    if (!$('#settings-form .shared-password-note')) $('#settings-form').insertAdjacentHTML('afterbegin', '<p class="muted shared-password-note">Staff accounts use the shared admin sign up password.</p>');
  }
  if (currentView === 'settings') initPhotoCropper();
  bindViewActions();
}

function initPhotoCropper() {
  const input = $('#settings-form input[name="profileFile"]');
  if (!input) return;
  const label = input.closest('label');
  label.insertAdjacentHTML('beforeend', `<div class="photo-crop"><div class="photo-crop-preview" title="Drag to adjust photo"></div><div class="photo-crop-controls"><label class="field">Zoom<input type="range" min="1" max="3" step="0.05" value="1" data-crop="zoom"></label></div></div>`);
  const crop = label.querySelector('.photo-crop');
  const preview = crop.querySelector('.photo-crop-preview');
  const zoomControl = crop.querySelector('[data-crop="zoom"]');
  if (currentUser.profileImage) preview.style.backgroundImage = `url("${currentUser.profileImage}")`;
  const paint = () => {
    if (!cropState?.image) return;
    const zoom = Number(crop.querySelector('[data-crop="zoom"]').value);
    const side = Math.min(cropState.image.width, cropState.image.height) / zoom;
    const size = 160 * cropState.image.width / side;
    const height = 160 * cropState.image.height / side;
    preview.style.backgroundSize = `${size}px ${height}px`;
    preview.style.backgroundPosition = `${cropState.x}% ${cropState.y}%`;
  };
  zoomControl.addEventListener('input', paint);
  let drag = null;
  preview.addEventListener('pointerdown', event => {
    if (!cropState?.image) return;
    event.preventDefault();
    preview.setPointerCapture(event.pointerId);
    preview.classList.add('dragging');
    drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, offsetX: cropState.x, offsetY: cropState.y };
  });
  preview.addEventListener('pointermove', event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const bounds = preview.getBoundingClientRect();
    const size = Number(zoomControl.value);
    const side = Math.min(cropState.image.width, cropState.image.height) / size;
    const overflowX = Math.max(1, 160 * cropState.image.width / side - bounds.width);
    const overflowY = Math.max(1, 160 * cropState.image.height / side - bounds.height);
    cropState.x = Math.max(0, Math.min(100, drag.offsetX + (event.clientX - drag.x) / overflowX * 100));
    cropState.y = Math.max(0, Math.min(100, drag.offsetY + (event.clientY - drag.y) / overflowY * 100));
    paint();
  });
  const endDrag = () => { drag = null; preview.classList.remove('dragging'); };
  preview.addEventListener('pointerup', endDrag);
  preview.addEventListener('pointercancel', endDrag);
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) { crop.hidden = true; cropState = null; return; }
    if (file.size > 1024 * 1024) { input.value = ''; alert('Choose an image under 1 MB.'); return; }
    crop.hidden = false;
    crop.querySelector('[data-crop="zoom"]').value = '1';
    const image = new Image();
    const ready = new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; });
    image.src = URL.createObjectURL(file);
    cropState = { file, image, ready, x: 50, y: 50 };
    ready.then(() => { preview.style.backgroundImage = `url("${image.src}")`; paint(); }).catch(() => alert('That image could not be opened.'));
  });
}

async function croppedProfileImage(file) {
  if (!cropState || cropState.file !== file) return '';
  await cropState.ready;
  const { image } = cropState;
  const side = Math.min(image.width, image.height) / Number($('.photo-crop [data-crop="zoom"]').value);
  const sx = (image.width - side) * cropState.x / 100;
  const sy = (image.height - side) * cropState.y / 100;
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 512;
  canvas.getContext('2d').drawImage(image, sx, sy, side, side, 0, 0, 512, 512);
  return canvas.toDataURL('image/jpeg', 0.88);
}

function renderPasses(root, staff) {
  const visible = staff ? data.passes : data.passes.filter(item => item.userId === currentUser.id);
  const rows = visible.map(item => `<tr><td>${esc(item.passId)}</td><td>${esc(item.name)}</td><td>${date(item.date)} · ${esc(item.time)}</td><td>${status(item.status)}</td><td class="actions"><button class="button small" data-pass="${esc(item.id)}">View</button>${staff && item.status === 'Pending' ? `<button class="button small" data-decision="Approved" data-id="${esc(item.id)}">Approve</button><button class="button small red" data-decision="Rejected" data-id="${esc(item.id)}">Reject</button>` : ''}${currentUser.role === 'school_staff' ? `<button class="button small red" data-delete-pass="${esc(item.id)}">Remove</button>` : ''}</td></tr>`).join('');
  const canRequest = ['student', 'ert'].includes(currentUser.role);
  const now = new Date();
  const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const localTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const requestForm = `<hr><h2>Request a Pass Slip</h2>${canRequest ? '' : '<p class="muted">Only Students and ERT accounts can submit pass requests.</p>'}<form id="pass-form" class="form-grid"><fieldset class="form-grid pass-request-fields" ${canRequest ? '' : 'disabled'}><label class="field">Full name<input name="name" required value="${esc(currentUser.name)}"></label><label class="field">I am a<select name="personType"><option ${currentUser.role === 'student' ? 'selected' : ''}>Student</option><option ${currentUser.role === 'ert' ? 'selected' : ''}>ERT</option></select></label><label class="field">Grade / Position<input name="grade" required value="${esc(currentUser.grade || '')}"></label><label class="field">Section / Department<input name="section" required value="${esc(currentUser.section || '')}"></label><label class="field">Date<input name="date" type="date" value="${localDate}" required></label><label class="field">Time<input name="time" type="time" value="${localTime}" required></label><label class="field">Emergency contact<input name="contact" required></label><label class="field">Phone number<input name="phone" type="tel" required></label><label class="field fullrow">Reason<textarea name="reason" required></textarea></label><div class="field fullrow"><button class="button">Submit Pass Request</button></div></fieldset></form>`;
  root.innerHTML = `<h1>Emergency Pass Slip</h1><p class="muted">Request, review, print, or verify a campus emergency pass.</p><div class="columns"><section class="panel"><h2>${staff ? 'Pass Requests' : 'My Pass Requests'}</h2>${table(['School ID', 'Name', 'Date · Time', 'Status', ''], rows)}</section><section class="panel"><h2>Verify a Pass</h2><form id="verify-form" class="inline-form"><label class="field">School ID<input name="passId" placeholder="12-345678" pattern="[0-9]{2}-[0-9]{6}" required></label><button class="button">Verify</button></form><div id="verify-result"></div>${requestForm}</section></div><div id="pass-preview"></div>`;
}

function bindViewActions() {
  const openSettings = $('[data-open-settings]');
  if (openSettings) openSettings.addEventListener('click', () => { currentView = 'settings'; $$('.side-links button').forEach(item => item.classList.toggle('active', item.dataset.view === 'settings')); renderView(); });
  const report = $('[data-action="report"]');
  if (report) report.addEventListener('click', () => { currentView = 'report'; $$('.side-links button').forEach(item => item.classList.toggle('active', item.dataset.view === 'report')); renderView(); });
  const incidentForm = $('#incident-form');
  if (incidentForm) incidentForm.addEventListener('submit', async event => {
    event.preventDefault(); $('#report-message').textContent = 'Sending…';
    try { const result = await api('/incidents', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(incidentForm))) }); await loadData(); $('#report-message').textContent = result.incident.status === 'Active' ? 'Report saved as active.' : 'Sent for Clinic Nurse and ERT approval.'; incidentForm.reset(); await loadNotifications(); }
    catch (error) { $('#report-message').textContent = error.message; }
  });
  const patientForm = $('#patient-form');
  if (patientForm) patientForm.addEventListener('submit', async event => {
    event.preventDefault();
    try { await api('/patients', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(patientForm))) }); await loadData(); renderView(); await loadNotifications(); }
    catch (error) { alert(error.message); }
  });
  const messageForm = $('#message-form');
  if (messageForm) messageForm.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = messageForm.querySelector('button');
    submit.disabled = true;
    $('#message-error').textContent = '';
    try {
      await api('/messages', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(messageForm))) });
      messageForm.reset(); await loadMessages(); renderView(); $('#chat-feed').scrollTop = $('#chat-feed').scrollHeight; await loadNotifications();
    } catch (error) { $('#message-error').textContent = error.message; submit.disabled = false; }
  });
  const passForm = $('#pass-form');
  if (passForm) passForm.addEventListener('submit', async event => {
    event.preventDefault();
    try { await api('/passes', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(passForm))) }); await loadData(); renderView(); }
    catch (error) { alert(error.message); }
  });
  const settingsForm = $('#settings-form');
  if (settingsForm) settingsForm.addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const values = Object.fromEntries(new FormData(settingsForm));
      const file = values.profileFile; delete values.profileFile;
      if (file && file.size) {
        if (file.size > 1024 * 1024) throw new Error('Choose an image under 1 MB.');
        values.profileImage = await croppedProfileImage(file);
      }
      const result = await api('/settings', { method: 'POST', body: JSON.stringify(values) });
      currentUser = result.user; $('#user-label').textContent = `${currentUser.name} · ${currentUser.role}`; updateAvatar();
      $('#settings-message').textContent = 'Saved.';
    } catch (error) { $('#settings-message').textContent = error.message; }
  });
  const studentIdForm = $('#student-id-form');
  if (studentIdForm) studentIdForm.addEventListener('submit', async event => {
    event.preventDefault();
    try { const result = await api('/student-id', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(studentIdForm))) }); currentUser = result.user; renderView(); }
    catch (error) { alert(error.message); }
  });
  const verifyForm = $('#verify-form');
  if (verifyForm) verifyForm.addEventListener('submit', event => {
    event.preventDefault(); const id = new FormData(verifyForm).get('passId').trim().toLowerCase();
    const pass = data.passes.find(item => item.passId.toLowerCase() === id);
    $('#verify-result').innerHTML = pass ? `<p>${status(pass.status)} &nbsp; ${esc(pass.name)} · School ID: ${esc(pass.passId)}</p><p>${esc(pass.reason)}</p>` : '<p class="error">Pass not found.</p>';
  });
  $$('[data-decision]').forEach(button => button.addEventListener('click', async () => {
    const comment = prompt('Optional approval comment:') || '';
    try { await api(`/passes/${encodeURIComponent(button.dataset.id)}/decision`, { method: 'POST', body: JSON.stringify({ decision: button.dataset.decision, comment }) }); await loadData(); renderView(); }
    catch (error) { alert(error.message); }
  }));
  $$('[data-delete-pass]').forEach(button => button.addEventListener('click', async () => {
    if (!confirm('Permanently remove this emergency pass request?')) return;
    try { await api(`/passes/${encodeURIComponent(button.dataset.deletePass)}`, { method: 'DELETE' }); await loadData(); renderView(); }
    catch (error) { alert(error.message); }
  }));
  $$('[data-resolve]').forEach(button => button.addEventListener('click', async () => {
    try { await api(`/incidents/${encodeURIComponent(button.dataset.resolve)}/resolve`, { method: 'POST' }); await loadData(); renderView(); }
    catch (error) { alert(error.message); }
  }));
  $$('[data-approve]').forEach(button => button.addEventListener('click', async () => {
    try { await api(`/incidents/${encodeURIComponent(button.dataset.approve)}/approve`, { method: 'POST' }); await loadData(); renderView(); await loadNotifications(); }
    catch (error) { alert(error.message); }
  }));
  $$('[data-patient-decision]').forEach(button => button.addEventListener('click', async () => {
    try { await api(`/patients/${encodeURIComponent(button.dataset.id)}/decision`, { method: 'POST', body: JSON.stringify({ decision: button.dataset.patientDecision }) }); await loadData(); renderView(); await loadNotifications(); }
    catch (error) { alert(error.message); }
  }));
  $$('[data-edit-incident]').forEach(button => button.addEventListener('click', () => openRecordEditor('incident', button.dataset.editIncident)));
  $$('[data-edit-patient]').forEach(button => button.addEventListener('click', () => openRecordEditor('patient', button.dataset.editPatient)));
  $$('[data-delete-patient]').forEach(button => button.addEventListener('click', async () => {
    if (!confirm('Remove this patient record?')) return;
    try { await api(`/patients/${encodeURIComponent(button.dataset.deletePatient)}`, { method: 'DELETE' }); await loadData(); renderView(); }
    catch (error) { alert(error.message); }
  }));
  $$('[data-pass]').forEach(button => button.addEventListener('click', () => showPass(button.dataset.pass)));
}

function openRecordEditor(kind, id) {
  const incident = kind === 'incident';
  const record = (incident ? data.incidents : data.patients).find(item => item.id === id);
  if (!record) return;
  const fields = incident
    ? [['affectedPerson', 'Person needing help', 'text'], ['location', 'Location', 'text'], ['injury', 'Type of injury', 'text'], ['severity', 'Severity', 'select'], ['description', 'What happened?', 'textarea']]
    : [['name', 'Patient name', 'text'], ['grade', 'Grade level', 'text'], ['section', 'Section (Year-Section)', 'text'], ['location', 'Location', 'text'], ['injury', 'Type of injury', 'text'], ['severity', 'Severity', 'select'], ['details', 'Details', 'textarea']];
  const overlay = document.createElement('div');
  overlay.className = 'modal';
  const canRemove = ['clinic_nurse', 'ert'].includes(currentUser.role);
  overlay.innerHTML = `<section class="modal-card edit-record-card"><button type="button" class="close" aria-label="Close">×</button><h2>Edit ${incident ? 'Emergency Report' : 'Patient Record'}</h2><form class="form-grid">${fields.map(([name, label, type]) => `<label class="field ${type === 'textarea' ? 'fullrow' : ''}">${label}${type === 'select' ? `<select name="${name}">${['Low', 'Moderate', 'High', 'Critical'].map(value => `<option ${record[name] === value ? 'selected' : ''}>${value}</option>`).join('')}</select>` : type === 'textarea' ? `<textarea name="${name}" required>${esc(record[name] || '')}</textarea>` : `<input name="${name}" value="${esc(record[name] || '')}" required>`}</label>`).join('')}<div class="field fullrow actions"><button class="button">Save Changes</button>${canRemove ? `<button type="button" class="button red" data-modal-delete>Remove ${incident ? 'Incident' : 'Patient'} Record</button>` : ''}<p class="error" aria-live="polite"></p></div></form></section>`;
  document.body.append(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('.close').addEventListener('click', close);
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  overlay.querySelector('[data-modal-delete]')?.addEventListener('click', async event => {
    if (!confirm(`Permanently remove this ${incident ? 'incident and linked patient' : 'patient'} record?`)) return;
    event.currentTarget.disabled = true;
    try { await api(`/${incident ? 'incidents' : 'patients'}/${encodeURIComponent(id)}`, { method: 'DELETE' }); close(); await loadData(); renderView(); }
    catch (error) { overlay.querySelector('.error').textContent = error.message; event.currentTarget.disabled = false; }
  });
  overlay.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      await api(`/${incident ? 'incidents' : 'patients'}/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      close(); await loadData(); renderView();
    } catch (error) { form.querySelector('.error').textContent = error.message; button.disabled = false; }
  });
}

function showPass(id) {
  const pass = data.passes.find(item => item.id === id); if (!pass) return;
  $('#pass-preview').innerHTML = `<section class="pass-paper" id="print-pass"><img class="logo" src="https://cdn.corenexis.com/f/tuPgbQwbPGB.png" alt="ACT logo"><h2>ACT BULACAO CAMPUS<br>EMERGENCY PASS SLIP REQUEST</h2><hr><p><b>SCHOOL ID</b> &nbsp; ${esc(pass.passId)}</p><dl><dt>Name</dt><dd>${esc(pass.name)}</dd><dt>Type</dt><dd>${esc(pass.personType)}</dd><dt>Grade / Section</dt><dd>${esc(pass.grade)} - ${esc(pass.section)}</dd><dt>Reason</dt><dd>${esc(pass.reason)}</dd><dt>Date</dt><dd>${esc(pass.date)}</dd><dt>Time</dt><dd>${esc(pass.time)}</dd><dt>Emergency contact</dt><dd>${esc(pass.contact)} · ${esc(pass.phone)}</dd><dt>Status</dt><dd>${status(pass.status)}</dd></dl><div class="signature-grid"><div><span></span><b>Adviser Signature</b></div><div><span></span><b>Principal Signature</b></div></div><small class="pass-validity">For school approval and record.</small></section><button class="button print-action no-print" onclick="window.print()">Print Pass Slip Request</button>`;
  $('#pass-preview').scrollIntoView({ behavior: 'smooth' });
}

api('/me').then(async result => { currentUser = result.user; await showApp(); }).catch(() => {});

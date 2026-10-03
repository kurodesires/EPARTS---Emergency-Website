const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = __dirname;
const storePath = path.join(root, 'database.json');
const port = Number(process.env.PORT || 3000);
const adminPassword = '123admin123';
const sessions = new Map();
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };

function readStore() {
  try { return JSON.parse(fs.readFileSync(storePath, 'utf8')); }
  catch { return { users: [], passes: [], incidents: [], patients: [] }; }
}

function writeStore(data) {
  fs.writeFileSync(storePath, JSON.stringify(data, null, 2));
}

function send(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(JSON.stringify(value));
}

function body(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > 2000000) reject(new Error('Request too large')); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('Invalid request')); } });
    req.on('error', reject);
  });
}

function hash(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, value: crypto.scryptSync(password, salt, 64).toString('hex') };
}

function auth(req) {
  const token = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('e_session='))?.slice(10);
  if (!token) return undefined;
  if (sessions.has(token)) return sessions.get(token);
  const entry = (readStore().sessions || []).find(item => item.token === token && item.expiresAt > Date.now());
  if (entry) sessions.set(token, entry.userId);
  return entry?.userId;
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const store = readStore();
  store.sessions ||= [];
  store.sessions = store.sessions.filter(item => item.expiresAt > Date.now());
  store.sessions.push({ token, userId, expiresAt: Date.now() + 86400000 });
  writeStore(store);
  sessions.set(token, userId);
  return token;
}

function safeUser(user) { return { id: user.id, name: user.name, role: user.role, email: user.email || '', studentId: user.studentId || '', grade: user.grade || '', section: user.section || '', profileImage: user.profileImage || '' }; }
function isStaff(user) { return user && ['staff', 'school_staff', 'clinic_nurse', 'ert', 'admin'].includes(user.role); }

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const store = readStore();
  if (url.pathname.startsWith('/api/')) {
    if (req.method === 'POST' && url.pathname === '/api/register') {
      const input = await body(req);
      const name = String(input.name || '').trim();
      const password = String(input.password || '');
      const role = ['student', 'school_staff', 'clinic_nurse', 'ert', 'admin'].includes(input.role) ? input.role : 'student';
      const email = String(input.email || '').trim().toLowerCase();
      const student = role === 'student';
      const identifier = student ? email : name.toLowerCase();
      if ((!student && name.length < 2) || (student && (!email.includes('@') || password.length < 8)) || (!student && input.adminPassword !== adminPassword)) return send(res, student ? 400 : 403, { error: student ? 'Enter a valid email and a password with at least 8 characters.' : 'The admin sign up password is incorrect.' });
      if ((!student && store.users.some(user => user.name.toLowerCase() === name.toLowerCase())) || (email && store.users.some(user => user.email?.toLowerCase() === email))) return send(res, 409, { error: 'That nickname or email is already in use.' });
      const credentials = hash(student ? password : adminPassword);
      const user = { id: crypto.randomUUID(), name: student ? '' : name, identifier, email: student ? email : '', studentId: '', grade: '', section: '', role, ...credentials, createdAt: new Date().toISOString() };
      store.users.push(user); writeStore(store);
      const token = createSession(user.id);
      return send(res, 201, { user: safeUser(user) }, { 'Set-Cookie': `e_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400` });
    }
    if (req.method === 'POST' && url.pathname === '/api/login') {
      const input = await body(req);
      const identifier = String(input.identifier || '').trim().toLowerCase();
      const user = store.users.find(item => item.role === 'student' ? String(item.email || '').toLowerCase() === identifier : String(item.name || '').toLowerCase() === identifier);
      const credential = user?.role === 'student' ? String(input.password || '') : String(input.adminPassword || '');
      if (!user || hash(credential, user.salt).value !== user.value) return send(res, 401, { error: 'Make an account first.' });
      const token = createSession(user.id);
      return send(res, 200, { user: safeUser(user) }, { 'Set-Cookie': `e_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400` });
    }
    const userId = auth(req);
    const user = store.users.find(item => item.id === userId);
    if (req.method === 'POST' && url.pathname === '/api/logout') {
      const token = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('e_session='))?.slice(10);
      sessions.delete(token);
      store.sessions = (store.sessions || []).filter(item => item.token !== token);
      writeStore(store); return send(res, 200, { ok: true }, { 'Set-Cookie': 'e_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
    }
    if (!user) return send(res, 401, { error: 'Please log in to continue.' });
    if (req.method === 'GET' && url.pathname === '/api/me') return send(res, 200, { user: safeUser(user) });
    if (req.method === 'GET' && url.pathname === '/api/data') return send(res, 200, { user: safeUser(user), passes: isStaff(user) ? store.passes : store.passes.filter(item => item.userId === user.id), incidents: store.incidents, patients: isStaff(user) ? store.patients : store.patients.filter(item => item.reporterId === user.id) });
    if (req.method === 'GET' && url.pathname === '/api/notifications') {
      const notifications = store.notifications || [];
      return send(res, 200, { notifications: notifications.filter(item => !item.resolved && (item.userId === user.id || (item.roles || []).includes(user.role))).slice(0, 30) });
    }
    if (req.method === 'POST' && url.pathname === '/api/notifications/read') {
      const input = await body(req); const ids = new Set(Array.isArray(input.ids) ? input.ids : []);
      for (const notification of store.notifications || []) if (ids.has(notification.id)) { notification.readBy ||= []; if (!notification.readBy.includes(user.id)) notification.readBy.push(user.id); }
      writeStore(store); return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/passes') {
      if (!['student', 'ert'].includes(user.role)) return send(res, 403, { error: 'Only students and ERT can request an emergency pass.' });
      const input = await body(req);
      const fields = ['name', 'personType', 'grade', 'section', 'reason', 'date', 'time', 'contact', 'phone'];
      for (const key of fields) if (!String(input[key] || '').trim()) return send(res, 400, { error: 'Complete all required fields.' });
      let passId; do { passId = `${String(Math.floor(Math.random() * 90) + 10)}-${String(Math.floor(Math.random() * 1000000)).padStart(6, '0')}`; } while (store.passes.some(item => item.passId === passId));
      const pass = { id: crypto.randomUUID(), passId, userId: user.id, ...Object.fromEntries(fields.map(key => [key, String(input[key]).trim()])), personType: user.role === 'ert' ? 'ERT' : 'Student', status: 'Pending', comment: '', createdAt: new Date().toISOString(), approvals: [] };
      store.passes.unshift(pass); writeStore(store); return send(res, 201, { pass });
    }
    if (req.method === 'POST' && url.pathname.match(/^\/api\/passes\/[^/]+\/decision$/)) {
      const input = await body(req);
      if (!isStaff(user)) return send(res, 403, { error: 'Staff approval is required.' });
      const id = decodeURIComponent(url.pathname.split('/')[3]);
      const pass = store.passes.find(item => item.id === id || item.passId === id);
      if (!pass) return send(res, 404, { error: 'Pass not found.' });
      const decision = input.decision === 'Approved' ? 'Approved' : 'Rejected';
      pass.status = decision; pass.comment = String(input.comment || '').trim(); pass.approvals.push({ name: user.name, role: user.role, decision, at: new Date().toISOString() });
      writeStore(store); return send(res, 200, { pass });
    }
    if (req.method === 'POST' && url.pathname === '/api/incidents') {
      const input = await body(req); const description = String(input.description || '').trim();
      if (!description) return send(res, 400, { error: 'Describe the emergency.' });
      if (user.role === 'student' && (!user.name || !['11', '12'].includes(user.grade) || !user.section)) return send(res, 400, { error: 'Complete your name, grade level, and section in Settings before reporting.' });
      const incident = { id: crypto.randomUUID(), description, location: String(input.location || 'Campus').trim(), injury: String(input.injury || 'Unspecified').trim(), severity: String(input.severity || 'Moderate').trim(), affectedPerson: user.role === 'student' ? user.name : String(input.affectedPerson || user.name).trim(), reporterId: user.id, reporter: user.name, status: 'Pending approval', createdAt: new Date().toISOString() };
      const patient = { id: crypto.randomUUID(), name: incident.affectedPerson, grade: user.grade || '', section: user.section || '', location: incident.location, injury: incident.injury, severity: incident.severity, status: 'Pending approval', incidentId: incident.id, reporterId: user.id, createdAt: incident.createdAt, recordedBy: user.name };
      incident.patientId = patient.id;
      store.incidents.unshift(incident); store.patients.unshift(patient);
      store.notifications ||= [];
      store.notifications.unshift({ id: crypto.randomUUID(), roles: ['clinic_nurse', 'ert'], title: 'Emergency report needs approval', message: `${user.name}: ${incident.description} · ${incident.location}`, incidentId: incident.id, createdAt: incident.createdAt, readBy: [] });
      writeStore(store); return send(res, 201, { incident });
    }
    if (req.method === 'POST' && url.pathname.match(/^\/api\/incidents\/[^/]+\/approve$/)) {
      if (!['clinic_nurse', 'ert'].includes(user.role)) return send(res, 403, { error: 'Only the clinic nurse or ERT can approve emergency reports.' });
      const id = url.pathname.split('/')[3]; const incident = store.incidents.find(item => item.id === id);
      if (!incident) return send(res, 404, { error: 'Incident not found.' });
      if (incident.status !== 'Pending approval') return send(res, 409, { error: 'This report has already been reviewed.' });
      incident.status = 'Active'; incident.approvedBy = user.name; incident.approvedByRole = user.role; incident.approvedAt = new Date().toISOString();
      for (const notification of store.notifications || []) if (notification.incidentId === id && notification.roles) notification.resolved = true;
      const patient = store.patients.find(item => item.id === incident.patientId);
      if (patient) { patient.status = 'Approved'; patient.approvedBy = user.name; }
      store.notifications ||= [];
      store.notifications.unshift({ id: crypto.randomUUID(), userId: incident.reporterId, title: 'Emergency report approved', message: `Your emergency report was approved by ${user.name}.`, incidentId: id, createdAt: incident.approvedAt, readBy: [] });
      store.notifications.unshift({ id: crypto.randomUUID(), roles: ['clinic_nurse', 'ert'].filter(role => role !== user.role), title: 'Emergency report approved', message: `${user.name} approved a report: ${incident.description}`, incidentId: id, createdAt: incident.approvedAt, readBy: [] });
      writeStore(store); return send(res, 200, { incident });
    }
    if (req.method === 'POST' && url.pathname.match(/^\/api\/incidents\/[^/]+\/resolve$/)) {
      if (!isStaff(user)) return send(res, 403, { error: 'Staff access required.' });
      const incident = store.incidents.find(item => item.id === url.pathname.split('/')[3]);
      if (!incident) return send(res, 404, { error: 'Incident not found.' });
      incident.status = 'Resolved'; incident.resolvedAt = new Date().toISOString(); writeStore(store); return send(res, 200, { incident });
    }
    if (req.method === 'PATCH' && url.pathname.match(/^\/api\/incidents\/[^/]+$/)) {
      if (!['clinic_nurse', 'ert', 'admin'].includes(user.role)) return send(res, 403, { error: 'Clinic nurse, ERT, or admin access required.' });
      const id = decodeURIComponent(url.pathname.split('/')[3]);
      const incident = store.incidents.find(item => item.id === id);
      if (!incident) return send(res, 404, { error: 'Incident not found.' });
      const input = await body(req);
      const fields = ['description', 'location', 'injury', 'severity', 'affectedPerson'];
      const next = Object.fromEntries(fields.map(key => [key, String(input[key] ?? incident[key] ?? '').trim()]));
      if (!next.description || !next.location || !next.injury || !next.severity || !next.affectedPerson) return send(res, 400, { error: 'Complete all incident details.' });
      incident.revisions ||= [];
      incident.revisions.push({ ...Object.fromEntries(fields.map(key => [key, incident[key] || ''])), editedBy: user.name, editorRole: user.role, editedAt: new Date().toISOString() });
      Object.assign(incident, next, { editedBy: user.name, editedAt: new Date().toISOString() });
      const patient = store.patients.find(item => item.id === incident.patientId);
      if (patient) Object.assign(patient, { name: incident.affectedPerson, location: incident.location, injury: incident.injury, severity: incident.severity, editedBy: user.name, editedAt: incident.editedAt });
      writeStore(store); return send(res, 200, { incident });
    }
    if (req.method === 'POST' && url.pathname === '/api/patients') {
      if (!isStaff(user)) return send(res, 403, { error: 'Staff access required.' });
      const input = await body(req); const name = String(input.name || '').trim();
      if (!name) return send(res, 400, { error: 'Enter a patient name.' });
      const patient = { id: crypto.randomUUID(), name, grade: String(input.grade || '').trim(), section: String(input.section || '').trim(), location: String(input.location || '').trim(), injury: String(input.injury || '').trim(), severity: String(input.severity || '').trim(), details: String(input.details || '').trim(), createdAt: new Date().toISOString(), recordedBy: user.name };
      store.patients.unshift(patient); writeStore(store); return send(res, 201, { patient });
    }
    if (req.method === 'PATCH' && url.pathname.match(/^\/api\/patients\/[^/]+$/)) {
      if (!['clinic_nurse', 'ert', 'admin'].includes(user.role)) return send(res, 403, { error: 'Clinic nurse, ERT, or admin access required.' });
      const id = decodeURIComponent(url.pathname.split('/')[3]);
      const patient = store.patients.find(item => item.id === id);
      if (!patient) return send(res, 404, { error: 'Patient record not found.' });
      const input = await body(req);
      const fields = ['name', 'grade', 'section', 'location', 'injury', 'severity', 'details'];
      const next = Object.fromEntries(fields.map(key => [key, String(input[key] ?? patient[key] ?? '').trim()]));
      if (!next.name || !next.location || !next.injury || !next.severity) return send(res, 400, { error: 'Complete all patient details.' });
      patient.revisions ||= [];
      patient.revisions.push({ ...Object.fromEntries(fields.map(key => [key, patient[key] || ''])), editedBy: user.name, editorRole: user.role, editedAt: new Date().toISOString() });
      Object.assign(patient, next, { editedBy: user.name, editedAt: new Date().toISOString() });
      const incident = store.incidents.find(item => item.id === patient.incidentId);
      if (incident) {
        const linkedFields = { affectedPerson: patient.name, location: patient.location, injury: patient.injury, severity: patient.severity };
        incident.revisions ||= [];
        incident.revisions.push({ description: incident.description, location: incident.location, injury: incident.injury, severity: incident.severity, affectedPerson: incident.affectedPerson, editedBy: user.name, editorRole: user.role, editedAt: patient.editedAt });
        Object.assign(incident, linkedFields, { editedBy: user.name, editedAt: patient.editedAt });
      }
      writeStore(store); return send(res, 200, { patient });
    }
    if (req.method === 'DELETE' && url.pathname.match(/^\/api\/patients\/[^/]+$/)) {
      if (!['clinic_nurse', 'ert'].includes(user.role)) return send(res, 403, { error: 'Only the clinic nurse or ERT can remove patient records.' });
      const id = decodeURIComponent(url.pathname.split('/')[3]);
      const index = store.patients.findIndex(item => item.id === id);
      if (index < 0) return send(res, 404, { error: 'Patient record not found.' });
      store.patients.splice(index, 1); writeStore(store); return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      const input = await body(req); const name = String(input.name || '').trim();
      const grade = String(input.grade || user.grade || '').trim();
      const section = String(input.section || user.section || '').trim();
      if (name.length < 2) return send(res, 400, { error: user.role === 'student' ? 'Enter your full name.' : 'Enter a nickname with at least 2 characters.' });
      if (user.role === 'student' && (!['11', '12'].includes(grade) || !section)) return send(res, 400, { error: 'Choose grade 11 or 12 and enter your section.' });
      if (String(input.password || '') && String(input.password).length < 8) return send(res, 400, { error: 'New passwords need at least 8 characters.' });
      if (isStaff(user) && String(input.password || '')) return send(res, 400, { error: 'Staff accounts use the shared admin sign up password.' });
      const nextIdentifier = user.role === 'student' ? user.email : name;
      if (store.users.some(item => item.id !== user.id && [item.identifier, item.schoolId, item.name].filter(Boolean).some(value => value.toLowerCase() === nextIdentifier.toLowerCase()))) return send(res, 409, { error: 'That nickname is already in use.' });
      user.name = name;
      user.identifier = nextIdentifier;
      user.grade = grade;
      user.section = section;
      if (String(input.password || '')) Object.assign(user, hash(String(input.password)));
      if (input.profileImage !== undefined) {
        const image = String(input.profileImage || '');
        if (image.length > 1500000 || (image && !/^data:image\/(png|jpeg|webp);base64,/.test(image))) return send(res, 400, { error: 'Upload a PNG, JPG, or WebP image under 1 MB.' });
        user.profileImage = image;
      }
      writeStore(store); return send(res, 200, { user: safeUser(user) });
    }
    if (req.method === 'POST' && url.pathname === '/api/student-id') {
      if (user.role !== 'student') return send(res, 403, { error: 'Student accounts only.' });
      const input = await body(req); const studentId = String(input.studentId || '').trim();
      if (!/^\d{2}-\d{6}$/.test(studentId)) return send(res, 400, { error: 'Student ID must use the format 12-345678.' });
      if (store.users.some(item => item.id !== user.id && item.studentId === studentId)) return send(res, 409, { error: 'That Student ID is already registered.' });
      user.studentId = studentId; writeStore(store); return send(res, 200, { user: safeUser(user) });
    }
    return send(res, 404, { error: 'Not found.' });
  }
  const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  if (!['index.html', 'styles.css', 'script.js'].includes(requested)) { res.writeHead(404); return res.end('Not found'); }
  const target = path.resolve(root, requested);
  if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(target).pipe(res);
}

http.createServer((req, res) => route(req, res).catch(error => send(res, 500, { error: error.message || 'Server error.' }))).listen(port, () => console.log(`EPARTS running at http://localhost:${port}`));

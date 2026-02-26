/* =========================
   Gestor de tareas por empresa (PRO)
   - Firestore (cloud) + LocalStorage fallback
   - Auth Email/Password (login)
   - Código: PT-YYYYMMDD-0001
   - Estados avanzados
   - Editar tareas
   - Imprimir nota de trabajo
========================= */

/* ========= IMPORTS (SIEMPRE ARRIBA) ========= */
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

import {
  collection,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ========= FIREBASE INSTANCES (desde index.html) ========= */
const auth = window.firebaseAuth;
const db = window.firebaseDB;

if (!auth || !db) {
  throw new Error("Firebase Auth/DB no disponibles. Revisa el orden de scripts en index.html.");
}

/* ========= HELPERS AUTH UI ========= */
const $ = (id) => document.getElementById(id);

const authEmail = () => ($("authEmail")?.value || "").trim();
const authPass  = () => ($("authPass")?.value || "");

function setAuthStatus(msg) {
  const el = $("authStatus");
  if (el) el.textContent = msg || "";
}

async function doLogin() {
  setAuthStatus("Entrando...");
  await signInWithEmailAndPassword(auth, authEmail(), authPass());
}

async function doLogout() {
  setAuthStatus("Cerrando sesión...");
  await signOut(auth);
}

/* ===============================
   FIRESTORE SYNC (1 usuario / multi-dispositivo)
   Ruta: users/{uid}/tasks/{taskId}
=============================== */
let cloudUid = null;
let unsubscribeCloud = null;

function isCloudMode() {
  return !!cloudUid;
}

function tasksCol(uid) {
  return collection(db, "users", uid, "tasks");
}

function fromDoc(d) {
  const data = d.data() || {};
  return { id: d.id, ...data };
}

function toPayload(task) {
  const payload = { ...task };
  delete payload.id;

  // Para orden estable en cloud: timestamp real
  // (No rompe tu UI: tu UI sigue usando createdAt string)
  payload.createdAtTs = payload.createdAtTs || serverTimestamp();
  payload.updatedAtTs = serverTimestamp();

  return payload;
}

async function cloudCreateTask(task) {
  if (!cloudUid) throw new Error("No hay sesión iniciada.");
  // Usamos setDoc con ID fijo para mantener tu id y no romper editar/imprimir
  await setDoc(doc(db, "users", cloudUid, "tasks", task.id), toPayload(task), { merge: false });
}

async function cloudUpsertTask(taskId, patchOrFull) {
  if (!cloudUid) throw new Error("No hay sesión iniciada.");
  // merge true para actualizar parcial o total sin borrar campos
  await setDoc(doc(db, "users", cloudUid, "tasks", taskId), toPayload({ id: taskId, ...patchOrFull }), { merge: true });
}

async function cloudPatchTask(taskId, patch) {
  if (!cloudUid) throw new Error("No hay sesión iniciada.");
  await updateDoc(doc(db, "users", cloudUid, "tasks", taskId), {
    ...patch,
    updatedAtTs: serverTimestamp(),
  });
}

async function cloudDeleteTask(taskId) {
  if (!cloudUid) throw new Error("No hay sesión iniciada.");
  await deleteDoc(doc(db, "users", cloudUid, "tasks", taskId));
}

async function cloudClearAll() {
  if (!cloudUid) throw new Error("No hay sesión iniciada.");
  const snap = await getDocs(tasksCol(cloudUid));
  const deletions = snap.docs.map(d => deleteDoc(d.ref));
  await Promise.all(deletions);
}

function startCloudListener(onTasks) {
  if (!cloudUid) return;
  if (unsubscribeCloud) unsubscribeCloud();

  // Orden por timestamp real, y si no existe (tareas viejas), Firestore las pondrá al final
  const q = query(tasksCol(cloudUid), orderBy("createdAtTs", "asc"));

  unsubscribeCloud = onSnapshot(q, (snap) => {
    const list = snap.docs.map(fromDoc);

    // Normalizamos para que tu UI nunca reviente aunque falten campos
    const normalized = list.map(t => ({
      status: "PENDING",
      doneAt: "",
      priority: "Media",
      dueDate: "",
      assignee: "",
      nextAction: "",
      details: "",
      ...t,
      // Asegurar createdAt string si faltase (por si alguna vieja)
      createdAt: t.createdAt || "",
    }));

    onTasks(normalized);
  });
}

/* =========================
   APP PRO ORIGINAL (con mínima adaptación Cloud)
========================= */

const LS_KEY = "gtp_tasks_v2";

const el = (id) => document.getElementById(id);
const activeCompanyLabel = el("activeCompanyLabel");

// --- elementos UI
const form = el("taskForm");
const tbody = el("taskTbody");
const btnReset = el("btnReset");
const btnClearAll = el("btnClearAll");
const btnExport = el("btnExport");
const fileImport = el("fileImport");
const btnPrintNow = el("btnPrintNow");
const btnPrintBack = el("btnPrintBack");
const printArea = el("printArea");
const filterCompany = el("filterCompany");
const activeCompany = el("activeCompany");
const btnSetCompany = el("btnSetCompany");
const btnClearCompany = el("btnClearCompany");
const filterStatus = el("filterStatus");
const sortBy = el("sortBy");

const fields = {
  company: el("company"),
  title: el("title"),
  dueDate: el("dueDate"),
  priority: el("priority"),
  status: el("status"), // puede ser null si tu index no lo tiene aún
  assignee: el("assignee"),
  nextAction: el("nextAction"),
  details: el("details"),
};

let tasks = [];                  // ahora se setea por login: local o cloud
let activeCompanyValue = "ALL";
let editingId = null;
const submitBtn = form?.querySelector('button[type="submit"]');

// -------------------------
// Utilidades
// -------------------------
function pad(n){ return String(n).padStart(2,"0"); }

function nowISO(){
  const d = new Date();
  const y = d.getFullYear();
  const m = pad(d.getMonth()+1);
  const day = pad(d.getDate());
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

function todayCodePart(){
  const d = new Date();
  const y = d.getFullYear();
  const m = pad(d.getMonth()+1);
  const day = pad(d.getDate());
  return `${y}${m}${day}`; // YYYYMMDD
}

function formatDateISOToES(iso){
  if(!iso) return "";
  const [y,m,d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function escapeHtml(str){
  return String(str ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

// -------------------------
// LocalStorage (fallback)
// -------------------------
function loadTasks(){
  try{
    const raw = localStorage.getItem(LS_KEY);
    if(raw){
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    }
  }catch{}

  // Migración: si venías de v1
  try{
    const rawV1 = localStorage.getItem("gtp_tasks_v1");
    if(rawV1){
      const parsedV1 = JSON.parse(rawV1);
      const migrated = Array.isArray(parsedV1) ? parsedV1.map(t => ({
        ...t,
        status: t.status || "PENDING",
        doneAt: t.doneAt || "",
      })) : [];
      localStorage.setItem(LS_KEY, JSON.stringify(migrated));
      return migrated;
    }
  }catch{}

  return [];
}

function saveTasks(){
  // Si estamos en cloud, NO guardamos en local.
  if (isCloudMode()) return;
  localStorage.setItem(LS_KEY, JSON.stringify(tasks));
}

// -------------------------
// Código correlativo por día
// -------------------------
function nextDailySequence(datePartYYYYMMDD){
  const sameDay = tasks.filter(t => (t.code || "").includes(`PT-${datePartYYYYMMDD}-`));
  const max = sameDay.reduce((acc, t) => {
    const seg = String(t.code || "").split("-").pop();
    const n = Number(seg);
    return Number.isFinite(n) ? Math.max(acc, n) : acc;
  }, 0);
  return max + 1;
}

function buildTaskCode(){
  const datePart = todayCodePart();
  const seq = nextDailySequence(datePart);
  return `PT-${datePart}-${String(seq).padStart(4,"0")}`;
}

// -------------------------
// Formulario
// -------------------------
function resetForm(){
  form.reset();
  if(fields.priority) fields.priority.value = "Media";
  if(fields.status) fields.status.value = "PENDING";
}

function exitEditMode(){
  editingId = null;
  if(submitBtn) submitBtn.textContent = "Guardar tarea";
  resetForm();
}

function enterEditMode(task){
  editingId = task.id;

  fields.company.value = task.company || "";
  fields.title.value = task.title || "";
  fields.dueDate.value = task.dueDate || "";
  fields.priority.value = task.priority || "Media";
  if(fields.status) fields.status.value = task.status || "PENDING";
  fields.assignee.value = task.assignee || "";
  fields.nextAction.value = task.nextAction || "";
  fields.details.value = task.details || "";

  if(submitBtn) submitBtn.textContent = "Guardar cambios";
}

function createTaskFromForm(){
  const company = fields.company.value.trim();
  const title = fields.title.value.trim();
  if(!company || !title) return null;

  const status = fields.status ? (fields.status.value || "PENDING") : "PENDING";

  return {
    id: (crypto?.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()),
    code: buildTaskCode(),
    company,
    title,
    dueDate: fields.dueDate.value || "",
    priority: fields.priority.value || "Media",
    status,
    assignee: fields.assignee.value.trim(),
    nextAction: fields.nextAction.value.trim(),
    details: fields.details.value.trim(),
    createdAt: nowISO(),
    // Para cloud: marca createdAtTs real (siempre que creemos desde UI)
    createdAtTs: serverTimestamp(),
    doneAt: status === "DONE" ? nowISO() : "",
  };
}

async function updateTaskFromForm(id){
  const company = fields.company.value.trim();
  const title = fields.title.value.trim();
  if(!company || !title) return false;

  const old = tasks.find(t => t.id === id);
  const newStatus = fields.status ? (fields.status.value || "PENDING") : (old?.status || "PENDING");

  const wasDone = (old?.status === "DONE");
  const nowDone = (newStatus === "DONE");

  const patch = {
    company,
    title,
    dueDate: fields.dueDate.value || "",
    priority: fields.priority.value || "Media",
    status: newStatus,
    assignee: fields.assignee.value.trim(),
    nextAction: fields.nextAction.value.trim(),
    details: fields.details.value.trim(),
    doneAt: nowDone ? (wasDone ? (old?.doneAt || nowISO()) : nowISO()) : "",
  };

  if (isCloudMode()) {
    await cloudUpsertTask(id, patch);
    exitEditMode();
    return true;
  }

  tasks = tasks.map(t => (t.id !== id ? t : { ...t, ...patch }));
  saveTasks();
  render();
  exitEditMode();
  return true;
}

// -------------------------
// Estados
// -------------------------
async function setTaskStatus(id, status){
  const old = tasks.find(t => t.id === id);

  const patch = {
    status,
    doneAt: (status === "DONE")
      ? (old?.doneAt || nowISO())
      : "",
  };

  if (isCloudMode()) {
    await cloudPatchTask(id, patch);
    return;
  }

  tasks = tasks.map(t => (t.id !== id ? t : { ...t, ...patch }));
  saveTasks();
  render();
}

function statusBadge(t){
  const s = t.status || "PENDING";
  if(s === "DONE") return `<span class="badge ok">Realizado</span>`;
  if(s === "IN_PROGRESS") return `<span class="badge progress">En curso</span>`;
  if(s === "WAITING_CLIENT") return `<span class="badge waiting">En espera cliente</span>`;
  return `<span class="badge pending">Pendiente</span>`;
}

function priorityWeight(p){
  const map = { "Baja":1, "Media":2, "Alta":3, "Urgente":4 };
  return map[p] ?? 0;
}

// -------------------------
// Filtros y orden
// -------------------------
function applyFiltersAndSort(list){
  const qCompany = (filterCompany?.value || "").trim().toLowerCase();
  const status = filterStatus?.value || "ALL";

  let out = [...list];

  if(qCompany){
    out = out.filter(t => (t.company || "").toLowerCase().includes(qCompany));
  }
  if(activeCompanyValue !== "ALL"){
    out = out.filter(t => (t.company || "") === activeCompanyValue);
  }
  if(status !== "ALL"){
    out = out.filter(t => (t.status || "PENDING") === status);
  }

  const sort = sortBy?.value || "createdDesc";
  out.sort((a,b) => {
    if(sort === "createdDesc") return (b.createdAt || "").localeCompare(a.createdAt || "");
    if(sort === "dueAsc") return (a.dueDate || "9999-12-31").localeCompare(b.dueDate || "9999-12-31");
    if(sort === "priorityDesc") return priorityWeight(b.priority) - priorityWeight(a.priority);
    if(sort === "companyAsc") return (a.company || "").localeCompare(b.company || "");
    return 0;
  });

  return out;
}

// -------------------------
// Render tabla
// -------------------------
function updateDashboard(){
  const counts = {
    PENDING: 0,
    IN_PROGRESS: 0,
    WAITING_CLIENT: 0,
    DONE: 0,
  };

  for(const t of tasks){
    const s = t.status || "PENDING";
    if(counts[s] === undefined) counts.PENDING++;
    else counts[s]++;
  }

  const p = el("kpiPending");
  const pr = el("kpiProgress");
  const w = el("kpiWaiting");
  const d = el("kpiDone");

  if(p) p.textContent = String(counts.PENDING);
  if(pr) pr.textContent = String(counts.IN_PROGRESS);
  if(w) w.textContent = String(counts.WAITING_CLIENT);
  if(d) d.textContent = String(counts.DONE);
}

function getCompanies(){
  const set = new Set();
  for(const t of tasks){
    const name = (t.company || "").trim();
    if(name) set.add(name);
  }
  return Array.from(set).sort((a,b)=>a.localeCompare(b));
}

function refreshCompanySelector(){
  if(!activeCompany) return;

  const current = activeCompany.value || "ALL";
  const companies = getCompanies();

  activeCompany.innerHTML = `<option value="ALL">Todas las empresas</option>` +
    companies.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");

  const stillExists = companies.includes(current);
  activeCompany.value = stillExists ? current : "ALL";
}

function applyActiveCompanyToForm(){
  if(editingId) return;

  if(activeCompanyValue !== "ALL"){
    if(fields.company) fields.company.value = activeCompanyValue;
  }else{
    if(fields.company) fields.company.value = "";
  }
}

function render(){
  const view = applyFiltersAndSort(tasks);
  updateDashboard();
  refreshCompanySelector();

  if(activeCompanyLabel){
    if(activeCompanyValue === "ALL"){
      activeCompanyLabel.textContent = "📌 Todas las empresas";
    }else{
      activeCompanyLabel.textContent = "📌 Empresa activa: " + activeCompanyValue;
    }
  }

  tbody.innerHTML = view.map(t => `
    <tr>
      <td>
        <strong>${escapeHtml(t.code)}</strong><br>
        <span class="muted small">${escapeHtml(t.createdAt)}</span>
      </td>

      <td>${escapeHtml(t.company)}</td>

      <td>
        <strong>${escapeHtml(t.title)}</strong>
        ${t.nextAction ? `<div class="muted small">Siguiente: ${escapeHtml(t.nextAction)}</div>` : ""}
      </td>

      <td>${escapeHtml(t.priority)}</td>

      <td>${t.dueDate ? escapeHtml(formatDateISOToES(t.dueDate)) : "<span class='muted'>-</span>"}</td>

      <td>${statusBadge(t)}</td>

      <td class="right">
        <div class="row-actions">
          <button type="button" data-action="edit" data-id="${t.id}">Editar</button>

          ${(t.status || "PENDING") !== "DONE"
            ? `
              <button type="button" data-action="set_in_progress" data-id="${t.id}">En curso</button>
              <button type="button" data-action="set_waiting" data-id="${t.id}">Espera cliente</button>
              <button type="button" data-action="set_done" data-id="${t.id}">Realizado</button>
            `
            : `
              <button type="button" data-action="set_pending" data-id="${t.id}">Reabrir</button>
            `
          }

          <button type="button" data-action="print" data-id="${t.id}">Imprimir</button>
          <button type="button" data-action="delete" data-id="${t.id}">Eliminar</button>
        </div>
      </td>
    </tr>
  `).join("");
}

// -------------------------
// Imprimir
// -------------------------
function fillPrint(task){
  const headerEl = el("pHeaderOrg");
  if(headerEl){
    const PRINT_HEADER = [
      "Juan Carlos García",
      "Servicios profesionales · Gestión administrativa · RR.PP.",
      "Tel: 610 673 307",
      "Email: juancarlosgardy6@gmail.com"
    ].join("\n");
    headerEl.textContent = PRINT_HEADER;
  }

  el("pCode").textContent = task.code || "";
  el("pCreated").textContent = task.createdAt || "";
  el("pStatus").textContent =
    (task.status === "DONE")
      ? `Realizado (${task.doneAt || ""})`
      : (task.status === "IN_PROGRESS")
        ? "En curso"
        : (task.status === "WAITING_CLIENT")
          ? "En espera cliente"
          : "Pendiente";

  el("pCompany").textContent = task.company || "";
  el("pTitle").textContent = task.title || "";
  el("pPriority").textContent = task.priority || "";
  el("pDue").textContent = task.dueDate ? formatDateISOToES(task.dueDate) : "-";
  el("pAssignee").textContent = task.assignee || "-";
  el("pNextAction").textContent = task.nextAction || "-";
  el("pDetails").textContent = task.details || "-";
}

function showPrintPreview(){
  document.body.classList.add("print-preview");
  if(printArea) printArea.setAttribute("aria-hidden", "false");
}

function hidePrintPreview(){
  document.body.classList.remove("print-preview");
  if(printArea) printArea.setAttribute("aria-hidden", "true");
}

function printTask(id){
  const task = tasks.find(t => t.id === id);
  if(!task) return;
  fillPrint(task);
  showPrintPreview();
}

// -------------------------
// Eventos
// -------------------------
form.addEventListener("submit", async (e) => {
  e.preventDefault();

  if(editingId){
    const ok = await updateTaskFromForm(editingId);
    if(!ok) return;
    return;
  }

  const task = createTaskFromForm();
  if(!task) return;

  if (isCloudMode()) {
    await cloudCreateTask(task);
    resetForm();
    return; // onSnapshot refresca
  }

  tasks.unshift(task);
  saveTasks();
  render();
  resetForm();
});

btnReset.addEventListener("click", () => {
  if(editingId) exitEditMode();
  else resetForm();
});

btnClearAll?.addEventListener("click", async () => {
  const ok = confirm(isCloudMode()
    ? "Esto borrará todas las tareas guardadas en la nube (Firestore). ¿Continuar?"
    : "Esto borrará todas las tareas guardadas en este navegador. ¿Continuar?"
  );
  if(!ok) return;

  if (isCloudMode()) {
    await cloudClearAll();
    return; // onSnapshot refresca
  }

  tasks = [];
  saveTasks();
  render();
});

tbody.addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if(!btn) return;

  const id = btn.dataset.id;
  const action = btn.dataset.action;

  if(action === "edit"){
    const task = tasks.find(t => t.id === id);
    if(task) enterEditMode(task);
    return;
  }

  if(action === "set_pending") return setTaskStatus(id, "PENDING");
  if(action === "set_in_progress") return setTaskStatus(id, "IN_PROGRESS");
  if(action === "set_waiting") return setTaskStatus(id, "WAITING_CLIENT");
  if(action === "set_done") return setTaskStatus(id, "DONE");

  if(action === "print") return printTask(id);

  if(action === "delete"){
    const ok = confirm("¿Eliminar esta tarea?");
    if(!ok) return;
    return deleteTask(id);
  }
});

async function deleteTask(id){
  if (isCloudMode()) {
    await cloudDeleteTask(id);
    return; // onSnapshot refresca
  }
  tasks = tasks.filter(t => t.id !== id);
  saveTasks();
  render();
}

// filtros
[filterCompany, filterStatus, sortBy].forEach(ctrl => {
  if(!ctrl) return;
  ctrl.addEventListener("input", render);
  ctrl.addEventListener("change", render);
});

btnSetCompany?.addEventListener("click", () => {
  if(!activeCompany) return;
  activeCompanyValue = activeCompany.value || "ALL";

  if(activeCompanyValue !== "ALL" && filterCompany){
    filterCompany.value = activeCompanyValue;
  }

  render();
});

btnClearCompany?.addEventListener("click", () => {
  activeCompanyValue = "ALL";
  if(activeCompany) activeCompany.value = "ALL";
  applyActiveCompanyToForm();
  render();
});

activeCompany?.addEventListener("change", () => {
  activeCompanyValue = activeCompany.value || "ALL";

  if(activeCompanyValue !== "ALL" && filterCompany){
    filterCompany.value = activeCompanyValue;
  }
  if(activeCompanyValue === "ALL" && filterCompany){
    filterCompany.value = "";
  }

  applyActiveCompanyToForm();
  render();
});

// Export/Import (solo local; si quieres, luego lo hacemos cloud también)
btnExport.addEventListener("click", () => {
  const payload = {
    exportedAt: nowISO(),
    version: 2,
    tasks
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `tareas_export_${todayCodePart()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();

  URL.revokeObjectURL(url);
});

fileImport.addEventListener("change", async () => {
  const file = fileImport.files?.[0];
  if(!file) return;

  try{
    const text = await file.text();
    const data = JSON.parse(text);
    if(!data || !Array.isArray(data.tasks)) throw new Error("Formato no válido");

    const ok = confirm(isCloudMode()
      ? "Esto importará tareas a la nube y reemplazará las actuales. ¿Continuar?"
      : "Esto importará tareas y reemplazará las actuales en este navegador. ¿Continuar?"
    );
    if(!ok) return;

    const imported = data.tasks.map(t => ({
      ...t,
      status: t.status || "PENDING",
      doneAt: t.doneAt || "",
    }));

    if (isCloudMode()) {
      await cloudClearAll();
      for (const t of imported) {
        // asegurar id
        const task = { ...t, id: t.id || (crypto?.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()) };
        if (!task.createdAt) task.createdAt = nowISO();
        task.createdAtTs = serverTimestamp();
        await cloudCreateTask(task);
      }
      exitEditMode();
      return;
    }

    tasks = imported;
    saveTasks();
    render();
    exitEditMode();

  }catch{
    alert("No se pudo importar. Asegúrate de seleccionar un JSON exportado desde esta herramienta.");
  }finally{
    fileImport.value = "";
  }
});

btnPrintNow?.addEventListener("click", () => {
  window.print();
});

btnPrintBack?.addEventListener("click", () => {
  hidePrintPreview();
});

window.addEventListener("afterprint", () => {
  hidePrintPreview();
});

/* ========= INIT UI ========= */
function initUI() {
  refreshCompanySelector();
  applyActiveCompanyToForm();
  render();
}

/* ========= AUTH + SYNC BOOTSTRAP ========= */
window.addEventListener("DOMContentLoaded", () => {
  $("btnLogin")?.addEventListener("click", async () => {
    try { await doLogin(); } catch (e) { setAuthStatus(e.message); }
  });

    $("btnLogout")?.addEventListener("click", async () => {
    try { await doLogout(); } catch (e) { setAuthStatus(e.message); }
  });

  onAuthStateChanged(auth, (user) => {
     const MI_EMAIL = "juancarlosgardy6@gmail.com";
console.log("MI UID:", user.uid);
if (user && user.email !== MI_EMAIL) {
  await signOut(auth);
  setAuthStatus("Usuario no autorizado.");
  return;
}
    cloudUid = user?.uid || null;

    if (user) {
      setAuthStatus(`Conectado: ${user.email}`);
       // Re-activar UI
const f = $("taskForm");
if (f) f.querySelectorAll("input, select, textarea, button").forEach(x => x.disabled = false);

if (btnExport) btnExport.disabled = false;
if (fileImport) fileImport.disabled = false;
if (btnClearAll) btnClearAll.disabled = false;
      if ($("btnLogout")) $("btnLogout").style.display = "inline-block";

      startCloudListener((cloudTasks) => {
        tasks = cloudTasks;
        initUI();
      });

    } else {
  setAuthStatus("Debes iniciar sesión para usar la aplicación.");
  if ($("btnLogout")) $("btnLogout").style.display = "none";

  // Vaciar datos en pantalla
  tasks = [];
  initUI();

  // Bloquear formulario y acciones
  const f = $("taskForm");
  if (f) f.querySelectorAll("input, select, textarea, button").forEach(x => x.disabled = true);

  // Opcional: bloquear export/import también
  if (btnExport) btnExport.disabled = true;
  if (fileImport) fileImport.disabled = true;
  if (btnClearAll) btnClearAll.disabled = true;
}
  });
});

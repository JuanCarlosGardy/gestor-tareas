/* =========================
   Gestor de tareas por empresa
========================= */

/* ========= IMPORTS (SIEMPRE ARRIBA) ========= */

import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

import {
  collection,
  doc,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ========= FIREBASE INSTANCES ========= */

const auth = window.firebaseAuth;
const db = window.firebaseDB;

if (!auth || !db) {
  throw new Error("Firebase Auth/DB no disponibles. Revisa index.html.");
}

/* ========= HELPERS ========= */

const $ = (id) => document.getElementById(id);

/* ========= AUTH ========= */

const authEmail = () => ($("authEmail")?.value || "").trim();
const authPass = () => $("authPass")?.value || "";

function setAuthStatus(msg) {
  const el = $("authStatus");
  if (el) el.textContent = msg || "";
}

async function doLogin() {
  setAuthStatus("Entrando...");
  await signInWithEmailAndPassword(auth, authEmail(), authPass());
}

async function doRegister() {
  setAuthStatus("Creando usuario...");
  await createUserWithEmailAndPassword(auth, authEmail(), authPass());
}

async function doLogout() {
  setAuthStatus("Cerrando sesión...");
  await signOut(auth);
}

/* ========= CLOUD SYNC ========= */

let cloudUid = null;
let unsubscribeCloud = null;

function tasksCol(uid) {
  return collection(db, "users", uid, "tasks");
}

function fromDoc(d) {
  return { id: d.id, ...d.data() };
}

function toPayload(task) {
  const payload = { ...task };
  delete payload.id;
  payload.updatedAt = serverTimestamp();
  if (!payload.createdAt) payload.createdAt = serverTimestamp();
  return payload;
}

async function cloudCreateTask(task) {
  await addDoc(tasksCol(cloudUid), toPayload(task));
}

async function cloudDeleteTask(taskId) {
  await deleteDoc(doc(db, "users", cloudUid, "tasks", taskId));
}

function startCloudListener(onTasks) {
  if (unsubscribeCloud) unsubscribeCloud();

  const q = query(tasksCol(cloudUid), orderBy("createdAt", "asc"));

  unsubscribeCloud = onSnapshot(q, (snap) => {
    const list = snap.docs.map(fromDoc);
    onTasks(list);
  });
}

/* ========= LOCAL MODE ========= */

const LS_KEY = "gtp_tasks_v2";

function loadTasks(){
  try{
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : [];
  }catch{
    return [];
  }
}

function saveTasks(){
  localStorage.setItem(LS_KEY, JSON.stringify(tasks));
}

/* ========= APP STATE ========= */

let tasks = [];
let editingId = null;

/* ========= INIT AUTH + SYNC ========= */

onAuthStateChanged(auth, (user) => {
  cloudUid = user?.uid || null;

  if (user) {
    setAuthStatus(`Conectado: ${user.email}`);
    $("btnLogout")?.style && ($("btnLogout").style.display = "inline-block");

    startCloudListener((cloudTasks) => {
      tasks = cloudTasks;
      render();
    });

  } else {
    setAuthStatus("Modo invitado");
    $("btnLogout")?.style && ($("btnLogout").style.display = "none");

    tasks = loadTasks();
    render();
  }
});

/* ========= DOM READY ========= */

window.addEventListener("DOMContentLoaded", () => {

  $("btnLogin")?.addEventListener("click", async () => {
    try { await doLogin(); } catch (e) { setAuthStatus(e.message); }
  });

  $("btnRegister")?.addEventListener("click", async () => {
    try { await doRegister(); } catch (e) { setAuthStatus(e.message); }
  });

  $("btnLogout")?.addEventListener("click", async () => {
    try { await doLogout(); } catch (e) { setAuthStatus(e.message); }
  });

});

/* ========= CORE LOGIC ========= */

function nowISO(){
  return new Date().toISOString();
}

function buildTaskCode(){
  return "PT-" + Date.now();
}

function createTaskFromForm(){
  const company = $("company")?.value.trim();
  const title = $("title")?.value.trim();
  if(!company || !title) return null;

  return {
    id: crypto.randomUUID(),
    code: buildTaskCode(),
    company,
    title,
    createdAt: nowISO(),
  };
}

/* ========= FORM ========= */

$("taskForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();

  const task = createTaskFromForm();
  if(!task) return;

  if (cloudUid) {
    await cloudCreateTask(task);
  } else {
    tasks.unshift(task);
    saveTasks();
    render();
  }

  e.target.reset();
});

/* ========= DELETE ========= */

function deleteTask(id){
  if (cloudUid) {
    cloudDeleteTask(id);
  } else {
    tasks = tasks.filter(t => t.id !== id);
    saveTasks();
    render();
  }
}

/* ========= RENDER ========= */

function render(){
  const tbody = $("taskTbody");
  if(!tbody) return;

  tbody.innerHTML = tasks.map(t => `
    <tr>
      <td>${t.code}</td>
      <td>${t.company}</td>
      <td>${t.title}</td>
      <td>
        <button data-id="${t.id}" class="deleteBtn">Eliminar</button>
      </td>
    </tr>
  `).join("");

  document.querySelectorAll(".deleteBtn").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      deleteTask(btn.dataset.id);
    });
  });
}

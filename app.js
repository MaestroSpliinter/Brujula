const SUBJECTS = [
  { name: "Matemáticas", color: "#8f9fff" },
  { name: "Filosofía", color: "#d0a2e8" },
  { name: "Historia de España", color: "#e7a879" },
  { name: "Inglés", color: "#77c9c4" },
  { name: "Física", color: "#80b5ed" },
  { name: "Lengua", color: "#e591a2" },
  { name: "Tecnología", color: "#91c58d" },
  { name: "Catalán", color: "#edc66e" },
];
const EVENT_TYPES = {
  exam: { label: "Examen", color: "#ee8999" },
  homework: { label: "Deberes", color: "#e5ad73" },
  study: { label: "Estudio", color: "#8eb9ed" },
  reminder: { label: "Recordatorio", color: "#b69df1" },
};
const DEFAULTS = {
  events: [],
  tasks: [],
  notes: [],
  settings: {
    classroomUrl: "https://classroom.google.com/",
    goodnotesUrl: "https://www.goodnotes.com/",
    githubUrl: "https://github.com/MaestroSpliinter",
    claudeUrl: "https://claude.ai/",
  },
};
const SUPABASE_URL = "https://fwpoypmmdfbtgbizwqso.supabase.co";
const SUPABASE_PUBLIC_KEY = "sb_publishable_pfmNmSZcEEGgoRNT9Fe2vw_mwpEbo0m";
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLIC_KEY);
const LOCAL_OWNER_KEY = "brujula-owner-id";

const root = document.querySelector("#view-root");
const editorDialog = document.querySelector("#editor-dialog");
const editorForm = document.querySelector("#editor-form");
const dialogFields = document.querySelector("#dialog-fields");
const settingsDialog = document.querySelector("#settings-dialog");
const settingsForm = document.querySelector("#settings-form");
const toast = document.querySelector("#toast");
const authDialog = document.querySelector("#auth-dialog");
const authForm = document.querySelector("#auth-form");
let state = loadState();
let activeUser = null;
let cloudSyncReady = false;
let cloudSyncStatus = "local";
let accountSyncPromise = null;
let accountSyncUserId = null;
let cloudSaveQueue = Promise.resolve();
let cloudRefreshPromise = null;
let stateRevision = 0;
let activeView = "calendar";
let calendarDate = new Date();
let selectedDate = dateKey(new Date());
let selectedSubject = "Todas";
let toastTimer;
let editingNoteId = null;

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem("brujula-data"));
    if (!saved) return structuredClone(DEFAULTS);
    const restored = { ...structuredClone(DEFAULTS), ...saved, settings: { ...DEFAULTS.settings, ...saved.settings } };
    if (restored.settings.githubUrl === "https://github.com/") {
      restored.settings.githubUrl = DEFAULTS.settings.githubUrl;
    }
    return restored;
  } catch (error) {
    console.error("No se pudieron cargar los datos guardados.", error);
    showToast("No se pudieron leer los datos guardados. Se iniciará una sesión vacía.");
    return structuredClone(DEFAULTS);
  }
}

function saveState() {
  try {
    localStorage.setItem("brujula-data", JSON.stringify(state));
    stateRevision += 1;
  } catch (error) {
    console.error("No se pudieron guardar los datos.", error);
    showToast("No se pudieron guardar los cambios. Revisa el almacenamiento del navegador.");
    return false;
  }
  if (activeUser && cloudSyncReady) queueCloudSave();
  return true;
}

function normalizeState(value) {
  const saved = value && typeof value === "object" ? value : {};
  return {
    ...structuredClone(DEFAULTS),
    ...saved,
    events: Array.isArray(saved.events) ? saved.events : [],
    tasks: Array.isArray(saved.tasks) ? saved.tasks : [],
    notes: Array.isArray(saved.notes) ? saved.notes : [],
    settings: { ...DEFAULTS.settings, ...(saved.settings || {}) },
  };
}

function setSyncStatus(status, detail) {
  cloudSyncStatus = status;
  document.querySelector("#sync-title").textContent = status === "synced" ? "Sincronizado en la nube" : status === "syncing" ? "Sincronizando…" : status === "error" ? "Error de sincronización" : "Solo en este dispositivo";
  document.querySelector("#sync-detail").textContent = detail;
  document.querySelector(".sync-indicator").style.background = status === "error" ? "var(--red)" : status === "synced" ? "var(--green)" : "var(--amber)";
  document.querySelector("#account-label").textContent = activeUser ? "Mi cuenta" : "Mi espacio";
  document.querySelector("#account-email").textContent = activeUser?.email || "Organiza tu curso";
  document.querySelector("#auth-fields").hidden = Boolean(activeUser);
  document.querySelector("#account-fields").hidden = !activeUser;
  document.querySelector("#auth-title").textContent = activeUser ? "Tu cuenta" : "Sincronizar con Supabase";
  document.querySelector("#signed-in-email").textContent = activeUser?.email || "";
  document.querySelector("#account-sync-message").textContent = status === "error"
    ? "Has iniciado sesión, pero no se pudo conectar con la base de datos. Comprueba la configuración de Supabase."
    : status === "synced" ? "Tus cambios se guardan en la nube al guardar. Al abrir la app en otro dispositivo, inicia sesión con esta cuenta."
      : status === "syncing" ? "Conectando y sincronizando tus datos…"
        : "Tu cuenta está conectada.";
  document.querySelector("#retry-sync").hidden = !activeUser || status !== "error";
}

function queueCloudSave() {
  const userId = activeUser.id;
  const snapshot = structuredClone(state);
  setSyncStatus("syncing", "Guardando cambios en la nube…");
  cloudSaveQueue = cloudSaveQueue.then(async () => {
    if (!activeUser || activeUser.id !== userId || !cloudSyncReady) return;
    const { error } = await supabaseClient.from("brujula_data").upsert(
      { user_id: userId, data: snapshot, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
    if (error) throw error;
    if (activeUser?.id === userId) setSyncStatus("synced", "Guardado en tu cuenta");
  }).catch((error) => {
    console.error("No se pudieron sincronizar los datos con Supabase.", error);
    if (activeUser?.id === userId) {
      cloudSyncReady = false;
      setSyncStatus("error", "No se pudo guardar en la nube");
      showToast("No se pudo sincronizar. Tus datos siguen guardados en este dispositivo.");
    }
  });
}

async function connectCloudAccount(user) {
  if (!user) {
    activeUser = null;
    cloudSyncReady = false;
    document.querySelector(".app-shell").inert = false;
    setSyncStatus("local", "Inicia sesión para sincronizar");
    return;
  }
  if (activeUser?.id === user.id && cloudSyncReady) return;
  if (accountSyncUserId === user.id && accountSyncPromise) return accountSyncPromise;

  activeUser = user;
  cloudSyncReady = false;
  document.querySelector(".app-shell").inert = true;
  accountSyncUserId = user.id;
  setSyncStatus("syncing", "Conectando con tu cuenta…");
  accountSyncPromise = (async () => {
    const { data: row, error } = await supabaseClient
      .from("brujula_data")
      .select("data")
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) throw error;

    if (row) {
      state = normalizeState(row.data);
      localStorage.setItem("brujula-data", JSON.stringify(state));
    } else {
      if (localStorage.getItem(LOCAL_OWNER_KEY) && localStorage.getItem(LOCAL_OWNER_KEY) !== user.id) {
        state = structuredClone(DEFAULTS);
      }
      const { error: saveError } = await supabaseClient.from("brujula_data").insert({
        user_id: user.id,
        data: structuredClone(state),
      });
      if (saveError) throw saveError;
      localStorage.setItem("brujula-data", JSON.stringify(state));
    }
    localStorage.setItem(LOCAL_OWNER_KEY, user.id);
    if (activeUser?.id !== user.id) return;
    cloudSyncReady = true;
    setSyncStatus("synced", "Guardado en tu cuenta");
    render();
  })().catch((error) => {
    console.error("No se pudo cargar la cuenta de Supabase.", error);
    if (activeUser?.id === user.id) {
      cloudSyncReady = false;
      setSyncStatus("error", "Revisa la configuración de Supabase");
      showToast("No se pudo conectar con la nube. Tus datos locales se han conservado.");
    }
  }).finally(() => {
    document.querySelector(".app-shell").inert = false;
    accountSyncPromise = null;
    accountSyncUserId = null;
  });
  return accountSyncPromise;
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  const formData = new FormData(authForm);
  const email = String(formData.get("email") || "").trim();
  const password = String(formData.get("password") || "");
  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) {
    console.error("No se pudo iniciar sesión.", error);
    showToast("No se pudo iniciar sesión. Revisa el correo y la contraseña.");
    return;
  }
  await connectCloudAccount(data.user);
  authDialog.close();
  if (cloudSyncReady) showToast("Sesión iniciada y datos sincronizados.");
}

async function handleSignUp() {
  if (!authForm.reportValidity()) return;
  const formData = new FormData(authForm);
  const email = String(formData.get("email") || "").trim();
  const password = String(formData.get("password") || "");
  const { data, error } = await supabaseClient.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: window.location.href },
  });
  if (error) {
    console.error("No se pudo crear la cuenta.", error);
    showToast("No se pudo crear la cuenta. Comprueba el correo y la configuración de Supabase.");
    return;
  }
  if (data.session) {
    await connectCloudAccount(data.user);
    authDialog.close();
    if (cloudSyncReady) showToast("Cuenta creada y datos sincronizados.");
  } else {
    showToast("Cuenta creada. Confirma tu correo y vuelve para iniciar sesión.");
  }
}

async function handleSignOut() {
  await cloudSaveQueue;
  const { error } = await supabaseClient.auth.signOut();
  if (error) {
    console.error("No se pudo cerrar sesión.", error);
    showToast("No se pudo cerrar la sesión. Inténtalo de nuevo.");
    return;
  }
  activeUser = null;
  cloudSyncReady = false;
  setSyncStatus("local", "Inicia sesión para sincronizar");
  authDialog.close();
  showToast("Sesión cerrada. Los datos locales siguen guardados en este dispositivo.");
}

async function refreshCloudData() {
  if (!activeUser || !cloudSyncReady || cloudRefreshPromise) return cloudRefreshPromise;
  const userId = activeUser.id;
  cloudRefreshPromise = (async () => {
    await cloudSaveQueue;
    if (!activeUser || activeUser.id !== userId || !cloudSyncReady) return;
    const revisionAtRequest = stateRevision;
    const { data: row, error } = await supabaseClient
      .from("brujula_data")
      .select("data")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error;
    if (!row || activeUser?.id !== userId || stateRevision !== revisionAtRequest) return;
    state = normalizeState(row.data);
    localStorage.setItem("brujula-data", JSON.stringify(state));
    setSyncStatus("synced", "Guardado en tu cuenta");
    render();
  })().catch((error) => {
    console.error("No se pudieron actualizar los datos desde Supabase.", error);
    if (activeUser?.id === userId) {
      cloudSyncReady = false;
      setSyncStatus("error", "No se pudo actualizar desde la nube");
      showToast("No se pudieron actualizar los datos de la nube. Tus datos locales se conservan.");
    }
  }).finally(() => {
    cloudRefreshPromise = null;
  });
  return cloudRefreshPromise;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 3000);
}

function dateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseLocalDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function formatDate(value, options = { day: "numeric", month: "short" }) {
  return parseLocalDate(value).toLocaleDateString("es-ES", options);
}

function subjectColor(name) {
  return SUBJECTS.find((subject) => subject.name === name)?.color || "#a998ff";
}

function updateConnections() {
  const ids = { classroomUrl: "classroom-link", goodnotesUrl: "goodnotes-link", githubUrl: "github-link" };
  for (const [key, id] of Object.entries(ids)) {
    document.getElementById(id).href = safeExternalUrl(state.settings[key], DEFAULTS.settings[key]);
  }
}

function safeExternalUrl(value, fallback) {
  try {
    const url = new URL(value || fallback);
    return ["https:", "http:"].includes(url.protocol) ? url.href : fallback;
  } catch {
    return fallback;
  }
}

function updateNav() {
  const labels = { calendar: "Calendario", tasks: "Tareas", library: "Biblioteca", claude: "Claude" };
  document.querySelectorAll(".nav-link").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === activeView);
  });
  document.querySelector("#breadcrumb-current").textContent = labels[activeView];
  document.querySelector("#task-count").textContent = state.tasks.filter((task) => !task.done).length;
}

function render() {
  updateNav();
  updateConnections();
  if (activeView === "calendar") renderCalendar();
  if (activeView === "tasks") renderTasks();
  if (activeView === "library") renderLibrary();
  if (activeView === "claude") renderClaude();
}

function pageHeading(eyebrow, title, description, buttonLabel, buttonAction) {
  return `<div class="page-heading"><div><span class="eyebrow">${eyebrow}</span><h1>${title}</h1><p>${description}</p></div><button class="button button-primary" data-action="${buttonAction}"><span>＋</span>${buttonLabel}</button></div>`;
}

function renderCalendar() {
  const monthName = calendarDate.toLocaleDateString("es-ES", { month: "long", year: "numeric" });
  const first = new Date(calendarDate.getFullYear(), calendarDate.getMonth(), 1);
  const mondayOffset = (first.getDay() + 6) % 7;
  const gridStart = new Date(first.getFullYear(), first.getMonth(), 1 - mondayOffset);
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const day = new Date(gridStart);
    day.setDate(gridStart.getDate() + i);
    const key = dateKey(day);
    const dayEvents = state.events.filter((event) => event.date === key);
    const visibleEvents = dayEvents.slice(0, 2);
    const eventMarkup = visibleEvents.map((event) => `<div class="day-event" style="--event-color:${escapeHtml(event.color || EVENT_TYPES[event.type]?.color || "#a998ff")}" title="${escapeHtml(event.title)}">${escapeHtml(event.title)}</div>`).join("");
    const more = dayEvents.length > 2 ? `<div class="day-more">+${dayEvents.length - 2} más</div>` : "";
    cells.push(`<div class="day-cell ${day.getMonth() !== calendarDate.getMonth() ? "outside" : ""} ${key === selectedDate ? "selected" : ""} ${key === dateKey(new Date()) ? "today" : ""}" data-date="${key}" tabindex="0" role="button" aria-label="${formatDate(key, { weekday: "long", day: "numeric", month: "long" })}">${`<span class="day-number">${day.getDate()}</span>`}${eventMarkup}${more}</div>`);
  }
  const selectedEvents = state.events.filter((event) => event.date === selectedDate).sort((a, b) => (a.time || "").localeCompare(b.time || ""));
  const agenda = selectedEvents.length
    ? selectedEvents.map((event) => {
      const eventColor = event.color || EVENT_TYPES[event.type]?.color || "#a998ff";
      const imageUrl = event.imageUrl ? safeExternalUrl(event.imageUrl, "") : "";
      const image = imageUrl ? `background-image:linear-gradient(90deg,rgba(24,25,36,.94),rgba(24,25,36,.82)),url(${escapeHtml(JSON.stringify(imageUrl))});background-size:cover;background-position:center;` : "";
      return `<article class="agenda-item" style="--event-color:${escapeHtml(eventColor)};${image}"><span class="agenda-stripe"></span><div class="agenda-copy"><strong>${escapeHtml(event.title)}</strong><small>${event.time ? `${escapeHtml(event.time)} · ` : ""}${escapeHtml(event.subject || EVENT_TYPES[event.type]?.label || "Evento")}</small><span class="agenda-type">${escapeHtml(EVENT_TYPES[event.type]?.label || "Evento")}</span><div class="agenda-actions"><button class="text-button" data-edit-event="${event.id}">Editar</button><button class="text-button delete" data-delete-event="${event.id}">Eliminar</button></div></div></article>`;
    }).join("")
    : `<div class="empty-state"><span class="empty-symbol">✦</span>No tienes nada planeado para este día.<br>Añade un examen, deberes o un recordatorio.</div>`;
  root.innerHTML = `${pageHeading("PLANIFICA CON CALMA", "Tu calendario", "Exámenes, deberes y momentos para estudiar, todo en un mismo lugar.", "Añadir fecha", "add-event")}
    <div class="calendar-layout"><section class="calendar-panel"><div class="calendar-toolbar"><h2 class="month-title">${escapeHtml(monthName.charAt(0).toUpperCase() + monthName.slice(1))}</h2><div class="month-actions"><button data-action="prev-month" aria-label="Mes anterior">‹</button><button class="today-button" data-action="today">Hoy</button><button data-action="next-month" aria-label="Mes siguiente">›</button></div></div><div class="calendar-grid">${["L", "M", "X", "J", "V", "S", "D"].map((day) => `<div class="weekday">${day}</div>`).join("")}${cells.join("")}</div><div class="calendar-legend">${Object.entries(EVENT_TYPES).map(([key, event]) => `<span class="legend-item"><i class="legend-dot" style="--dot:${event.color}"></i>${event.label}</span>`).join("")}</div></section>
    <aside class="side-panel"><div class="side-panel-heading"><div><h2>${formatDate(selectedDate, { weekday: "long", day: "numeric", month: "long" })}</h2><p>Tu agenda del día</p></div><button class="small-plus" data-action="add-event" aria-label="Añadir evento">+</button></div><div class="agenda-list">${agenda}</div><div class="tip-card"><strong>Un pequeño consejo</strong><p>Planificar sesiones cortas de estudio ayuda a mantener la concentración. ¡Vas muy bien!</p></div></aside></div>`;
  root.querySelector(".side-panel-heading h2").textContent = root.querySelector(".side-panel-heading h2").textContent.replace(/^\p{L}/u, (letter) => letter.toLocaleUpperCase("es-ES"));
}

function renderTasks(query = "") {
  const q = query.trim().toLocaleLowerCase("es");
  const filtered = state.tasks.filter((task) => {
    const matchesSubject = selectedSubject === "Todas" || task.subject === selectedSubject;
    const matchesQuery = !q || `${task.title} ${task.subject} ${task.description || ""}`.toLocaleLowerCase("es").includes(q);
    return matchesSubject && matchesQuery;
  }).sort((a, b) => Number(a.done) - Number(b.done) || (a.dueDate || "9999").localeCompare(b.dueDate || "9999"));
  const chips = ["Todas", ...SUBJECTS.map((subject) => subject.name)].map((name) => `<button class="subject-chip ${selectedSubject === name ? "active" : ""}" data-subject="${escapeHtml(name)}">${escapeHtml(name)}</button>`).join("");
  const content = filtered.length ? `<div class="task-list">${filtered.map((task) => taskCard(task)).join("")}</div>` : `<div class="content-panel empty-state"><span class="empty-symbol">✓</span>${q ? "No hay tareas que coincidan con tu búsqueda." : "Aún no tienes tareas. Añade la primera y aparecerá aquí."}</div>`;
  const groups = selectedSubject === "Todas" ? SUBJECTS.map((subject) => {
    const items = state.tasks.filter((task) => task.subject === subject.name && !task.done && (!q || `${task.title} ${task.subject} ${task.description || ""}`.toLocaleLowerCase("es").includes(q)));
    if (!items.length) return "";
    return `<section class="subject-group"><div class="subject-group-heading"><i class="legend-dot" style="--dot:${subject.color}"></i>${escapeHtml(subject.name)}<span class="group-count">${items.length} pendiente${items.length === 1 ? "" : "s"}</span></div>${items.slice(0, 3).map((task) => `<div class="group-task" style="--tag-color:${subject.color}"><div>${escapeHtml(task.title)}<small>${task.dueDate ? `Entrega: ${formatDate(task.dueDate)}` : "Sin fecha"}</small></div></div>`).join("")}</section>`;
  }).join("") : "";
  root.innerHTML = `${pageHeading("UN PASO A LA VEZ", "Mis tareas", "Ordena tus entregas por asignatura y quítatelas de encima.", "Añadir tarea", "add-task")}
    <div class="subject-strip">${chips}</div>${content}${groups ? `<h2 class="section-title" style="margin:25px 0 13px;font:600 14px Manrope,sans-serif">Por asignatura</h2><div class="task-board">${groups}</div>` : ""}`;
}

function taskCard(task) {
  const color = subjectColor(task.subject);
  const priorityLabels = { high: ["Urgente", "#ed909a"], medium: ["Normal", "#e7bb78"], low: ["Tranquila", "#8dcaad"] };
  const [priorityLabel, priorityColor] = priorityLabels[task.priority] || priorityLabels.medium;
  return `<article class="task-card ${task.done ? "completed" : ""}"><input type="checkbox" class="task-check" data-task-check="${task.id}" ${task.done ? "checked" : ""} aria-label="Marcar ${escapeHtml(task.title)} como completada"><div class="task-main"><strong>${escapeHtml(task.title)}</strong>${task.description ? `<div class="task-meta">${escapeHtml(task.description)}</div>` : ""}<div class="task-meta"><span class="subject-tag" style="--tag-color:${color}">${escapeHtml(task.subject)}</span><span>${task.dueDate ? `Entrega: ${formatDate(task.dueDate)}` : "Sin fecha"}</span><span class="priority-tag" style="--priority-color:${priorityColor}">• ${priorityLabel}</span></div></div><button class="task-delete" data-delete-task="${task.id}" aria-label="Eliminar tarea">×</button></article>`;
}

function renderLibrary(query = "") {
  const q = query.trim().toLocaleLowerCase("es");
  const notes = state.notes.filter((note) => !q || `${note.title} ${note.subject} ${note.content}`.toLocaleLowerCase("es").includes(q)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const cards = notes.length ? notes.map((note) => `<article class="note-card"><div class="note-cover" style="--note-color:${escapeHtml(note.color || subjectColor(note.subject))}"></div><div class="note-body"><span class="note-subject" style="--note-color:${escapeHtml(note.color || subjectColor(note.subject))}">${escapeHtml(note.subject)}</span><h3>${escapeHtml(note.title)}</h3><p class="note-preview">${escapeHtml(note.content)}</p><div class="note-footer"><span>Actualizado ${formatDate(note.updatedAt)}</span><div class="note-actions"><button class="text-button" data-edit-note="${note.id}">Abrir</button><button class="text-button delete" data-delete-note="${note.id}">Eliminar</button></div></div></div></article>`).join("") : `<div class="content-panel empty-state" style="grid-column:1/-1"><span class="empty-symbol">▤</span>${q ? "No hay apuntes que coincidan con tu búsqueda." : "Tu biblioteca está esperando sus primeros apuntes."}</div>`;
  root.innerHTML = `${pageHeading("TODO LO QUE APRENDES", "Tu biblioteca", "Apuntes organizados por asignatura, siempre a mano.", "Nuevo apunte", "add-note")}<div class="library-tools"><span class="muted-copy" style="color:var(--muted);font-size:11px">${state.notes.length} apunte${state.notes.length === 1 ? "" : "s"} guardado${state.notes.length === 1 ? "" : "s"} en este dispositivo</span><a class="button button-quiet button-small" href="${safeExternalUrl(state.settings.goodnotesUrl, DEFAULTS.settings.goodnotesUrl)}" target="_blank" rel="noopener noreferrer">Abrir Goodnotes ↗</a></div><div class="notes-grid">${cards}</div>`;
}

function renderClaude() {
  root.innerHTML = `${pageHeading("TU COMPAÑERO DE ESTUDIO", "Pregunta sin miedo", "Usa Claude para aclarar conceptos, practicar o preparar un examen.", "", "")}
    <section class="claude-hero"><div class="claude-copy"><div class="claude-symbol">✳</div><h2>Una duda menos, un paso más.</h2><p>Claude puede explicarte un tema de otra manera, hacerte preguntas de repaso o ayudarte a ordenar tus ideas. Tú pones la pregunta; el aprendizaje sigue siendo tuyo.</p><a class="button button-primary" href="${safeExternalUrl(state.settings.claudeUrl, DEFAULTS.settings.claudeUrl)}" target="_blank" rel="noopener noreferrer">Abrir Claude <span>↗</span></a><div class="claude-disclaimer">Se abrirá Claude en otra pestaña. Necesitarás iniciar sesión allí.</div></div></section>
    <section class="prompt-panel"><h3>¿Qué te gustaría preguntar?</h3><p>Escribe tu duda para copiarla y llevarla a Claude.</p><div class="prompt-row"><input id="claude-question" type="text" placeholder="Ej. Explícame las leyes de Newton con un ejemplo..." /><button class="button button-quiet" data-action="prepare-question">Copiar pregunta</button></div><div class="suggestion-row">${["Explícame este tema paso a paso", "Hazme preguntas para repasar", "Ayúdame a entender este ejercicio"].map((text) => `<button class="suggestion" data-prompt="${escapeHtml(text)}">${escapeHtml(text)}</button>`).join("")}</div></section>`;
  root.querySelector(".page-heading .button").remove();
}

function field(name, label, type, value = "", extra = "") {
  return `<label class="field-label">${label}<input name="${name}" type="${type}" value="${escapeHtml(value)}" ${extra} /></label>`;
}

function subjectOptions(value = SUBJECTS[0].name) {
  return SUBJECTS.map((subject) => `<option value="${escapeHtml(subject.name)}" ${subject.name === value ? "selected" : ""}>${escapeHtml(subject.name)}</option>`).join("");
}

function openEditor(kind, existing = null) {
  editingNoteId = existing?.id || null;
  const isEdit = Boolean(existing);
  const titleMap = { event: isEdit ? "Editar fecha" : "Añadir al calendario", task: "Nueva tarea", note: isEdit ? "Editar apunte" : "Nuevo apunte" };
  document.querySelector("#dialog-eyebrow").textContent = kind === "event" ? "CALENDARIO" : kind === "task" ? "TAREAS" : "BIBLIOTECA";
  document.querySelector("#dialog-title").textContent = titleMap[kind];
  document.querySelector("#save-dialog").textContent = kind === "note" ? "Guardar apunte" : "Guardar";
  editorForm.dataset.kind = kind;
  if (kind === "event") {
    const eventColor = existing?.color || EVENT_TYPES[existing?.type || "exam"].color;
    dialogFields.innerHTML = `${field("title", "Nombre", "text", existing?.title || "", 'required maxlength="90" placeholder="Ej. Examen de física"')}
      <div class="field-inline"><label class="field-label">Tipo<select name="type">${Object.entries(EVENT_TYPES).map(([key, item]) => `<option value="${key}" ${key === (existing?.type || "exam") ? "selected" : ""}>${item.label}</option>`).join("")}</select></label>${field("date", "Fecha", "date", existing?.date || selectedDate, "required")}</div>
      <div class="field-inline"><label class="field-label">Asignatura<select name="subject"><option value="">General</option>${subjectOptions(existing?.subject || "")}</select></label>${field("time", "Hora (opcional)", "time", existing?.time || "")}</div>
      <div class="field-inline">${field("color", "Color personalizado", "color", eventColor)}${field("imageUrl", "Imagen de fondo (URL opcional)", "url", existing?.imageUrl || "", 'placeholder="https://..."')}</div>`;
  } else if (kind === "task") {
    dialogFields.innerHTML = `${field("title", "¿Qué tienes que hacer?", "text", "", 'required maxlength="120" placeholder="Ej. Leer el tema 4 y hacer ejercicios"')}
      <label class="field-label">Asignatura<select name="subject" required>${subjectOptions()}</select></label>
      <div class="field-inline">${field("dueDate", "Fecha de entrega (opcional)", "date")}<label class="field-label">Prioridad<select name="priority"><option value="medium">Normal</option><option value="high">Urgente</option><option value="low">Tranquila</option></select></label></div>
      <label class="field-label">Detalles (opcional)<textarea name="description" maxlength="500" placeholder="Anota lo que no quieres olvidar..."></textarea></label>`;
  } else {
    dialogFields.innerHTML = `${field("title", "Título", "text", existing?.title || "", 'required maxlength="90" placeholder="Ej. La Segunda República"')}
      <div class="field-inline"><label class="field-label">Asignatura<select name="subject" required>${subjectOptions(existing?.subject || SUBJECTS[0].name)}</select></label>${field("color", "Color de la tarjeta", "color", existing?.color || subjectColor(existing?.subject || SUBJECTS[0].name))}</div>
      <label class="field-label">Tus apuntes<textarea name="content" required maxlength="20000" placeholder="Escribe aquí tus apuntes...">${escapeHtml(existing?.content || "")}</textarea></label>`;
  }
  editorDialog.showModal();
  dialogFields.querySelector("input, textarea, select")?.focus();
}

function handleEditorSubmit(event) {
  event.preventDefault();
  const formData = new FormData(editorForm);
  const data = Object.fromEntries(formData.entries());
  const kind = editorForm.dataset.kind;
  if (!data.title?.trim()) {
    showToast("Añade un título antes de guardar.");
    return;
  }
  if (kind === "event") {
    const type = EVENT_TYPES[data.type] ? data.type : "reminder";
    const eventData = { id: editingNoteId || crypto.randomUUID(), ...data, title: data.title.trim(), color: data.color || EVENT_TYPES[type].color, imageUrl: data.imageUrl ? safeExternalUrl(data.imageUrl, "") : "" };
    if (editingNoteId) state.events = state.events.map((item) => item.id === editingNoteId ? eventData : item);
    else state.events.push(eventData);
    selectedDate = eventData.date;
    calendarDate = parseLocalDate(eventData.date);
  }
  if (kind === "task") state.tasks.push({ id: crypto.randomUUID(), ...data, title: data.title.trim(), done: false, createdAt: dateKey(new Date()) });
  if (kind === "note") {
    const note = { id: editingNoteId || crypto.randomUUID(), ...data, title: data.title.trim(), content: data.content.trim(), updatedAt: dateKey(new Date()) };
    if (editingNoteId) state.notes = state.notes.map((item) => item.id === editingNoteId ? note : item);
    else state.notes.push(note);
  }
  const saved = saveState();
  editorDialog.close();
  render();
  if (saved) showToast(kind === "event" ? "Fecha guardada en tu calendario." : kind === "task" ? "Tarea añadida." : "Apunte guardado.");
}

function openSettings() {
  for (const [key, value] of Object.entries(state.settings)) settingsForm.elements.namedItem(key).value = value;
  settingsDialog.showModal();
}

function handleSettingsSubmit(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(settingsForm).entries());
  for (const [key, value] of Object.entries(data)) {
    if (!value) continue;
    try {
      const url = new URL(value);
      if (!["https:", "http:"].includes(url.protocol)) throw new Error("Protocolo no válido");
    } catch {
      showToast("Introduce enlaces válidos que empiecen por https://");
      settingsForm.elements.namedItem(key).focus();
      return;
    }
  }
  state.settings = { ...state.settings, ...data };
  const saved = saveState();
  settingsDialog.close();
  render();
  if (saved) showToast("Conexiones actualizadas.");
}

function handleClick(event) {
  const nav = event.target.closest("[data-view]");
  if (nav) {
    activeView = nav.dataset.view;
    render();
    return;
  }
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "add-event") openEditor("event");
  if (action === "add-task") openEditor("task");
  if (action === "add-note") openEditor("note");
  if (action === "prev-month") {
    calendarDate = new Date(calendarDate.getFullYear(), calendarDate.getMonth() - 1, 1);
    renderCalendar();
  }
  if (action === "next-month") {
    calendarDate = new Date(calendarDate.getFullYear(), calendarDate.getMonth() + 1, 1);
    renderCalendar();
  }
  if (action === "today") {
    calendarDate = new Date();
    selectedDate = dateKey(new Date());
    renderCalendar();
  }
  if (action === "prepare-question") prepareQuestion();
  const subjectChip = event.target.closest("[data-subject]");
  if (subjectChip) {
    selectedSubject = subjectChip.dataset.subject;
    renderTasks(document.querySelector("#global-search").value);
  }
  const prompt = event.target.closest("[data-prompt]");
  if (prompt) document.querySelector("#claude-question").value = prompt.dataset.prompt;
  const editNote = event.target.closest("[data-edit-note]");
  if (editNote) openEditor("note", state.notes.find((note) => note.id === editNote.dataset.editNote));
  const deleteNote = event.target.closest("[data-delete-note]");
  if (deleteNote) {
    state.notes = state.notes.filter((note) => note.id !== deleteNote.dataset.deleteNote);
    const saved = saveState();
    renderLibrary(document.querySelector("#global-search").value);
    if (saved) showToast("Apunte eliminado.");
  }
  const deleteTask = event.target.closest("[data-delete-task]");
  if (deleteTask) {
    state.tasks = state.tasks.filter((task) => task.id !== deleteTask.dataset.deleteTask);
    const saved = saveState();
    renderTasks(document.querySelector("#global-search").value);
    updateNav();
    if (saved) showToast("Tarea eliminada.");
  }
  const dayCell = event.target.closest("[data-date]");
  if (dayCell) {
    selectedDate = dayCell.dataset.date;
    calendarDate = parseLocalDate(selectedDate);
    renderCalendar();
  }
  const editEvent = event.target.closest("[data-edit-event]");
  if (editEvent) {
    const item = state.events.find((entry) => entry.id === editEvent.dataset.editEvent);
    if (item) openEditor("event", item);
  }
  const deleteEvent = event.target.closest("[data-delete-event]");
  if (deleteEvent) {
    state.events = state.events.filter((item) => item.id !== deleteEvent.dataset.deleteEvent);
    const saved = saveState();
    renderCalendar();
    if (saved) showToast("Fecha eliminada.");
  }
}

function handleChange(event) {
  const taskCheck = event.target.closest("[data-task-check]");
  if (taskCheck) {
    state.tasks = state.tasks.map((task) => task.id === taskCheck.dataset.taskCheck ? { ...task, done: taskCheck.checked } : task);
    saveState();
    renderTasks(document.querySelector("#global-search").value);
    updateNav();
  }
}

function prepareQuestion() {
  const input = document.querySelector("#claude-question");
  const question = input.value.trim();
  if (!question) {
    showToast("Escribe tu pregunta primero.");
    input.focus();
    return;
  }
  const prompt = `${question}\n\nExplícamelo de forma clara, paso a paso y adaptada a nivel de instituto.`;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(prompt).then(() => showToast("Pregunta copiada. Pégala en Claude cuando se abra.")).catch(() => showToast("No se pudo copiar. Selecciona y copia tu pregunta manualmente."));
  } else {
    showToast("Selecciona y copia tu pregunta para pegarla en Claude.");
  }
  window.open(safeExternalUrl(state.settings.claudeUrl, DEFAULTS.settings.claudeUrl), "_blank", "noopener,noreferrer");
}

document.addEventListener("click", handleClick);
document.addEventListener("change", handleChange);
editorForm.addEventListener("submit", handleEditorSubmit);
settingsForm.addEventListener("submit", handleSettingsSubmit);
authForm.addEventListener("submit", handleAuthSubmit);
document.querySelector("#sign-up").addEventListener("click", handleSignUp);
document.querySelector("#sign-out").addEventListener("click", handleSignOut);
document.querySelector("#retry-sync").addEventListener("click", () => connectCloudAccount(activeUser));
document.querySelector("#open-auth").addEventListener("click", () => authDialog.showModal());
document.querySelector("#close-auth").addEventListener("click", () => authDialog.close());
document.querySelector("#account-button").addEventListener("click", () => authDialog.showModal());
document.querySelector("#open-settings").addEventListener("click", openSettings);
document.querySelector("#top-settings").addEventListener("click", openSettings);
document.querySelector("#close-dialog").addEventListener("click", () => editorDialog.close());
document.querySelector("#cancel-dialog").addEventListener("click", () => editorDialog.close());
document.querySelector("#close-settings").addEventListener("click", () => settingsDialog.close());
document.querySelector("#cancel-settings").addEventListener("click", () => settingsDialog.close());
document.querySelector("#global-search").addEventListener("input", (event) => {
  if (activeView === "tasks") renderTasks(event.target.value);
  if (activeView === "library") renderLibrary(event.target.value);
});
document.querySelector("#global-search").addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.target.value = "";
    render();
  }
});
root.addEventListener("keydown", (event) => {
  if ((event.key === "Enter" || event.key === " ") && event.target.matches(".day-cell")) {
    event.preventDefault();
    selectedDate = event.target.dataset.date;
    renderCalendar();
  }
});
window.addEventListener("focus", () => void refreshCloudData());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refreshCloudData();
});
supabaseClient.auth.onAuthStateChange((event, session) => {
  if (event === "SIGNED_OUT") {
    void connectCloudAccount(null);
  } else if (session?.user && ["INITIAL_SESSION", "SIGNED_IN", "TOKEN_REFRESHED", "USER_UPDATED"].includes(event)) {
    queueMicrotask(() => void connectCloudAccount(session.user));
  }
});
render();

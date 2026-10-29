(() => {
  const cfg = window.BIG_HEAD_CONFIG;
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];

  const baseMessage = "Olá! Vi a agenda no site do Big Head Estúdio e gostaria de consultar um horário para ensaio.";
  const waUrl = (message = baseMessage) => `https://wa.me/${cfg.whatsappNumber}?text=${encodeURIComponent(message)}`;

  $$(".js-whatsapp").forEach(a => { a.href = waUrl(); a.target = "_blank"; a.rel = "noopener"; });
  $$(".js-instagram").forEach(a => a.href = cfg.instagramUrl);
  $$(".js-review").forEach(a => a.href = cfg.googleReviewUrl);
  $$(".js-maps").forEach(a => a.href = cfg.googleMapsUrl);

  if (document.body.dataset.page !== "agenda") return;

  const grid = $("#calendarGrid");
  const title = $("#calendarTitle");
  const slotsEl = $("#slots");
  const dateTitle = $("#selectedDateTitle");
  const dateSubtitle = $("#selectedDateSubtitle");
  const dayWhatsapp = $("#dayWhatsapp");
  const demoBanner = $("#demoBanner");

  let cursor = new Date();
  cursor = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  let selectedDate = new Date();
  selectedDate = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate());
  let events = [];
  let selectedSlot = null;
  let requestSerial = 0;
  let calendarState = "loading"; // loading | live | stale | offline
  let lastSyncAt = null;

  const CACHE_PREFIX = "bh_calendar_cache_v2:";
  const MAX_STALE_MS = 15 * 60 * 1000;
  const RETRY_DELAYS_MS = [0, 900, 2200, 4500, 8000, 13000];

  function monthCacheKey() {
    return `${CACHE_PREFIX}${cursor.getFullYear()}-${pad(cursor.getMonth()+1)}`;
  }

  function saveMonthCache(items) {
    try {
      localStorage.setItem(monthCacheKey(), JSON.stringify({
        savedAt: Date.now(),
        events: items.map(e => ({ start: e.start.toISOString(), end: e.end.toISOString() }))
      }));
    } catch (_) {}
  }

  function loadMonthCache() {
    try {
      const raw = localStorage.getItem(monthCacheKey());
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.events) || !parsed.savedAt) return null;
      return {
        savedAt: Number(parsed.savedAt),
        events: parsed.events.map(e => ({ start: new Date(e.start), end: new Date(e.end) }))
      };
    } catch (_) {
      return null;
    }
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function syncAgeLabel(ts) {
    if (!ts) return "";
    const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
    if (mins <= 1) return "há cerca de 1 minuto";
    return `há cerca de ${mins} minutos`;
  }

  // Bloqueios apenas para a prévia visual quando a integração ainda não foi configurada.
  function getDemoEvents(year, month) {
    const d = (day, sh, eh) => ({
      start: new Date(year, month, day, sh, 0),
      end: new Date(year, month, day, eh, 0)
    });
    return [d(7,19,21), d(10,14,17), d(13,20,22), d(17,10,13), d(17,18,21), d(22,19,22), d(25,15,18)];
  }

  function pad(n) { return String(n).padStart(2, "0"); }
  function isoLocal(d) {
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? "+" : "-";
    const hh = pad(Math.floor(Math.abs(off)/60));
    const mm = pad(Math.abs(off)%60);
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${sign}${hh}:${mm}`;
  }
  function sameDay(a,b){ return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate(); }
  function formatDate(d){ return new Intl.DateTimeFormat("pt-BR", {weekday:"long", day:"2-digit", month:"long"}).format(d); }
  function formatShort(d){ return new Intl.DateTimeFormat("pt-BR", {day:"2-digit", month:"2-digit", year:"numeric"}).format(d); }
  function formatHour(d){ return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }

  function jsonp(url) {
    return new Promise((resolve, reject) => {
      const callback = `bhCalendarCallback_${Date.now()}_${Math.floor(Math.random()*100000)}`;
      const script = document.createElement("script");
      let settled = false;
      const timeout = setTimeout(() => cleanup(new Error("Tempo de resposta excedido")), 12000);

      function cleanup(error, data) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try { delete window[callback]; } catch (_) { window[callback] = undefined; }
        script.remove();
        error ? reject(error) : resolve(data);
      }

      window[callback] = data => cleanup(null, data);
      script.onerror = () => cleanup(new Error("Falha ao carregar agenda"));
      script.referrerPolicy = "no-referrer";
      script.src = `${url}${url.includes("?") ? "&" : "?"}callback=${callback}&_=${Date.now()}`;
      document.head.appendChild(script);
    });
  }

  async function loadMonth() {
    const serial = ++requestSerial;
    const start = new Date(cursor.getFullYear(), cursor.getMonth(), 1, 0, 0, 0);
    const end = new Date(cursor.getFullYear(), cursor.getMonth()+1, 1, 0, 0, 0);

    calendarState = "loading";

    if (!cfg.appsScriptUrl) {
      calendarState = "offline";
      demoBanner.textContent = "Agenda temporariamente indisponível. Consulte o estúdio pelo WhatsApp.";
      demoBanner.classList.add("visible");
      events = [];
      renderCalendar();
      renderSelectedDay();
      return;
    }

    const url = `${cfg.appsScriptUrl}?start=${encodeURIComponent(isoLocal(start))}&end=${encodeURIComponent(isoLocal(end))}`;
    let lastError = null;

    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
      if (RETRY_DELAYS_MS[attempt]) await sleep(RETRY_DELAYS_MS[attempt]);
      if (serial !== requestSerial) return;

      try {
        const data = await jsonp(url);
        if (serial !== requestSerial) return;
        if (!data || data.ok !== true || !Array.isArray(data.events)) {
          throw new Error(data && data.error ? data.error : "Resposta inválida do Apps Script");
        }

        events = data.events.map(e => ({ start:new Date(e.start), end:new Date(e.end) }));
        calendarState = "live";
        lastSyncAt = Date.now();
        saveMonthCache(events);
        demoBanner.classList.remove("visible");
        renderCalendar();
        renderSelectedDay();
        return;
      } catch (err) {
        lastError = err;
        console.warn(`Big Head Agenda: tentativa ${attempt + 1}/${RETRY_DELAYS_MS.length} falhou`, err);
      }
    }

    if (serial !== requestSerial) return;

    const cached = loadMonthCache();
    const cacheAge = cached ? Date.now() - cached.savedAt : Infinity;

    if (cached && cacheAge <= MAX_STALE_MS) {
      events = cached.events;
      calendarState = "stale";
      lastSyncAt = cached.savedAt;
      demoBanner.textContent = `Conexão instável com a agenda. Exibindo a última sincronização válida (${syncAgeLabel(lastSyncAt)}). A reserva continua sujeita à confirmação pelo WhatsApp.`;
      demoBanner.classList.add("visible");
    } else {
      events = [];
      calendarState = "offline";
      lastSyncAt = cached ? cached.savedAt : null;
      demoBanner.textContent = `Agenda temporariamente indisponível${lastError && lastError.message ? `: ${lastError.message}` : ""}. Nenhum horário será exibido como livre até a sincronização voltar. Consulte pelo WhatsApp.`;
      demoBanner.classList.add("visible");
    }

    renderCalendar();
    renderSelectedDay();
  }

  function dayOpenHours(date) {
    return cfg.openingHours[date.getDay()] || null;
  }

  function slotsForDay(date) {
    const hours = dayOpenHours(date);
    if (!hours) return [];
    const result = [];
    const step = cfg.slotMinutes;
    let t = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hours.start, 0, 0);
    const finish = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hours.end, 0, 0);
    while (t < finish) {
      const e = new Date(t.getTime() + step*60000);
      const reserved = events.some(ev => ev.start < e && ev.end > t);
      result.push({start:new Date(t), end:e, reserved});
      t = e;
    }
    return result;
  }

  function dayStatus(date) {
    if (calendarState === "offline" || calendarState === "loading") {
      return {kind:"unknown", label:"Indisponível"};
    }
    const slots = slotsForDay(date);
    if (!slots.length) return {kind:"full", label:"Fechado"};
    const reserved = slots.filter(s=>s.reserved).length;
    if (reserved === 0) return {kind:"free", label:"Livre"};
    if (reserved === slots.length) return {kind:"full", label:"Sem horários"};
    return {kind:"partial", label:"Parcial"};
  }

  function renderCalendar() {
    const y = cursor.getFullYear(), m = cursor.getMonth();
    title.textContent = new Intl.DateTimeFormat("pt-BR", {month:"long", year:"numeric"}).format(cursor);
    grid.innerHTML = "";
    const first = new Date(y,m,1);
    const days = new Date(y,m+1,0).getDate();
    const before = first.getDay();
    for (let i=0;i<before;i++) grid.appendChild(makeDayCell(null));
    const today = new Date();
    for (let day=1; day<=days; day++) {
      const date = new Date(y,m,day);
      const cell = makeDayCell(date);
      if (sameDay(date,today)) cell.classList.add("today");
      if (sameDay(date,selectedDate)) cell.classList.add("selected");
      grid.appendChild(cell);
    }
    while (grid.children.length % 7) grid.appendChild(makeDayCell(null));
  }

  function makeDayCell(date) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "day";
    if (!date) { b.classList.add("outside"); b.disabled = true; return b; }
    const st = dayStatus(date);
    b.innerHTML = `<span class="day-number">${date.getDate()}</span><span class="day-status ${st.kind}"><span class="status-dot"></span>${st.label}</span>`;
    b.setAttribute("aria-label", `${formatDate(date)}: ${st.label}`);
    b.addEventListener("click", () => { selectedDate = date; selectedSlot = null; renderCalendar(); renderSelectedDay(); });
    return b;
  }

  function renderSelectedDay() {
    dateTitle.textContent = formatDate(selectedDate);
    const hours = dayOpenHours(selectedDate);
    selectedSlot = null;
    slotsEl.innerHTML = "";

    if (calendarState === "offline" || calendarState === "loading") {
      dateSubtitle.textContent = "A disponibilidade não pôde ser confirmada agora.";
      dayWhatsapp.href = waUrl(`Olá! A agenda do site está temporariamente indisponível e gostaria de consultar os horários de ${formatShort(selectedDate)} para ensaio.`);
      return;
    }

    if (!hours) {
      dateSubtitle.textContent = "Estúdio fechado nesta data.";
      dayWhatsapp.href = waUrl(`Olá! Vi o site do Big Head Estúdio e gostaria de consultar uma possibilidade de horário em ${formatShort(selectedDate)}.`);
      return;
    }

    const slots = slotsForDay(selectedDate);
    const availableCount = slots.filter(s=>!s.reserved).length;
    dateSubtitle.textContent = calendarState === "stale"
      ? `${availableCount} horário${availableCount===1?"":"s"} livre${availableCount===1?"":"s"} na última sincronização (${syncAgeLabel(lastSyncAt)}).`
      : `${availableCount} horário${availableCount===1?"":"s"} livre${availableCount===1?"":"s"} nesta data.`;

    slots.forEach(slot => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `slot ${slot.reserved ? "reserved" : "available"}`;
      btn.disabled = slot.reserved;
      btn.innerHTML = `<strong>${formatHour(slot.start)}–${formatHour(slot.end)}</strong><span class="slot-badge">${slot.reserved ? "Reservado" : "Disponível"}</span>`;
      if (!slot.reserved) {
        btn.addEventListener("click", () => {
          selectedSlot = slot;
          $$(".slot.available", slotsEl).forEach(x=>x.classList.remove("selected"));
          btn.classList.add("selected");
          dayWhatsapp.href = waUrl(`Olá! Vi a agenda no site do Big Head Estúdio e gostaria de consultar o horário de ${formatHour(slot.start)} às ${formatHour(slot.end)} do dia ${formatShort(selectedDate)} para ensaio.`);
        });
      }
      slotsEl.appendChild(btn);
    });

    dayWhatsapp.href = waUrl(`Olá! Vi a agenda no site do Big Head Estúdio e gostaria de consultar disponibilidade para ${formatShort(selectedDate)}.`);
  }

  // Permite nova tentativa manual sem recarregar a página.
  const retryButton = document.createElement("button");
  retryButton.type = "button";
  retryButton.textContent = "Tentar sincronizar novamente";
  retryButton.style.cssText = "margin-left:10px;border:1px solid #7a6512;background:#171206;color:#ffe77a;border-radius:999px;padding:7px 11px;font:inherit;font-weight:800;cursor:pointer";
  retryButton.addEventListener("click", () => {
    retryButton.disabled = true;
    retryButton.textContent = "Sincronizando…";
    loadMonth().finally(() => {
      retryButton.disabled = false;
      retryButton.textContent = "Tentar sincronizar novamente";
    });
  });

  const originalShow = demoBanner.classList.add.bind(demoBanner.classList);
  const ensureRetryButton = () => {
    if ((calendarState === "offline" || calendarState === "stale") && !demoBanner.contains(retryButton)) {
      demoBanner.appendChild(retryButton);
    }
  };

  const bannerObserver = new MutationObserver(ensureRetryButton);
  bannerObserver.observe(demoBanner, { childList:true, characterData:true, subtree:true, attributes:true, attributeFilter:["class"] });

  $("#prevMonth").addEventListener("click", () => { cursor = new Date(cursor.getFullYear(), cursor.getMonth()-1, 1); selectedDate = new Date(cursor.getFullYear(), cursor.getMonth(), 1); loadMonth(); });
  $("#nextMonth").addEventListener("click", () => { cursor = new Date(cursor.getFullYear(), cursor.getMonth()+1, 1); selectedDate = new Date(cursor.getFullYear(), cursor.getMonth(), 1); loadMonth(); });
  $("#todayBtn").addEventListener("click", () => { const n=new Date(); cursor=new Date(n.getFullYear(),n.getMonth(),1); selectedDate=new Date(n.getFullYear(),n.getMonth(),n.getDate()); loadMonth(); });

  loadMonth();
  setInterval(() => { if (cfg.appsScriptUrl) loadMonth(); }, Math.max(1,cfg.refreshMinutes)*60000);
})();

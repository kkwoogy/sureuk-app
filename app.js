(() => {
  const feed = document.getElementById("feed");
  const chips = document.getElementById("chips");
  const counter = document.getElementById("counter");
  const progress = document.getElementById("progress");

  const FEEDBACK_KEY = "sureuk.feedback";
  let data = null;
  let filter = "all";
  let observer = null;

  // ── 저장소 (사생활 모드 등에서 실패해도 앱은 그대로 동작) ──
  const store = {
    get(key, fallback) {
      try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 무시 */ }
    },
  };
  const feedback = store.get(FEEDBACK_KEY, {});

  // ── DOM 헬퍼: 기사에서 온 텍스트는 전부 textContent로만 넣는다 ──
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "style") node.style.cssText = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : null);
  const external = (href, attrs, ...children) =>
    el("a", { href, target: "_blank", rel: "noopener noreferrer", ...attrs }, ...children);

  function hue(id) {
    let h = 0;
    for (const ch of id) h = (h * 31 + ch.codePointAt(0)) % 360;
    return h;
  }

  const topicOf = (id) => data.topics.find((t) => t.id === id) || { id, name: id, emoji: "•" };

  function daysAgo(isoDate) {
    if (!isoDate) return null;
    const [y, m, d] = isoDate.split("-").map(Number);
    const then = new Date(y, m - 1, d);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diff = Math.round((today - then) / 86400000);
    if (diff <= 0) return "오늘";
    if (diff === 1) return "어제";
    return `${diff}일 전`;
  }

  function readMinutes(card) {
    const text = [card.summary, card.term, ...(card.sections || []).map((s) => s.text), ...(card.steps || [])].join("");
    return Math.max(1, Math.round(text.length / 450));
  }

  // ── 카드 조각 ──
  function illustration(card, topic) {
    const label = card.kind === "series" && card.episode ? `${topic.name} · 연재 ${card.episode}편` : topic.name;
    return el("div", { class: "illus", style: `--h:${hue(topic.id)}` },
      el("span", { class: "illus-emoji", "aria-hidden": "true" }, topic.emoji),
      el("span", { class: "illus-label" }, label),
    );
  }

  function hero(card, topic, url) {
    const image = safeUrl(card.image);
    if (!image) return el("div", { class: "hero" }, illustration(card, topic));
    const img = el("img", { src: image, alt: "", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" });
    const box = url ? external(url, { class: "hero", "aria-label": "원문 기사 열기" }, img) : el("div", { class: "hero" }, img);
    // 이미지가 막혀 있거나 깨지면 주제 그림으로 바꾼다
    img.addEventListener("error", () => box.replaceChildren(illustration(card, topic)), { once: true });
    return box;
  }

  function numbers(card) {
    if (!card.numbers?.length) return null;
    return el("div", { class: "numbers" }, card.numbers.map((n) =>
      el("div", { class: "num" }, el("span", { class: "num-value" }, n.value), el("span", { class: "num-label" }, n.label))));
  }

  function table(card) {
    const t = card.table;
    if (!t?.columns?.length || !t.rows?.length) return null;
    return el("div", { class: "table-wrap" },
      el("table", {},
        el("thead", {}, el("tr", {}, t.columns.map((c) => el("th", { scope: "col" }, c)))),
        el("tbody", {}, t.rows.map((r) => el("tr", {}, r.map((c) => el("td", {}, c))))),
      ));
  }

  function term(card) {
    if (!card.term) return null;
    const i = card.term.indexOf(":");
    return i > 0
      ? el("aside", { class: "term" }, el("b", {}, `용어 풀이 · ${card.term.slice(0, i).trim()}`), card.term.slice(i + 1).trim())
      : el("aside", { class: "term" }, el("b", {}, "용어 풀이"), card.term);
  }

  function feedbackButtons(card) {
    const vote = feedback[card.id] || 0;
    const group = el("div", { class: "fb-group" });
    const make = (value, label, aria) => el("button", {
      class: "fb", type: "button", "aria-pressed": String(vote === value), "aria-label": aria,
      onclick: () => {
        feedback[card.id] = feedback[card.id] === value ? 0 : value;
        store.set(FEEDBACK_KEY, feedback);
        const [up, down] = group.children;
        up.setAttribute("aria-pressed", String(feedback[card.id] === 1));
        down.setAttribute("aria-pressed", String(feedback[card.id] === -1));
      },
    }, label);
    group.append(make(1, "👍", "유용해요"), make(-1, "👎", "별로예요"));
    return group;
  }

  function renderCard(card, index) {
    const topic = topicOf(card.topic);
    const isSeries = card.kind === "series";
    const sources = (card.sources || []).filter((s) => safeUrl(s.url));
    const main = sources[0];
    const when = daysAgo(main?.date);

    const meta = el("div", { class: "meta" },
      el("span", { class: "topic", style: `--h:${hue(topic.id)}` }, `${topic.emoji} ${topic.name}`),
      isSeries && card.episode ? el("span", { class: "badge" }, `연재 ${card.episode}편`) : null,
      card.ad_suspect ? el("span", { class: "badge warn" }, "홍보성 섞임") : null,
      main ? el("span", {}, main.publisher) : null,
      when ? el("span", {}, `· ${when}`) : null,
      el("span", {}, `· ${readMinutes(card)}분`),
    );

    const sections = (card.sections || []).map((s) =>
      el("section", { class: "sec" }, el("h3", {}, s.title), el("p", {}, s.text)));

    const steps = card.steps?.length ? el("ol", { class: "steps" }, card.steps.map((s) => el("li", {}, s))) : null;

    const cta = main
      ? external(main.url, { class: "cta" }, "원문 기사 보기", el("span", {}, `${main.publisher} ↗`))
      : null;

    const others = sources.slice(1);
    const also = others.length
      ? el("div", { class: "also" }, "같은 소식 · ",
          others.flatMap((s, i) => [i ? " · " : null, external(s.url, { title: s.title }, s.publisher)]))
      : el("div", { class: "also" }, isSeries ? "기본 지식 연재 · 바뀌는 조건은 꼭 다시 확인하세요" : "");

    return el("article", { class: "story", "data-index": index },
      hero(card, topic, main?.url),
      el("div", { class: "story-body" },
        meta,
        el("h2", {}, card.headline),
        card.summary ? el("p", { class: "lead" }, card.summary) : null,
        numbers(card),
        sections,
        steps,
        table(card),
        term(card),
        cta,
        el("div", { class: "foot" }, also, feedbackButtons(card)),
      ),
    );
  }

  function renderIntro(cards) {
    const d = new Date(data.generated_at);
    const date = isNaN(d) ? "" : d.toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "long" });
    const minutes = cards.reduce((sum, c) => sum + readMinutes(c), 0);
    const s = data.stats || {};
    return el("section", { class: "intro" },
      el("p", { class: "intro-date" }, date),
      el("h1", {}, filter === "all" ? "오늘의 스르륵" : `${topicOf(filter).emoji} ${topicOf(filter).name}`),
      el("p", { class: "intro-sub" },
        el("span", { class: "pill" }, `카드 ${cards.length}장`),
        el("span", { class: "pill" }, `약 ${minutes}분`)),
      filter === "all"
        ? el("p", { class: "intro-note" }, `기사 ${s.candidates ?? "?"}개 중에서 골랐고, 광고·협찬 의심 ${s.ads_filtered ?? 0}개는 걸렀어요.`)
        : null,
    );
  }

  function renderEnd() {
    return el("section", { class: "end" },
      el("h2", {}, "오늘 카드는 여기까지예요"),
      el("p", {}, "내일 아침에 새 카드가 올라와요."),
      el("button", { class: "again", type: "button", onclick: () => window.scrollTo({ top: 0, behavior: "smooth" }) }, "처음으로"),
    );
  }

  function renderChips() {
    const make = (id, label) => el("button", {
      class: "chip-btn", type: "button", "aria-pressed": String(filter === id),
      onclick: (e) => {
        filter = id;
        renderChips();
        renderFeed();
        chips.querySelector('[aria-pressed="true"]')?.scrollIntoView({ inline: "center", block: "nearest" });
      },
    }, label);
    chips.replaceChildren(make("all", "전체"), ...data.topics.map((t) => make(t.id, `${t.emoji} ${t.name}`)));
  }

  function sectionTitle(text) {
    return el("h2", { class: "section-title" }, text);
  }

  function renderFeed() {
    const cards = data.cards.filter((c) => filter === "all" || c.topic === filter);
    const items = [];
    cards.forEach((card, i) => {
      // 전체 보기에서는 주요 뉴스와 관심사 카드 사이에 제목을 넣는다
      const prev = cards[i - 1];
      if (filter === "all" && card.kind === "headline" && !prev) items.push(sectionTitle("🗞️ 오늘 꼭 알아둘 뉴스"));
      if (filter === "all" && card.kind !== "headline" && (!prev || prev.kind === "headline") && cards[0].kind === "headline") {
        items.push(sectionTitle("✨ 내 관심사"));
      }
      items.push(renderCard(card, i));
    });
    feed.replaceChildren(renderIntro(cards), ...items, renderEnd());
    window.scrollTo({ top: 0 });
    watch(cards.length);
  }

  // ── 진행 표시 ──
  function watch(total) {
    observer?.disconnect();
    counter.textContent = total ? `1 / ${total}` : "";
    observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) counter.textContent = `${Number(e.target.dataset.index) + 1} / ${total}`;
      }
    }, { rootMargin: "-45% 0px -50% 0px" });
    feed.querySelectorAll(".story").forEach((s) => observer.observe(s));
  }

  function onScroll() {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    progress.style.width = max > 0 ? `${Math.min(100, (window.scrollY / max) * 100)}%` : "0";
  }
  window.addEventListener("scroll", onScroll, { passive: true });

  function showMessage(title, text) {
    feed.replaceChildren(el("section", { class: "end" }, el("h2", {}, title), el("p", {}, text)));
  }

  // ── 잠금: 올린 카드는 비밀번호로 암호화돼 있다 (PBKDF2 → AES-GCM) ──
  const KEY_STORE = "sureuk.key";
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const toB64 = (bytes) => btoa(String.fromCharCode(...bytes));

  async function deriveKey(passphrase, salt, iterations) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, 256);
    return new Uint8Array(bits);
  }

  async function decrypt(envelope, rawKey) {
    const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(envelope.iv) }, key, fromB64(envelope.data));
    return JSON.parse(new TextDecoder().decode(plain));
  }

  function showUnlock(envelope) {
    chips.replaceChildren();
    counter.textContent = "";
    const input = el("input", {
      class: "pw", type: "password", placeholder: "비밀번호", "aria-label": "비밀번호",
      autocomplete: "current-password", autocapitalize: "off", spellcheck: "false",
    });
    const msg = el("p", {}, "나만 보는 카드예요. 이 기기에서 처음 한 번만 비밀번호를 입력하면 돼요.");
    const button = el("button", { class: "again", type: "submit" }, "열기");
    const form = el("form", {
      class: "end unlock",
      onsubmit: async (e) => {
        e.preventDefault();
        button.disabled = true;
        msg.textContent = "여는 중…";
        try {
          const raw = await deriveKey(input.value.trim(), fromB64(envelope.salt), envelope.iter);
          data = await decrypt(envelope, raw);
          store.set(KEY_STORE, { salt: envelope.salt, key: toB64(raw) });
          start();
        } catch {
          button.disabled = false;
          msg.textContent = "비밀번호가 맞지 않아요.";
          input.select();
        }
      },
    }, el("div", { class: "lock", "aria-hidden": "true" }, "🔒"), el("h2", {}, "스르륵"), msg, input, button);
    feed.replaceChildren(form);
    input.focus();
  }

  async function fetchJson(url) {
    try {
      const res = await fetch(url, { cache: "no-cache" });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  }

  function start() {
    if (!data.cards?.length) {
      showMessage("오늘은 카드가 없어요", "관심사에 맞는 새 소식을 찾지 못했어요.");
      return;
    }
    renderChips();
    renderFeed();
  }

  async function load() {
    // PC 미리보기에는 잠그지 않은 cards.json이, 올린 페이지에는 잠근 cards.enc.json만 있다
    data = await fetchJson("data/cards.json");
    if (data) return start();

    const envelope = await fetchJson("data/cards.enc.json");
    if (!envelope) {
      showMessage("카드가 아직 없어요", "새 카드가 올라오면 여기에 보여요.");
      return;
    }
    const saved = store.get(KEY_STORE, null);
    if (saved?.salt === envelope.salt) {
      try {
        data = await decrypt(envelope, fromB64(saved.key));
        return start();
      } catch { /* 비밀번호가 바뀌었으면 다시 묻는다 */ }
    }
    showUnlock(envelope);
  }

  // 홈 화면 앱으로 쓸 때 오프라인에서도 열리게
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  load();
})();

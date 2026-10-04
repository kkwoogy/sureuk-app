(() => {
  const feed = document.getElementById("feed");
  const chips = document.getElementById("chips");
  const counter = document.getElementById("counter");
  const progress = document.getElementById("progress");
  const who = document.getElementById("who");

  const FEEDBACK_KEY = "sureuk.feedback";
  const KEY_STORE = "sureuk.key";
  const CODE_STORE = "sureuk.code"; // 이 기기 사용자의 코드 (= data/<코드>.json)
  const DRAFT_STORE = "sureuk.draft";

  let mode = "plain"; // PC 미리보기: 잠그지 않은 data/*.json, 올린 페이지: 잠근 data/*.enc.json
  let rawKey = null;
  let code = null;
  let data = null; // 지금 보여주는 카드 (내 카드, 또는 준비 중일 때 공용 주요 뉴스)
  let pending = false;
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

  // 화면 전체를 패널(잠금·사람 고르기·관심사 등록)로 바꿀 때
  function showPanel(...children) {
    observer?.disconnect();
    chips.replaceChildren();
    counter.textContent = "";
    progress.style.width = "0";
    feed.replaceChildren(el("section", { class: "panel" }, ...children));
    window.scrollTo({ top: 0 });
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

  function renderCard(card, i) {
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
      ? external(main.url, { class: "cta" }, isSeries ? "참고 기사 보기" : "원문 기사 보기", el("span", {}, `${main.publisher} ↗`))
      : null;
    const others = sources.slice(1);
    const also = others.length
      ? el("div", { class: "also" }, isSeries ? "참고 · " : "같은 소식 · ",
          others.flatMap((s, n) => [n ? " · " : null, external(s.url, { title: s.title }, s.publisher)]))
      : el("div", { class: "also" }, isSeries ? "기초 지식 연재 · 바뀌는 조건은 꼭 다시 확인하세요" : "");

    return el("article", { class: "story", "data-index": i },
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
    const title = filter !== "all" ? `${topicOf(filter).emoji} ${topicOf(filter).name}` : "오늘의 스르륵";
    return el("section", { class: "intro" },
      el("p", { class: "intro-date" }, date),
      el("h1", {}, title),
      el("p", { class: "intro-sub" },
        el("span", { class: "pill" }, `카드 ${cards.length}장`),
        el("span", { class: "pill" }, `약 ${minutes}분`)),
      pending
        ? el("p", { class: "notice" }, "⏳ 관심사 카드를 준비하고 있어요. 다음 업데이트 때 여기에 내 카드가 생겨요. 그동안 오늘의 주요 뉴스를 먼저 읽어보세요.")
        : filter === "all"
          ? el("p", { class: "intro-note" }, `기사 ${s.candidates ?? "?"}개 중에서 골랐고, 광고·협찬 의심 ${s.ads_filtered ?? 0}개는 걸렀어요.`)
          : null,
    );
  }

  function renderEnd() {
    return el("section", { class: "end" },
      el("h2", {}, "오늘 카드는 여기까지예요"),
      el("p", {}, "다음 업데이트 때 새 카드가 올라와요."),
      el("button", { class: "again", type: "button", onclick: () => window.scrollTo({ top: 0, behavior: "smooth" }) }, "처음으로"),
    );
  }

  function renderChips() {
    const make = (id, label) => el("button", {
      class: "chip-btn", type: "button", "aria-pressed": String(filter === id),
      onclick: () => {
        filter = id;
        renderChips();
        renderFeed();
        chips.querySelector('[aria-pressed="true"]')?.scrollIntoView({ inline: "center", block: "nearest" });
      },
    }, label);
    chips.replaceChildren(make("all", "전체"), ...data.topics.map((t) => make(t.id, `${t.emoji} ${t.name}`)));
  }

  function renderFeed() {
    const cards = data.cards.filter((c) => filter === "all" || c.topic === filter);
    const items = [];
    cards.forEach((card, i) => {
      // 전체 보기에서는 주요 뉴스와 관심사 카드 사이에 제목을 넣는다
      const prev = cards[i - 1];
      if (filter === "all" && card.kind === "headline" && !prev) items.push(el("h2", { class: "section-title" }, "🗞️ 오늘 꼭 알아둘 뉴스"));
      if (filter === "all" && card.kind !== "headline" && prev?.kind === "headline") {
        items.push(el("h2", { class: "section-title" }, "✨ 내 관심사"));
      }
      items.push(renderCard(card, i));
    });
    feed.replaceChildren(renderIntro(cards), ...items, renderEnd());
    window.scrollTo({ top: 0 });
    watch(cards.length);
  }

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

  window.addEventListener("scroll", () => {
    if (!feed.querySelector(".story")) return;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    progress.style.width = max > 0 ? `${Math.min(100, (window.scrollY / max) * 100)}%` : "0";
  }, { passive: true });

  // ── 잠금: 올린 데이터는 비밀번호로 암호화돼 있다 (PBKDF2 → AES-GCM) ──
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const toB64 = (bytes) => btoa(String.fromCharCode(...bytes));
  const normalize = (pw) => pw.replace(/[\s-]/g, ""); // publish.py와 같은 규칙

  async function deriveKey(passphrase, salt, iterations) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(normalize(passphrase)), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, 256);
    return new Uint8Array(bits);
  }

  async function decrypt(envelope, key) {
    const k = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(envelope.iv) }, k, fromB64(envelope.data));
    return JSON.parse(new TextDecoder().decode(plain));
  }

  async function fetchJson(url) {
    try {
      const res = await fetch(url, { cache: "no-cache" });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  }

  async function loadData(name) {
    if (mode === "plain") return fetchJson(`data/${name}.json`);
    const envelope = await fetchJson(`data/${name}.enc.json`);
    return envelope ? decrypt(envelope, rawKey) : null;
  }

  function showUnlock(envelope) {
    who.hidden = true;
    const input = el("input", {
      class: "field center", type: "password", placeholder: "비밀번호", "aria-label": "비밀번호",
      autocomplete: "current-password", autocapitalize: "off", spellcheck: "false",
    });
    const msg = el("p", { class: "panel-note" }, "초대받은 사람만 보는 카드예요. 이 기기에서 처음 한 번만 비밀번호를 입력하면 돼요. 띄어쓰기는 상관없어요.");
    const button = el("button", { class: "again", type: "submit" }, "열기");
    const form = el("form", {
      class: "stack center",
      onsubmit: async (e) => {
        e.preventDefault();
        button.disabled = true;
        msg.textContent = "여는 중…";
        try {
          const key = await deriveKey(input.value, fromB64(envelope.salt), envelope.iter);
          await decrypt(envelope, key); // 맞는 비밀번호인지 확인
          rawKey = key;
          store.set(KEY_STORE, { salt: envelope.salt, key: toB64(key) });
          route();
        } catch {
          button.disabled = false;
          msg.textContent = "비밀번호가 맞지 않아요.";
          input.select();
        }
      },
    }, el("div", { class: "lock", "aria-hidden": "true" }, "🔒"), el("h2", {}, "스르륵"), msg, input, button);
    showPanel(form);
    input.focus();
  }

  // ── 내 카드 열기: 코드가 없으면 관심사부터, 카드가 아직 없으면 공용 주요 뉴스 ──
  function newCode() {
    const letters = "abcdefghjkmnpqrstuvwxyz23456789"; // 헷갈리는 글자(i, l, o, 0, 1) 제외
    const bytes = crypto.getRandomValues(new Uint8Array(5));
    return Array.from(bytes, (b) => letters[b % letters.length]).join("");
  }

  function route() {
    code = store.get(CODE_STORE, null);
    if (code) openFeed();
    else showInterestForm(false);
  }

  async function openFeed() {
    showPanel(el("p", { class: "panel-note" }, "카드를 불러오는 중…"));
    data = await loadData(code).catch(() => null);
    pending = !data?.cards?.length;
    if (pending) data = await loadData("headlines").catch(() => null);
    who.hidden = false;
    who.textContent = pending ? "⏳ 준비 중 ▾" : `${data.person?.emoji || "🙂"} ${data.person?.name || "나"} ▾`;
    if (!data?.cards?.length) {
      showPanel(
        el("h1", { class: "panel-title" }, "카드를 준비하고 있어요"),
        el("p", { class: "panel-note" }, "다음 업데이트 때 여기에 내 카드가 생겨요."),
        el("button", { class: "ghost", type: "button", onclick: showMenu }, "관심사 고치기 · 코드 보기"),
      );
      return;
    }
    filter = "all";
    renderChips();
    renderFeed();
  }

  function showMenu() {
    who.hidden = true;
    const codeInput = el("input", {
      class: "field", type: "text", placeholder: "받은 코드 입력", "aria-label": "코드",
      autocapitalize: "off", autocomplete: "off", spellcheck: "false",
    });
    showPanel(
      el("h1", { class: "panel-title" }, pending ? "⏳ 카드 준비 중" : `${data?.person?.emoji || "🙂"} ${data?.person?.name || "나"}`),
      el("div", { class: "stack" },
        el("button", { class: "ghost", type: "button", onclick: () => showInterestForm(true) }, "✏️ 내 관심사 고치기"),
        el("p", { class: "code-line" }, "내 코드 ", el("b", {}, code || "-"), " · 관심사를 보낼 때 같이 가요"),
        el("p", { class: "label" }, "다른 기기에서 쓰던 코드가 있다면"),
        el("form", {
          class: "row",
          onsubmit: (e) => {
            e.preventDefault();
            const value = codeInput.value.trim().toLowerCase();
            if (!value) return;
            store.set(CODE_STORE, value);
            code = value;
            openFeed();
          },
        }, codeInput, el("button", { class: "again", type: "submit" }, "열기")),
        el("button", { class: "again wide", type: "button", onclick: openFeed }, "카드로 돌아가기"),
      ),
    );
  }
  who.addEventListener("click", showMenu);

  // ── 관심사 등록·고치기: 지금은 카톡 등으로 보내면 다음 업데이트 때 반영 ──
  const QUICK = ["오늘의 경제 뉴스", "주식·재테크 기초", "부동산", "건강·운동", "요리·맛집", "국내 여행",
    "IT·전자기기", "자동차", "스포츠", "드라마·영화", "자녀 교육", "취미 생활"];

  function showInterestForm(editing) {
    who.hidden = true;
    const draft = store.get(DRAFT_STORE, {});
    const mine = editing && !pending ? data : null; // 이미 카드가 있으면 지금 관심사로 채운다
    const field = (attrs, value) => {
      const input = el(attrs.rows ? "textarea" : "input", { class: `field${attrs.rows ? " area" : ""}`, ...attrs });
      input.value = value || "";
      return input;
    };
    const name = field({ type: "text", placeholder: "이름이나 별명", "aria-label": "이름" }, mine?.person?.name || draft.name);
    const about = field({ type: "text", placeholder: "나를 한 줄로 (선택, 예: 50대 직장인, 고3)", "aria-label": "한 줄 소개" }, mine?.person?.about || draft.about);
    const text = field({
      rows: "8", "aria-label": "관심사",
      placeholder: "예) 요즘 건강 관리랑 걷기 운동에 관심 있어. 주식은 조금 해봤는데 기초부터 알고 싶고, 부동산 뉴스도 궁금해. 주말에 갈 만한 국내 여행지도 알려줘. 광고는 빼줘.",
    }, mine?.interests || draft.text);
    const saveDraft = () => store.set(DRAFT_STORE, { name: name.value, about: about.value, text: text.value });
    [name, about, text].forEach((f) => f.addEventListener("input", saveDraft));

    const chipsRow = el("div", { class: "quick" }, QUICK.map((q) => el("button", {
      class: "chip-btn", type: "button",
      onclick: () => {
        text.value = text.value.trim() ? `${text.value.trim()}, ${q}` : q;
        saveDraft();
        text.focus();
      },
    }, `＋ ${q}`)));

    const status = el("p", { class: "panel-note" }, "보내준 관심사로 다음 업데이트 때 나만의 카드가 만들어져요.");
    // 코드가 생기기 전엔 '코드로 열기', 생긴 뒤엔 카드(준비 중이면 주요 뉴스)로
    const backLabel = () => (!code ? "이미 받은 코드가 있어요" : editing ? "카드로 돌아가기" : "그동안 주요 뉴스 보기");
    const back = el("button", { class: "ghost", type: "button", onclick: () => (code ? openFeed() : showCodeEntry()) }, backLabel());
    const send = async () => {
      if (!name.value.trim() || !text.value.trim()) {
        status.textContent = "이름과 관심사를 적어주세요.";
        return;
      }
      if (!code) {
        code = newCode();
        store.set(CODE_STORE, code);
        back.textContent = backLabel();
      }
      const message = [
        `[스르륵 관심사${editing ? " 수정" : ""}]`,
        `코드: ${code}`,
        `이름: ${name.value.trim()}`,
        about.value.trim() ? `소개: ${about.value.trim()}` : null,
        "",
        text.value.trim(),
      ].filter((line) => line !== null).join("\n");
      try {
        if (navigator.share) {
          await navigator.share({ text: message });
          status.textContent = "보냈어요! 카드가 준비될 때까지 아래 버튼으로 주요 뉴스를 볼 수 있어요.";
          return;
        }
      } catch (e) {
        if (e?.name === "AbortError") return; // 공유 창을 닫은 경우
      }
      try {
        await navigator.clipboard.writeText(message);
        status.textContent = "복사했어요. 카톡에 붙여넣어 보내주세요.";
      } catch {
        status.textContent = "아래 내용을 길게 눌러 복사해서 보내주세요.";
        text.value = message;
      }
    };

    showPanel(
      el("h1", { class: "panel-title" }, editing ? "관심사 고치기" : "관심사를 알려주세요"),
      el("p", { class: "panel-note" }, "궁금한 걸 편하게 적어주세요. 자세할수록 좋고, '잘 모른다', '기초부터'라고 쓰면 쉬운 설명 연재도 만들어줘요."),
      el("div", { class: "stack" },
        name,
        about,
        text,
        el("p", { class: "label" }, "눌러서 추가"),
        chipsRow,
        el("button", { class: "again wide", type: "button", onclick: send }, "보내기 (카톡 등)"),
        status,
        back,
      ),
    );
  }

  function showCodeEntry() {
    const input = el("input", {
      class: "field center", type: "text", placeholder: "코드", "aria-label": "코드",
      autocapitalize: "off", autocomplete: "off", spellcheck: "false",
    });
    showPanel(el("form", {
      class: "stack center",
      onsubmit: (e) => {
        e.preventDefault();
        const value = input.value.trim().toLowerCase();
        if (!value) return;
        store.set(CODE_STORE, value);
        route();
      },
    },
    el("h1", { class: "panel-title" }, "코드로 열기"),
    el("p", { class: "panel-note" }, "전에 받은 코드를 넣으면 내 카드가 열려요."),
    input,
    el("button", { class: "again", type: "submit" }, "열기"),
    el("button", { class: "ghost", type: "button", onclick: () => showInterestForm(false) }, "돌아가기")));
    input.focus();
  }

  function showMessage(title, text) {
    showPanel(el("h1", { class: "panel-title" }, title), el("p", { class: "panel-note" }, text));
  }

  async function load() {
    // 공용 주요 뉴스 파일로 모드를 정하고, 잠겨 있으면 비밀번호도 이걸로 확인한다
    if (await fetchJson("data/headlines.json")) return route();

    const envelope = await fetchJson("data/headlines.enc.json");
    if (!envelope) return showMessage("카드가 아직 없어요", "새 카드가 올라오면 여기에 보여요.");
    mode = "enc";
    const saved = store.get(KEY_STORE, null);
    if (saved?.salt === envelope.salt) {
      try {
        await decrypt(envelope, fromB64(saved.key));
        rawKey = fromB64(saved.key);
        return route();
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

(() => {
  const feed = document.getElementById("feed");
  const chips = document.getElementById("chips");
  const counter = document.getElementById("counter");
  const progress = document.getElementById("progress");
  const menuBtn = document.getElementById("who");

  const FEEDBACK_KEY = "sureuk.feedback";
  const KEY_STORE = "sureuk.key";
  const CODE_STORE = "sureuk.code"; // 이 기기 사용자의 코드 (= data/<코드>.json)
  const DRAFT_STORE = "sureuk.draft";
  const SUBMIT_STORE = "sureuk.submitted"; // 관심사를 보낸 시각 (이보다 새 기사가 올라오면 준비 완료)

  let mode = "plain"; // PC 미리보기: 잠그지 않은 data/*.json, 올린 페이지: 잠근 data/*.enc.json
  let rawKey = null;
  let code = null;
  let config = null; // 사이트에서 관심사를 바로 보낼 때 쓰는 GitHub 정보 (잠근 config)
  let data = null; // 지금 보여주는 지면 (내 신문, 또는 준비 중일 때 공용 주요 뉴스)
  let pending = false;
  let filter = "all";
  let observer = null;
  let mastObserver = null;
  let waitTimer = null;
  const topBar = document.querySelector(".top");

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
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : null);
  const external = (href, attrs, ...children) =>
    el("a", { href, target: "_blank", rel: "noopener noreferrer", ...attrs }, ...children);
  const topicOf = (id) => data.topics.find((t) => t.id === id) || { id, name: id };

  function daysAgo(isoDate) {
    if (!isoDate) return null;
    const [y, m, d] = isoDate.split("-").map(Number);
    const now = new Date();
    const diff = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(y, m - 1, d)) / 86400000);
    return diff <= 0 ? "오늘" : diff === 1 ? "어제" : `${diff}일 전`;
  }

  function readMinutes(card) {
    const text = [card.summary, card.term, ...(card.sections || []).map((s) => s.text), ...(card.steps || [])].join("");
    return Math.max(1, Math.round(text.length / 450));
  }

  function longDate(iso) {
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric", weekday: "long" });
  }

  function masthead(sub) {
    return el("header", { class: "masthead" },
      el("h1", { class: "mast-title" }, "The SLR"),
      el("p", { class: "mast-sub" }, sub || "스르륵 읽는 나만의 신문"));
  }

  // 화면 전체를 패널(잠금·구독·메뉴)로 바꿀 때
  function showPanel(...children) {
    observer?.disconnect();
    chips.replaceChildren();
    counter.textContent = "";
    progress.style.width = "0";
    feed.replaceChildren(el("section", { class: "panel" }, ...children));
    window.scrollTo({ top: 0 });
    mastObserver?.disconnect();
    topBar.classList.toggle("mast-visible", Boolean(feed.querySelector(".mast-title")));
  }

  // ── 기사 조각 ──
  function figure(card, url, credit) {
    const image = safeUrl(card.image);
    if (!image) return null;
    const img = el("img", { src: image, alt: "", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" });
    const fig = el("figure", { class: "figure" },
      url ? external(url, { "aria-label": "원문 기사 열기" }, img) : img,
      credit ? el("figcaption", {}, `사진 · ${credit}`) : null);
    img.addEventListener("error", () => fig.remove(), { once: true }); // 막힌 사진은 그냥 뺀다
    return fig;
  }

  function figures(card) {
    if (!card.numbers?.length) return null;
    return el("div", { class: "figures" }, card.numbers.map((n) =>
      el("div", { class: "fig" }, el("span", { class: "fig-value" }, n.value), el("span", { class: "fig-label" }, n.label))));
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
      ? el("aside", { class: "term" }, el("b", {}, `용어 풀이 — ${card.term.slice(0, i).trim()}`), card.term.slice(i + 1).trim())
      : el("aside", { class: "term" }, el("b", {}, "용어 풀이"), card.term);
  }

  function feedbackButtons(card) {
    const vote = feedback[card.id] || 0;
    const group = el("div", { class: "fb-group" });
    const make = (value, label) => el("button", {
      class: "fb", type: "button", "aria-pressed": String(vote === value),
      onclick: () => {
        feedback[card.id] = feedback[card.id] === value ? 0 : value;
        store.set(FEEDBACK_KEY, feedback);
        const [up, down] = group.children;
        up.setAttribute("aria-pressed", String(feedback[card.id] === 1));
        down.setAttribute("aria-pressed", String(feedback[card.id] === -1));
      },
    }, label);
    group.append(make(1, "유익해요"), make(-1, "관심 없어요"));
    return group;
  }

  function renderStory(card, i, lead) {
    const topic = topicOf(card.topic);
    const isSeries = card.kind === "series";
    const sources = (card.sources || []).filter((s) => safeUrl(s.url));
    const main = sources[0];
    const when = daysAgo(main?.date);

    // 섹션 제목과 겹치는 이름은 빼고 (주요 뉴스, 주제별 보기)
    const showTopic = filter === "all" && card.kind !== "headline";
    const kicker = el("p", { class: "kicker" },
      showTopic ? el("span", {}, topic.name) : null,
      isSeries && card.episode ? el("span", {}, `연재 ${card.episode}회`) : null,
      card.ad_suspect ? el("span", { class: "warn" }, "홍보성 주의") : null);

    const byline = el("p", { class: "byline" },
      main ? el("b", {}, main.publisher) : el("b", {}, "The SLR"),
      when ? ` · ${when}` : "",
      ` · ${readMinutes(card)}분 읽기`);

    const body = el("div", { class: "body" }, (card.sections || []).map((s) => [el("h3", {}, s.title), el("p", {}, s.text)]));
    const steps = card.steps?.length ? el("ol", { class: "steps" }, card.steps.map((s) => el("li", {}, s))) : null;
    const read = main ? external(main.url, { class: "read" }, isSeries ? `참고 기사 읽기 — ${main.publisher} →` : `원문 기사 읽기 — ${main.publisher} →`) : null;
    const others = sources.slice(1);
    const also = others.length
      ? el("div", { class: "also" }, isSeries ? "참고 · " : "같은 소식 · ",
          others.flatMap((s, n) => [n ? " · " : null, external(s.url, { title: s.title }, s.publisher)]))
      : el("div", { class: "also" }, isSeries ? "기초 지식 연재 · 바뀌는 조건은 꼭 다시 확인하세요" : "");

    return el("article", { class: `story${lead ? " lead" : ""}`, "data-index": i },
      kicker.childElementCount ? kicker : null,
      el("h2", {}, card.headline),
      card.summary ? el("p", { class: "deck" }, card.summary) : null,
      figure(card, main?.url, main?.publisher),
      byline,
      body,
      figures(card),
      steps,
      table(card),
      term(card),
      read,
      el("div", { class: "foot" }, also, feedbackButtons(card)),
    );
  }

  function renderMasthead(cards) {
    const minutes = cards.reduce((sum, c) => sum + readMinutes(c), 0);
    const s = data.stats || {};
    const waiting = store.get(SUBMIT_STORE, null);
    return el("section", {},
      masthead(),
      el("div", { class: "dateline" }, el("span", {}, longDate(data.generated_at)), el("span", {}, `기사 ${cards.length} · 약 ${minutes}분`)),
      pending
        ? el("p", { class: "notice" }, waiting
          ? "지금 내 신문을 찍고 있어요. 몇 분 뒤 이 지면이 저절로 내 신문으로 바뀌어요. 그동안 오늘의 주요 뉴스를 먼저 읽어보세요."
          : "아직 내 신문이 없어요. 위 메뉴에서 관심사를 보내면 만들어져요. 그동안 오늘의 주요 뉴스를 읽어보세요.")
        : el("p", { class: "edition-note" }, `기사 ${s.candidates ?? "?"}건을 살펴 골랐고, 광고·협찬 의심 ${s.ads_filtered ?? 0}건은 걸렀습니다.`),
      ownerStatus(),
    );
  }

  function sectionHead(title, note) {
    return el("h2", { class: "section-head" }, el("span", {}, title), el("span", {}, note || ""));
  }

  function renderEnd() {
    return el("section", { class: "end" },
      el("div", { class: "ornament", "aria-hidden": "true" }, "* * *"),
      el("p", {}, "오늘 신문은 여기까지입니다. 다음 판에서 만나요."),
      el("button", { class: "link-btn", type: "button", onclick: () => window.scrollTo({ top: 0, behavior: "smooth" }) }, "1면으로"),
    );
  }

  function renderSections() {
    const make = (id, label) => el("button", {
      class: "section-btn", type: "button", "aria-pressed": String(filter === id),
      onclick: () => {
        filter = id;
        renderSections();
        renderFeed();
        chips.querySelector('[aria-pressed="true"]')?.scrollIntoView({ inline: "center", block: "nearest" });
      },
    }, label);
    chips.replaceChildren(make("all", "1면"), ...data.topics.map((t) => make(t.id, t.name)));
  }

  function renderFeed() {
    const cards = data.cards.filter((c) => filter === "all" || c.topic === filter);
    const items = [];
    cards.forEach((card, i) => {
      const prev = cards[i - 1];
      if (filter === "all" && card.kind === "headline" && !prev) items.push(sectionHead("오늘의 주요 뉴스", "모두에게"));
      if (filter === "all" && card.kind !== "headline" && (!prev || prev.kind === "headline")) items.push(sectionHead("나를 위한 지면", "관심사 기준"));
      if (filter !== "all" && !prev) items.push(sectionHead(topicOf(filter).name, `기사 ${cards.length}`));
      items.push(renderStory(card, i, i === 0));
    });
    feed.replaceChildren(renderMasthead(cards), ...items, renderEnd());
    window.scrollTo({ top: 0 });
    watch(cards.length);
    // 큰 제호가 보이는 동안은 위쪽 작은 제호를 숨긴다
    mastObserver?.disconnect();
    mastObserver = new IntersectionObserver(([e]) => topBar.classList.toggle("mast-visible", e.isIntersecting));
    mastObserver.observe(feed.querySelector(".mast-title"));
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

  // fresh: 기다리는 중엔 GitHub Pages 캐시를 건너뛰고 새 파일을 확인한다
  async function loadData(name, fresh = false) {
    const bust = fresh ? `?t=${Date.now()}` : "";
    if (mode === "plain") return fetchJson(`data/${name}.json${bust}`);
    const envelope = await fetchJson(`data/${name}.enc.json${bust}`);
    return envelope ? decrypt(envelope, rawKey) : null;
  }

  function showUnlock(envelope) {
    menuBtn.hidden = true;
    const input = el("input", {
      class: "field pin", type: "password", inputmode: "numeric", placeholder: "····", "aria-label": "비밀번호",
      autocomplete: "current-password", autocapitalize: "off", spellcheck: "false",
    });
    const msg = el("p", { class: "panel-note" }, "구독자 전용 지면입니다. 이 기기에서 처음 한 번만 비밀번호를 입력하세요.");
    const button = el("button", { class: "btn", type: "submit" }, "펼치기");
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
    }, masthead(), msg, input, button);
    showPanel(form);
    input.focus();
  }

  // ── 내 신문 열기: 코드가 없으면 구독 신청부터, 아직 없으면 공용 주요 뉴스 ──
  function newCode() {
    const letters = "abcdefghjkmnpqrstuvwxyz23456789"; // 헷갈리는 글자(i, l, o, 0, 1) 제외
    return Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => letters[b % letters.length]).join("");
  }

  // 코드는 기기 저장소와 주소(?u=코드) 둘 다에 둔다. 카톡 안 브라우저·사파리·홈 화면 앱은 저장소가 따로라서
  // 저장소만 믿으면 나갔다 들어올 때 잊어버린다. 주소에 있으면 북마크·홈 화면 추가로 계속 내 신문이 열린다.
  const validCode = (c) => /^[a-z0-9]{2,12}$/.test(c || "");
  const myLink = () => `${location.origin}${location.pathname}?u=${code}`;

  function rememberCode(value) {
    code = value;
    store.set(CODE_STORE, value);
    if (new URLSearchParams(location.search).get("u") !== value) history.replaceState(null, "", `?u=${value}`);
  }

  function linkBox() {
    if (!code) return null;
    const status = el("p", { class: "code-line" }, "카톡 '나에게 보내기'나 홈 화면 추가로 저장해 두면, 어디서 열어도 내 신문이 바로 열려요.");
    return el("div", { class: "link-box" },
      el("p", { class: "label" }, "내 신문 주소"),
      el("p", { class: "my-link" }, myLink()),
      el("button", {
        class: "btn", type: "button",
        onclick: async () => {
          try {
            if (navigator.share) return void (await navigator.share({ title: "The SLR", url: myLink() }));
          } catch (e) {
            if (e?.name === "AbortError") return;
          }
          try {
            await navigator.clipboard.writeText(myLink());
            status.textContent = "주소를 복사했어요.";
          } catch {
            status.textContent = "위 주소를 길게 눌러 복사해 주세요.";
          }
        },
      }, "주소 보내기 · 복사"),
      status);
  }

  async function route() {
    config = await loadData("config").catch(() => null);
    const saved = store.get(CODE_STORE, null);
    if (validCode(saved)) {
      rememberCode(saved);
      openFeed();
    } else {
      showInterestForm(false);
    }
  }

  async function openFeed() {
    stopWaiting();
    showPanel(el("p", { class: "panel-note" }, "지면을 펼치는 중…"));
    const waiting = Boolean(store.get(SUBMIT_STORE, null));
    data = await loadData(code, waiting).catch(() => null);
    pending = !data?.cards?.length;
    if (pending) data = await loadData("headlines").catch(() => null);
    menuBtn.hidden = false;
    if (waiting) startWaiting(openFeed); // 관심사를 보낸 뒤라면 새 지면이 올라오는지 뒤에서 확인
    if (!data?.cards?.length) {
      showPanel(masthead(), el("p", { class: "panel-note" }, "아직 오늘 지면이 없어요. 조금 뒤에 다시 열어주세요."));
      return;
    }
    filter = "all";
    renderSections();
    renderFeed();
  }

  function showMenu() {
    menuBtn.hidden = true;
    stopWaiting();
    const codeInput = el("input", {
      class: "field", type: "text", placeholder: "코드", "aria-label": "코드",
      autocapitalize: "off", autocomplete: "off", spellcheck: "false",
    });
    showPanel(
      el("h1", { class: "panel-title" }, "메뉴"),
      el("div", { class: "menu-list" },
        el("button", { class: "menu-item", type: "button", onclick: openFeed }, pending ? "주요 뉴스로 돌아가기" : "내 신문으로 돌아가기"),
        refreshItem(),
        el("button", { class: "menu-item", type: "button", onclick: () => showInterestForm(true) }, "관심사 고치기"),
      ),
      el("p", { class: "code-line" }, "내 코드 ", el("b", {}, code || "—")),
      linkBox(),
      el("p", { class: "label" }, "다른 기기에서 쓰던 코드로 열기"),
      el("form", {
        class: "row",
        onsubmit: (e) => {
          e.preventDefault();
          const value = codeInput.value.trim().toLowerCase();
          if (!validCode(value)) return;
          rememberCode(value);
          openFeed();
        },
      }, codeInput, el("button", { class: "btn", type: "submit" }, "열기")),
    );
  }
  menuBtn.addEventListener("click", showMenu);

  // ── 구독 신청(관심사 보내기): 토큰이 있으면 GitHub에서 바로 만들고, 없으면 카톡 등으로 공유 ──
  const QUICK = ["오늘의 경제", "주식·재테크 기초", "부동산", "건강·운동", "요리·맛집", "국내 여행",
    "IT·전자기기", "자동차", "스포츠", "드라마·영화", "자녀 교육", "취미"];

  async function runWorkflow(inputs) {
    const d = config.dispatch;
    const res = await fetch(`https://api.github.com/repos/${d.repo}/actions/workflows/${d.workflow}/dispatches`, {
      method: "POST",
      headers: { Authorization: `Bearer ${d.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      body: JSON.stringify({ ref: "main", inputs }),
    });
    if (res.status !== 204) throw new Error(`보내기 실패 (${res.status})`);
  }

  function showInterestForm(editing) {
    menuBtn.hidden = true;
    stopWaiting();
    if (code === "me") {
      showPanel(
        el("h1", { class: "panel-title" }, "관심사 고치기"),
        el("p", { class: "panel-note" }, "만든 사람의 신문(me)은 대화창에서 고쳐요."),
        el("button", { class: "btn wide", type: "button", onclick: openFeed }, "신문으로 돌아가기"),
      );
      return;
    }
    const draft = store.get(DRAFT_STORE, {});
    const mine = editing && !pending ? data : null; // 이미 신문이 있으면 지금 관심사로 채운다
    const about = el("input", {
      class: "field", type: "text", maxlength: "80", "aria-label": "한 줄 소개",
      placeholder: "나를 한 줄로 (예: 50대 직장인, 고3, 취준생)",
    });
    about.value = mine?.person?.about || draft.about || "";
    const text = el("textarea", {
      class: "field area", rows: "9", maxlength: "2000", "aria-label": "관심사",
      placeholder: "예) 요즘 건강 관리랑 걷기 운동에 관심 있어. 주식은 조금 해봤는데 기초부터 알고 싶고, 부동산 뉴스도 궁금해. 주말에 갈 만한 국내 여행지도 알려줘. 광고는 빼줘.",
    });
    text.value = mine?.interests || draft.text || "";
    const saveDraft = () => store.set(DRAFT_STORE, { about: about.value, text: text.value });
    about.addEventListener("input", saveDraft);
    text.addEventListener("input", saveDraft);

    const tags = el("div", { class: "quick" }, QUICK.map((q) => el("button", {
      class: "tag", type: "button",
      onclick: () => {
        text.value = text.value.trim() ? `${text.value.trim()}, ${q}` : q;
        saveDraft();
        text.focus();
      },
    }, `+ ${q}`)));

    const status = el("p", { class: "panel-note" }, config?.dispatch
      ? "보내면 몇 분 안에 나만의 신문이 만들어져요."
      : "보내준 관심사로 다음 판부터 나만의 신문이 만들어져요.");
    const submit = el("button", { class: "btn wide", type: "button" }, config?.dispatch ? "내 신문 만들기" : "보내기 (카톡 등)");
    const backLabel = () => (!code ? "이미 받은 코드가 있어요" : editing ? "신문으로 돌아가기" : "그동안 주요 뉴스 보기");
    const back = el("button", { class: "link-btn", type: "button", onclick: () => (code ? openFeed() : showCodeEntry()) }, backLabel());

    submit.addEventListener("click", async () => {
      if (text.value.trim().length < 5) {
        status.textContent = "관심사를 조금 더 적어주세요.";
        return;
      }
      if (!code) {
        rememberCode(newCode());
        back.textContent = backLabel();
      }
      if (config?.dispatch) {
        submit.disabled = true;
        status.textContent = "보내는 중…";
        try {
          await runWorkflow({ mode: "onboard", code, about: about.value.trim(), interests: text.value.trim() });
          store.set(SUBMIT_STORE, new Date().toISOString());
          store.set(DRAFT_STORE, {});
          showWaiting(false);
        } catch (e) {
          submit.disabled = false;
          status.textContent = `${e.message}. 잠시 뒤 다시 눌러주세요.`;
        }
        return;
      }
      const message = [`[스르륵 관심사${editing ? " 수정" : ""}]`, `코드: ${code}`,
        about.value.trim() ? `소개: ${about.value.trim()}` : null, "", text.value.trim()]
        .filter((line) => line !== null).join("\n");
      try {
        if (navigator.share) {
          await navigator.share({ text: message });
          status.textContent = "보냈어요! 신문이 준비될 때까지 주요 뉴스를 볼 수 있어요.";
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
    });

    showPanel(
      masthead(editing ? "관심사 고치기" : "구독 신청"),
      el("p", { class: "panel-note" }, "궁금한 걸 편하게 쭉 적어주세요. 자세할수록 좋고, '잘 모른다', '기초부터'라고 쓰면 쉬운 설명 연재도 실어드려요."),
      el("div", { class: "stack" },
        about,
        text,
        el("p", { class: "label" }, "눌러서 추가"),
        tags,
        submit,
        status,
        back,
      ),
    );
  }

  // ── 기다리기: 보낸 뒤 새 지면이 올라올 때까지 20초마다 확인 ──
  function stopWaiting() {
    clearInterval(waitTimer);
    waitTimer = null;
  }

  async function ready() {
    const since = store.get(SUBMIT_STORE, null);
    if (!since) return false;
    const fresh = await loadData(code, true).catch(() => null);
    if (fresh?.cards?.length && new Date(fresh.generated_at) >= new Date(since)) {
      store.set(SUBMIT_STORE, null);
      return true;
    }
    return false;
  }

  function startWaiting(onReady) {
    stopWaiting();
    const started = Date.now();
    waitTimer = setInterval(async () => {
      // 천천히 찍기는 한 시간 넘게 걸릴 수도 있어서 2시간까지 30초마다 확인 (앱을 다시 열면 또 확인)
      if (Date.now() - started > 2 * 60 * 60 * 1000) return stopWaiting();
      if (await ready()) {
        stopWaiting();
        onReady();
      }
    }, 30000);
  }

  // kind: "now"·"slow"(모두 새로고침) 또는 없음(새 구독자 한 사람)
  function showWaiting(kind) {
    menuBtn.hidden = true;
    const refresh = Boolean(kind);
    const note = kind === "slow"
      ? "반값으로 천천히 찍는 중이에요. 보통 1시간 안에 나와요. 화면을 닫아두고 나중에 열면 새 판이 기다리고 있어요."
      : refresh
        ? "모두의 신문을 새로 만드느라 5분쯤 걸려요. 화면을 닫았다가 나중에 열어도 돼요."
        : "보통 2~3분 걸려요. 이 화면을 닫았다가 나중에 다시 열어도 돼요.";
    showPanel(el("div", { class: "stack center" },
      masthead("윤전기 가동 중"),
      el("div", { class: "press", "aria-hidden": "true" }),
      el("h1", { class: "panel-title" }, refresh ? "오늘 새 판을 찍고 있어요" : "내 신문을 찍고 있어요"),
      el("p", { class: "panel-note" }, note),
      refresh ? null : linkBox(),
      el("button", { class: "link-btn", type: "button", onclick: openFeed }, refresh ? "그동안 지난 판 보기" : "그동안 주요 뉴스 보기"),
    ));
    startWaiting(openFeed);
  }

  // ── 새 판 찍기 (만든 사람만, 하루 한 번 — 서버에서도 tools/refresh_gate.py가 막는다) ──
  // 상태는 기기에 적어두지 않고 GitHub 실행 기록에서 매번 확인한다 (실패·진행 중·완료를 그대로 보여주려고)
  const dayOf = (iso) => new Date(iso).toLocaleDateString("sv-SE"); // 이 기기 날짜 YYYY-MM-DD
  const clock = (iso) => new Date(iso).toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" });

  async function refreshRuns() {
    const d = config?.dispatch;
    if (!d) return [];
    try {
      const res = await fetch(`https://api.github.com/repos/${d.repo}/actions/workflows/${d.workflow}/runs?per_page=15`, {
        headers: { Authorization: `Bearer ${d.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
        cache: "no-store",
      });
      if (!res.ok) return [];
      return ((await res.json()).workflow_runs || []).filter((r) => (r.display_title || "").startsWith("refresh"));
    } catch {
      return [];
    }
  }

  function describeRun(run) {
    const slow = run.display_title.includes("slow");
    const speed = slow ? "천천히" : "바로";
    if (run.status !== "completed") {
      const mins = Math.max(1, Math.round((Date.now() - new Date(run.run_started_at || run.created_at)) / 60000));
      return { state: "running", text: `새 판 찍는 중 · ${speed} · ${mins}분째${slow ? " (보통 1시간 안)" : " (5분 안팎)"}` };
    }
    if (run.conclusion === "success") return { state: "done", text: `${clock(run.created_at)}에 ${speed} 찍은 새 판` };
    return { state: "failed", text: `${clock(run.created_at)}에 누른 새 판 찍기가 실패했어요` };
  }

  function refreshItem() {
    if (code !== "me" || !config?.dispatch) return null;
    const note = el("p", { class: "code-line" }, "새 판 상태를 확인하는 중…");
    const press = (speed) => async () => {
      buttons.forEach((b) => (b.disabled = true));
      note.textContent = "보내는 중…";
      try {
        await runWorkflow({ mode: "refresh", speed });
        store.set(SUBMIT_STORE, new Date().toISOString());
        showWaiting(speed);
      } catch (e) {
        buttons.forEach((b) => (b.disabled = false));
        note.textContent = `${e.message}. 잠시 뒤 다시 눌러주세요.`;
      }
    };
    const buttons = [
      el("button", { class: "menu-item", type: "button", disabled: true, onclick: press("now") },
        "지금 바로 찍기", el("span", { class: "menu-sub" }, "약 2천 원 · 5분 안팎")),
      el("button", { class: "menu-item", type: "button", disabled: true, onclick: press("slow") },
        "천천히 찍기", el("span", { class: "menu-sub" }, "약 1천 원 · 보통 1시간 안 · 자기 전에 눌러두기 좋아요")),
    ];
    (async () => {
      const runs = await refreshRuns();
      const last = runs[0] && describeRun(runs[0]);
      if (last?.state === "running") {
        note.textContent = `${last.text}. 다 되면 신문이 저절로 바뀌니 다시 누르지 않아도 돼요.`;
        return; // 버튼은 잠근 채로
      }
      const doneToday = runs.find((r) => r.conclusion === "success" && dayOf(r.created_at) === dayOf(new Date()));
      if (doneToday) {
        note.textContent = `오늘 새 판은 ${clock(doneToday.created_at)}에 찍었어요 · 다음 판은 내일`;
        return;
      }
      buttons.forEach((b) => (b.disabled = false));
      const base = "나와 테스터 모두의 신문을 함께 새로 만들어요 · 하루 한 번 · 금액은 지금 두 사람 기준";
      note.textContent = last?.state === "failed" ? `${last.text}. 다시 눌러주세요 · ${base}` : base;
    })();
    return [...buttons, note];
  }

  // 지면 위쪽 한 줄: 이번 판 정보, 또는 지금 찍는 중·실패 (만든 사람만)
  function ownerStatus() {
    if (code !== "me" || !config?.dispatch || pending) return null;
    const ed = data.edition;
    const line = el("p", { class: "edition-status" },
      ed?.people && !ed.partial ? `이번 판: ${ed.people}명의 신문을 함께 찍었어요${ed.batch ? " · 천천히(반값)" : ""}` : "");
    (async () => {
      const runs = await refreshRuns();
      const last = runs[0] && describeRun(runs[0]);
      if (last?.state === "running") {
        line.textContent = `${last.text} — 다 되면 이 지면이 저절로 바뀌어요`;
        line.className = "edition-status live";
        if (!store.get(SUBMIT_STORE, null)) store.set(SUBMIT_STORE, runs[0].created_at); // 다른 기기에서 눌렀어도
        if (!waitTimer) startWaiting(openFeed);
      } else if (last?.state === "failed" && new Date(runs[0].created_at) > new Date(data.generated_at)) {
        line.textContent = `${last.text}. 메뉴에서 다시 찍을 수 있어요.`;
        line.className = "edition-status warn";
        store.set(SUBMIT_STORE, null);
        stopWaiting();
      }
    })();
    return line;
  }

  function showCodeEntry() {
    const input = el("input", {
      class: "field", type: "text", placeholder: "코드", "aria-label": "코드",
      autocapitalize: "off", autocomplete: "off", spellcheck: "false",
    });
    showPanel(el("form", {
      class: "stack",
      onsubmit: (e) => {
        e.preventDefault();
        const value = input.value.trim().toLowerCase();
        if (!validCode(value)) return;
        rememberCode(value);
        route();
      },
    },
    el("h1", { class: "panel-title" }, "코드로 열기"),
    el("p", { class: "panel-note" }, "전에 받은 코드를 넣으면 내 신문이 열려요."),
    input,
    el("button", { class: "btn wide", type: "submit" }, "열기"),
    el("button", { class: "link-btn", type: "button", onclick: () => showInterestForm(false) }, "돌아가기")));
    input.focus();
  }

  async function load() {
    // 공용 주요 뉴스 파일로 모드를 정하고, 잠겨 있으면 비밀번호도 이걸로 확인한다
    if (await fetchJson("data/headlines.json")) return route();

    const envelope = await fetchJson("data/headlines.enc.json");
    if (!envelope) {
      showPanel(masthead(), el("p", { class: "panel-note" }, "아직 발행된 지면이 없어요."));
      return;
    }
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

  // 내 신문 주소(?u=코드)로 들어왔으면 그 코드를 이 기기에 기억한다
  const codeFromUrl = new URLSearchParams(location.search).get("u");
  if (validCode(codeFromUrl)) store.set(CODE_STORE, codeFromUrl);

  // 홈 화면 앱으로 쓸 때 오프라인에서도 열리게
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  load();
})();

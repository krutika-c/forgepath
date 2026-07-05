(() => {
  'use strict';

  /* ============ Options ============ */
  const OPTIONS = {
    languages: ['HTML', 'CSS', 'JavaScript', 'TypeScript', 'Python', 'Java', 'C++', 'C#', 'Go', 'Rust', 'PHP', 'Swift', 'Kotlin', 'Ruby'],
    frameworks: ['React', 'Vue', 'Angular', 'Svelte', 'Next.js', 'Node.js', 'Express', 'Django', 'Flask', 'Spring Boot', 'Bootstrap', 'Tailwind CSS', 'jQuery', '.NET'],
    experience: ['Beginner', 'Intermediate', 'Advanced'],
    time: ['Weekend', '1 Week', '2 Weeks', '1 Month', '2-3 Months'],
    goal: ['Portfolio', 'Internship / Job', 'Learning', 'Hackathon', 'Freelance'],
    interests: ['AI / ML', 'Finance', 'Healthcare', 'Education', 'Gaming', 'Productivity', 'Social', 'E-commerce', 'Music', 'Sports', 'Environment', 'Travel', 'Developer Tools']
  };

  const SINGLE_FIELDS = new Set(['experience', 'time', 'goal']);

  /* ============ State ============ */
  const state = {
    selections: { languages: new Set(), frameworks: new Set(), experience: new Set(), time: new Set(), goal: new Set(), interests: new Set() },
    favorites: JSON.parse(localStorage.getItem('forgepath_favorites') || '[]'),
    currentProject: null,
    previousTitles: []
  };

  /* ============ DOM refs ============ */
  const $ = (sel) => document.querySelector(sel);
  const generateBtn = $('#generateBtn');
  const formError = $('#formError');
  const emptyState = $('#emptyState');
  const loadingState = $('#loadingState');
  const errorState = $('#errorState');
  const errorMessage = $('#errorMessage');
  const projectCard = $('#projectCard');
  const toast = $('#toast');
  const usagePill = $('#usagePill');
  const usageText = $('#usageText');

  // Sections that support "regenerate just this part" instead of the whole project.
  const REGENERATABLE_SECTIONS = new Set([
    'whyBestFit', 'keyFeatures', 'technologies', 'suggestedApis', 'skillsLearned', 'roadmap', 'stretchGoals'
  ]);

  /* ============ Build tag selectors ============ */
  function renderTagSelectors() {
    document.querySelectorAll('.tag-select').forEach((container) => {
      const field = container.dataset.field;
      const mode = container.dataset.mode;
      container.innerHTML = '';
      OPTIONS[field].forEach((option) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tag';
        btn.textContent = option;
        btn.dataset.value = option;
        if (mode === 'single') btn.dataset.fieldGroup = 'single';
        btn.addEventListener('click', () => toggleSelection(field, option, mode, container));
        container.appendChild(btn);
      });
    });
  }

  function toggleSelection(field, value, mode, container) {
    const set = state.selections[field];
    if (mode === 'single') {
      set.clear();
      set.add(value);
      container.querySelectorAll('.tag').forEach((el) => el.classList.toggle('is-selected', el.dataset.value === value));
    } else {
      if (set.has(value)) {
        set.delete(value);
      } else {
        set.add(value);
      }
      container.querySelectorAll('.tag').forEach((el) => el.classList.toggle('is-selected', set.has(el.dataset.value)));
    }
    clearFormError();
  }

  function clearFormError() {
    formError.hidden = true;
    formError.textContent = '';
  }

  /* ============ Validation ============ */
  function collectProfile() {
    const otherLangs = $('#languagesOther').value.split(',').map((s) => s.trim()).filter(Boolean);
    const otherFrameworks = $('#frameworksOther').value.split(',').map((s) => s.trim()).filter(Boolean);

    return {
      languages: [...state.selections.languages, ...otherLangs],
      frameworks: [...state.selections.frameworks, ...otherFrameworks],
      experience: [...state.selections.experience][0] || '',
      time: [...state.selections.time][0] || '',
      goal: [...state.selections.goal][0] || '',
      interests: [...state.selections.interests]
    };
  }

  function validateProfile(profile) {
    if (profile.languages.length === 0) return 'Select or enter at least one language you know.';
    if (!profile.experience) return 'Select your experience level.';
    if (!profile.time) return 'Select how much time you have available.';
    if (!profile.goal) return 'Select your primary goal.';
    return null;
  }

  /* ============ Backend call ============ */
  // The Gemini API key lives server-side (.env) and is never exposed to the browser.
  // This just calls our own Express endpoint, which builds the prompt and talks to Gemini.
  async function callGemini(profile, avoidTitles) {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile, avoidTitles })
    });

    updateUsageFromResponse(res);

    let data;
    try {
      data = await res.json();
    } catch (_) {
      throw new Error(`Request failed with status ${res.status}`);
    }

    if (!res.ok) {
      const err = new Error(data?.error || `Request failed with status ${res.status}`);
      err.status = res.status;
      throw err;
    }

    return data;
  }

  /* ============ "Generations left today" indicator ============ */
  function renderUsagePill(remaining, limit) {
    if (!usagePill || !usageText || remaining == null || limit == null || Number.isNaN(remaining) || Number.isNaN(limit)) return;
    usageText.textContent = `${remaining} / ${limit} left today`;
    const isLow = remaining <= Math.max(1, Math.round(limit * 0.1));
    usagePill.classList.toggle('usage-pill--low', isLow);
    usagePill.hidden = false;
  }

  function updateUsageFromResponse(res) {
    const remaining = res.headers.get('X-RateLimit-Remaining-Daily');
    const limit = res.headers.get('X-RateLimit-Limit-Daily');
    if (remaining === null || limit === null) return;
    renderUsagePill(Number(remaining), Number(limit));
  }

  async function loadInitialUsage() {
    try {
      const res = await fetch('/api/usage');
      const data = await res.json();
      if (res.ok) renderUsagePill(data.remaining, data.limit);
    } catch (_) {
      // Non-critical — the pill just stays hidden if this fails.
    }
  }

  /* ============ UI state transitions ============ */
  function showState(name) {
    emptyState.hidden = name !== 'empty';
    loadingState.hidden = name !== 'loading';
    errorState.hidden = name !== 'error';
    projectCard.hidden = name !== 'result';
  }

  function setGenerating(isGenerating) {
    generateBtn.disabled = isGenerating;
    generateBtn.style.opacity = isGenerating ? '0.7' : '1';
  }

  /* ============ Generate flow ============ */
  async function handleGenerate({ isRegenerate = false } = {}) {
    const profile = collectProfile();
    const validationError = validateProfile(profile);
    if (validationError) {
      formError.textContent = validationError;
      formError.hidden = false;
      return;
    }
    clearFormError();

    showState('loading');
    setGenerating(true);
    $('#loadingText').textContent = isRegenerate ? 'Finding a different fit…' : 'Forging your path…';

    try {
      const result = await callGemini(profile, state.previousTitles);
      state.currentProject = { ...result, profileSnapshot: profile, savedAt: null };
      state.previousTitles.push(result.projectTitle);
      renderProjectCard(state.currentProject);
      showState('result');
      projectCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      console.error(err);
      errorMessage.textContent = friendlyError(err);
      showState('error');
    } finally {
      setGenerating(false);
    }
  }

  function friendlyError(err) {
    if (err.status === 500 && /GEMINI_API_KEY/.test(err.message || '')) return err.message;
    if (err.status === 403) return 'Access denied. The server\'s Gemini API key may be invalid or lack permission for this model.';
    if (err.status === 404) return 'The configured Gemini model was not found. Check GEMINI_MODEL in the server\'s .env file.';
    if (err.status === 429) return 'Rate limit reached. Wait a moment and try again.';
    if (err.message) return err.message;
    return 'The request failed. Check your connection and try again.';
  }

  /* ============ Render project card ============ */
  function difficultyClass(diff) {
    const d = (diff || '').toLowerCase();
    if (d.includes('beginner')) return 'pill--difficulty-beginner';
    if (d.includes('advanced')) return 'pill--difficulty-advanced';
    return 'pill--difficulty-intermediate';
  }

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderChips(list, extraClass = '') {
    if (!list || !list.length) return '<p class="section__text" style="color:var(--text-muted)">None specified.</p>';
    return `<div class="chip-list">${list.map((item) => `<span class="chip ${extraClass}">${escapeHtml(item)}</span>`).join('')}</div>`;
  }

  function renderFeatureList(list) {
    if (!list || !list.length) return '';
    return `<ul class="feature-list">${list.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
  }

  function renderRoadmap(list) {
    if (!list || !list.length) return '';
    return `
      <div class="roadmap">
        <div class="roadmap__line"></div>
        ${list.map((step, i) => `
          <div class="roadmap__item">
            <div class="roadmap__node">${i + 1}</div>
            <p class="roadmap__title">${escapeHtml(step.milestone)}</p>
            <p class="roadmap__desc">${escapeHtml(step.description)}</p>
          </div>
        `).join('')}
      </div>`;
  }

  /* ============ Section helpers (support "regenerate this section") ============ */
  function sectionHeader(title, key) {
    const btn = REGENERATABLE_SECTIONS.has(key)
      ? `<button type="button" class="regen-btn" data-regen-section="${key}" title="Regenerate just this section" aria-label="Regenerate ${escapeHtml(title)}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M4 12a8 8 0 0114-5.3M20 12a8 8 0 01-14 5.3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M18 3v5h-5M6 21v-5h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>`
      : '';
    return `<h3 class="section__title">${title}${btn}</h3>`;
  }

  function sectionBlock(key, title, bodyHtml) {
    return `
      <div class="card__section" data-section-block="${key}">
        ${sectionHeader(title, key)}
        <div class="section__body">${bodyHtml}</div>
      </div>`;
  }

  function renderSectionBody(key, value) {
    switch (key) {
      case 'roadmap': return renderRoadmap(value);
      case 'keyFeatures': return renderFeatureList(value);
      case 'stretchGoals': return renderFeatureList(value);
      case 'technologies': return renderChips(value);
      case 'suggestedApis': return renderChips(value, 'chip--steel');
      case 'skillsLearned': return renderChips(value, 'chip--steel');
      case 'whyBestFit': return `<div class="callout"><p class="section__text">${escapeHtml(value)}</p></div>`;
      default: return '';
    }
  }

  /* ============ Regenerate a single section ============ */
  async function handleRegenerateSection(key, btnEl) {
    if (!state.currentProject) return;
    const blockBody = document.querySelector(`.card__section[data-section-block="${key}"] .section__body`);
    if (!blockBody) return;

    btnEl.disabled = true;
    btnEl.classList.add('is-spinning');

    try {
      const res = await fetch('/api/regenerate-section', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile: state.currentProject.profileSnapshot,
          project: state.currentProject,
          section: key
        })
      });
      updateUsageFromResponse(res);

      let data;
      try {
        data = await res.json();
      } catch (_) {
        throw new Error(`Request failed with status ${res.status}`);
      }
      if (!res.ok) throw new Error(data?.error || `Request failed with status ${res.status}`);

      state.currentProject[key] = data.value;
      blockBody.innerHTML = renderSectionBody(key, data.value);
      if (state.favorites.includes(state.currentProject)) {
        persistFavorites();
      }
      showToast('Section updated.');
    } catch (err) {
      console.error(err);
      showToast(err.message || 'Could not regenerate this section.');
    } finally {
      btnEl.disabled = false;
      btnEl.classList.remove('is-spinning');
    }
  }

  function renderProjectCard(project) {
    const isFav = state.favorites.some((f) => f.projectTitle === project.projectTitle && f.savedAt === project.savedAt);
    projectCard.innerHTML = `
      <div class="card__hero">
        <div class="card__actions">
          <button class="btn btn--secondary btn--sm" id="saveFavBtn" title="Save to favorites">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 3h12a1 1 0 011 1v17l-7-4-7 4V4a1 1 0 011-1z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
            Save
          </button>
        </div>
        <div class="card__badges">
          <span class="pill ${difficultyClass(project.difficulty)}">${escapeHtml(project.difficulty || 'N/A')}</span>
          <span class="pill pill--time">${escapeHtml(project.estimatedTime || 'N/A')}</span>
        </div>
        <h2 class="card__title">${escapeHtml(project.projectTitle)}</h2>
        <p class="card__desc">${escapeHtml(project.shortDescription)}</p>
        ${project.mentorNote ? `
        <div class="mentor-note">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3l9 16H3L12 3z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 10v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="17" r="0.9" fill="currentColor"/></svg>
          <div>
            <p class="mentor-note__label">Reality check</p>
            <p class="mentor-note__text">${escapeHtml(project.mentorNote)}</p>
          </div>
        </div>` : ''}
      </div>
      <div class="card__body">
        <div class="card__section">
          <h3 class="section__title">Problem it solves</h3>
          <p class="section__text">${escapeHtml(project.problemSolved)}</p>
        </div>
        ${sectionBlock('whyBestFit', 'Why this fits you', `<div class="callout"><p class="section__text">${escapeHtml(project.whyBestFit)}</p></div>`)}
        ${sectionBlock('keyFeatures', 'Key features', renderFeatureList(project.keyFeatures))}
        ${sectionBlock('technologies', 'Technologies to use', renderChips(project.technologies))}
        ${project.suggestedApis && project.suggestedApis.length
          ? sectionBlock('suggestedApis', 'Suggested public APIs', renderChips(project.suggestedApis, 'chip--steel'))
          : ''}
        ${sectionBlock('skillsLearned', "Skills you'll learn", renderChips(project.skillsLearned, 'chip--steel'))}
        ${sectionBlock('roadmap', 'Development roadmap', renderRoadmap(project.roadmap))}
        <div class="card__section">
          <h3 class="section__title">Portfolio value</h3>
          <p class="section__text">${escapeHtml(project.portfolioValue)}</p>
        </div>
        ${sectionBlock('stretchGoals', 'Future improvements &amp; stretch goals', renderFeatureList(project.stretchGoals))}
      </div>
      <div class="card__footer-actions">
        <button class="btn btn--secondary" id="regenerateBtn">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M4 12a8 8 0 0114-5.3M20 12a8 8 0 01-14 5.3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M18 3v5h-5M6 21v-5h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Generate another
        </button>
      </div>
    `;

    $('#saveFavBtn').textContent = isFav ? '' : '';
    $('#saveFavBtn').innerHTML = isFav
      ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 3h12a1 1 0 011 1v17l-7-4-7 4V4a1 1 0 011-1z"/></svg> Saved`
      : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 3h12a1 1 0 011 1v17l-7-4-7 4V4a1 1 0 011-1z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg> Save`;

    $('#saveFavBtn').addEventListener('click', () => toggleFavorite(project));
    $('#regenerateBtn').addEventListener('click', () => handleGenerate({ isRegenerate: true }));
  }

  /* ============ Favorites ============ */
  function persistFavorites() {
    localStorage.setItem('forgepath_favorites', JSON.stringify(state.favorites));
    updateFavCount();
  }

  function updateFavCount() {
    const el = $('#favCount');
    el.textContent = state.favorites.length;
    el.hidden = state.favorites.length === 0;
  }

  function toggleFavorite(project) {
    const existingIndex = state.favorites.findIndex((f) => f.projectTitle === project.projectTitle);
    if (existingIndex >= 0) {
      state.favorites.splice(existingIndex, 1);
      showToast('Removed from favorites.');
    } else {
      const toSave = { ...project, savedAt: Date.now() };
      state.currentProject = toSave;
      state.favorites.unshift(toSave);
      showToast('Saved to favorites.');
    }
    persistFavorites();
    renderProjectCard(state.currentProject);
  }

  function renderDrawer() {
    const body = $('#drawerBody');
    if (!state.favorites.length) {
      body.innerHTML = `<div class="drawer__empty">No saved projects yet. Generate a recommendation and hit "Save" to keep it here.</div>`;
      return;
    }
    body.innerHTML = state.favorites.map((f, i) => `
      <div class="fav-item" data-index="${i}">
        <p class="fav-item__title">${escapeHtml(f.projectTitle)}</p>
        <div class="fav-item__meta">
          <span>${escapeHtml(f.difficulty || '')} · ${escapeHtml(f.estimatedTime || '')}</span>
          <button class="fav-item__remove" data-remove="${i}">Remove</button>
        </div>
      </div>
    `).join('');

    body.querySelectorAll('.fav-item').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-remove]')) return;
        const i = Number(el.dataset.index);
        state.currentProject = state.favorites[i];
        renderProjectCard(state.currentProject);
        showState('result');
        closeDrawer();
        projectCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
    body.querySelectorAll('[data-remove]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const i = Number(btn.dataset.remove);
        state.favorites.splice(i, 1);
        persistFavorites();
        renderDrawer();
      });
    });
  }

  /* ============ About modal ============ */
  function openAbout() { $('#aboutOverlay').hidden = false; }
  function closeAbout() { $('#aboutOverlay').hidden = true; }

  /* ============ Drawer open/close ============ */
  function openDrawer() { renderDrawer(); $('#drawerOverlay').hidden = false; }
  function closeDrawer() { $('#drawerOverlay').hidden = true; }

  /* ============ Toast ============ */
  let toastTimer = null;
  function showToast(msg) {
    toast.textContent = msg;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 3200);
  }

  /* ============ Wire up ============ */
  function init() {
    renderTagSelectors();
    updateFavCount();
    loadInitialUsage();

    generateBtn.addEventListener('click', () => handleGenerate());
    $('#retryBtn').addEventListener('click', () => handleGenerate({ isRegenerate: true }));

    projectCard.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-regen-section]');
      if (btn) handleRegenerateSection(btn.dataset.regenSection, btn);
    });

    $('#aboutBtn').addEventListener('click', openAbout);
    $('#closeAbout').addEventListener('click', closeAbout);
    $('#closeAbout2').addEventListener('click', closeAbout);
    $('#aboutOverlay').addEventListener('click', (e) => { if (e.target.id === 'aboutOverlay') closeAbout(); });

    $('#favoritesBtn').addEventListener('click', openDrawer);
    $('#closeDrawer').addEventListener('click', closeDrawer);
    $('#drawerOverlay').addEventListener('click', (e) => { if (e.target.id === 'drawerOverlay') closeDrawer(); });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeAbout(); closeDrawer(); }
    });
  }

  init();
})();
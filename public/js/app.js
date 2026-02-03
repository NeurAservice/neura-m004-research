/**
 * @file public/js/app.js
 * @description Основной модуль приложения NeurA Research
 */

// Determine API base path from current location
const API_BASE = (function() {
  const path = window.location.pathname;
  if (path.includes('/m004')) {
    return '/m004/api';
  }
  return '/api';
})();

const app = {
  currentResearchId: null,
  eventSource: null,
  abortController: null,
  version: 'loading...',
  userId: null,
  topupUrl: null,

  async init() {
    await i18n.init();
    await this.loadModuleConfig();
    this.initializeUser();
    this.bindEvents();
    this.initBalanceWidget();
  },

  /**
   * Load module configuration from server (name, version)
   */
  async loadModuleConfig() {
    try {
      const healthPath = API_BASE.replace('/api', '/health');
      const response = await fetch(healthPath);
      const data = await response.json();

      // Health returns { module: { version, name } }
      const version = data.module?.version || data.version;
      const name = data.module?.name || data.moduleName;

      if (version) {
        this.version = version;
        const versionBadge = document.getElementById('version-badge');
        if (versionBadge) {
          versionBadge.textContent = `v${version}`;
        }
        console.log(`[M004] Version from server: ${version}`);
      }

      if (name) {
        const moduleNameEl = document.getElementById('module-name');
        if (moduleNameEl) {
          moduleNameEl.textContent = name;
        }
      }
    } catch (error) {
      console.error('[M004] Failed to load module config:', error);
      const versionBadge = document.getElementById('version-badge');
      if (versionBadge) {
        versionBadge.textContent = 'v?';
      }
    }
  },

  /**
   * Initialize user from URL params
   */
  initializeUser() {
    const params = new URLSearchParams(window.location.search);
    const studentId = params.get('studentId');
    const schoolNumber = params.get('schoolNumber');

    if (studentId && schoolNumber) {
      this.userId = `xl_${schoolNumber}_${studentId}`;
      console.log('[M004] User initialized:', this.userId);
    }
  },

  /**
   * Get shell_id from URL parameter
   */
  getExplicitShellId() {
    const params = new URLSearchParams(window.location.search);
    return params.get('shell') || null;
  },

  /**
   * Get origin_url for shell detection
   */
  getShellOriginUrl() {
    const referrer = document.referrer;
    if (referrer) {
      try {
        const referrerUrl = new URL(referrer);
        if (referrerUrl.hostname.endsWith('.xl.ru') || referrerUrl.hostname === 'xl.ru') {
          return referrer;
        }
      } catch (e) {
        // Ignore
      }
    }
    return window.location.href;
  },

  bindEvents() {
    // Research form
    const form = document.getElementById('research-form');
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        this.startResearch();
      });
    }

    // Balance widget (Standard)
    const balanceToggle = document.getElementById('balance-toggle');
    if (balanceToggle) {
      balanceToggle.addEventListener('click', () => this.toggleBalancePopover());
    }

    const balanceClose = document.getElementById('balance-close');
    if (balanceClose) {
      balanceClose.addEventListener('click', () => this.closeBalancePopover());
    }

    const balanceRefresh = document.getElementById('balance-refresh');
    if (balanceRefresh) {
      balanceRefresh.addEventListener('click', () => this.fetchBalance());
    }

    // Close popover on outside click
    document.addEventListener('click', (e) => {
      const popover = document.getElementById('balance-popover');
      const toggle = document.getElementById('balance-toggle');
      if (popover && !popover.hidden && !popover.contains(e.target) && !toggle.contains(e.target)) {
        this.closeBalancePopover();
      }
    });

    // Language selector - переключение языка интерфейса
    const langSelect = document.getElementById('language-select');
    if (langSelect) {
      // Set current locale in selector
      langSelect.value = i18n.locale;

      langSelect.addEventListener('change', (e) => {
        i18n.setLocale(e.target.value);
      });
    }
  },

  initBalanceWidget() {
    // Initial fetch not needed - will fetch on popover open
  },

  toggleBalancePopover() {
    console.log('[M004] Balance toggle clicked');
    const popover = document.getElementById('balance-popover');
    if (popover) {
      const isHidden = popover.hidden;
      console.log('[M004] Popover was hidden:', isHidden);
      popover.hidden = !isHidden;
      console.log('[M004] Popover now hidden:', popover.hidden);
      if (!popover.hidden) {
        this.fetchBalance();
      }
    } else {
      console.error('[M004] Balance popover element not found!');
    }
  },

  closeBalancePopover() {
    const popover = document.getElementById('balance-popover');
    if (popover) {
      popover.hidden = true;
    }
  },

  async fetchBalance() {
    console.log('[M004] Fetching balance...');
    const valueEl = document.getElementById('balance-value');
    const updatedEl = document.getElementById('balance-updated');
    const topupBtn = document.getElementById('balance-topup');

    if (valueEl) {
      valueEl.textContent = '...';
    }

    try {
      const shellId = this.getExplicitShellId();
      const originUrl = this.getShellOriginUrl();

      let url = `${API_BASE}/balance?origin_url=${encodeURIComponent(originUrl)}`;
      if (this.userId) {
        url += `&user_id=${encodeURIComponent(this.userId)}`;
      }
      if (shellId) {
        url += `&shell_id=${encodeURIComponent(shellId)}`;
      }

      console.log('[M004] Balance URL:', url);
      const response = await fetch(url);
      const result = await response.json();
      console.log('[M004] Balance response:', result);

      if (result.status === 'success' && result.data) {
        const balance = result.data.balance;
        this.topupUrl = result.data.topup_url || null;

        console.log('[M004] Balance value:', balance, 'Topup URL:', this.topupUrl);
        if (valueEl) {
          valueEl.textContent = balance.toFixed(2);
          console.log('[M004] Set balance text to:', balance.toFixed(2));
        }
        if (updatedEl) {
          updatedEl.textContent = `${i18n.t('balance.updatedAt')}: ${new Date().toLocaleTimeString(i18n.locale === 'ru' ? 'ru-RU' : 'en-US')}`;
        }
        this.updateTopupLink();
      } else {
        throw new Error(result.message || 'Balance fetch failed');
      }
    } catch (error) {
      console.error('[M004] Failed to fetch balance:', error);
      if (valueEl) {
        valueEl.textContent = '--';
      }
      if (updatedEl) {
        updatedEl.textContent = i18n.t('balance.error');
      }
    }
  },

  updateTopupLink() {
    const topupBtn = document.getElementById('balance-topup');
    if (topupBtn) {
      if (this.topupUrl) {
        topupBtn.href = this.topupUrl;
        topupBtn.target = '_blank';
        topupBtn.onclick = null;
      } else {
        topupBtn.href = '#';
        topupBtn.removeAttribute('target');
        topupBtn.onclick = (e) => {
          e.preventDefault();
          this.showToast(i18n.t('errors.topupUnavailable') || 'Ссылка для пополнения недоступна', 'error');
        };
      }
    }
  },

  async startResearch() {
    const queryInput = document.getElementById('query-input');
    const query = queryInput?.value.trim();

    if (!query) {
      this.showToast(i18n.t('errors.validationError'), 'error');
      return;
    }

    // Get options
    const options = {
      mode: document.getElementById('mode-select')?.value || 'standard',
      researchType: document.getElementById('type-select')?.value || 'facts_and_analysis',
      language: document.getElementById('language-select')?.value || 'ru',
    };

    // Show progress UI
    this.showProgressUI();
    this.disableForm(true);

    try {
      const response = await api.startResearch(query, options);
      await this.handleSSEResponse(response);
    } catch (error) {
      console.error('Research failed:', error);
      this.showToast(error.message, 'error');
      this.hideProgressUI();
    } finally {
      this.disableForm(false);
    }
  },

  async handleSSEResponse(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const event = JSON.parse(line.slice(6));
              this.handleEvent(event);
            } catch (e) {
              console.warn('Failed to parse SSE event:', e);
            }
          }
        }
      }
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.error('SSE error:', error);
        this.showToast(i18n.t('errors.network'), 'error');
      }
    }
  },

  handleEvent(event) {
    console.log('Event:', event);

    switch (event.type) {
      case 'started':
        this.currentResearchId = event.research_id;
        this.updateProgress(0, i18n.t('progress.preparing'));
        break;

      case 'progress':
        this.updateProgress(event.progress, event.message || '');
        if (event.phase) {
          this.updatePhase(event.phase);
        }
        break;

      case 'phase_complete':
        this.markPhaseComplete(event.phase);
        break;

      case 'clarification_needed':
        this.showClarificationUI(event.questions, event.research_id);
        break;

      case 'completed':
        this.updateProgress(100, i18n.t('progress.output'));
        this.showResult(event.result, event.quality);
        break;

      case 'error':
        this.showToast(event.message || i18n.t('errors.unknown'), 'error');
        this.hideProgressUI();
        break;
    }
  },

  showProgressUI() {
    const progressContainer = document.getElementById('progress-container');
    const resultContainer = document.getElementById('result-container');
    const clarificationContainer = document.getElementById('clarification-container');

    if (progressContainer) progressContainer.classList.remove('hidden');
    if (resultContainer) resultContainer.classList.add('hidden');
    if (clarificationContainer) clarificationContainer.classList.add('hidden');

    // Reset phases
    document.querySelectorAll('.phase-badge').forEach(badge => {
      badge.classList.remove('active', 'completed');
    });
  },

  hideProgressUI() {
    const progressContainer = document.getElementById('progress-container');
    if (progressContainer) progressContainer.classList.add('hidden');
  },

  updateProgress(percent, message) {
    const progressBar = document.getElementById('progress-bar');
    const progressText = document.getElementById('progress-text');
    const progressPercent = document.getElementById('progress-percent');

    if (progressBar) progressBar.style.width = `${percent}%`;
    if (progressText) progressText.textContent = message;
    if (progressPercent) progressPercent.textContent = `${Math.round(percent)}%`;
  },

  updatePhase(phase) {
    document.querySelectorAll('.phase-badge').forEach(badge => {
      badge.classList.remove('active');
    });

    const activeBadge = document.querySelector(`[data-phase="${phase}"]`);
    if (activeBadge) {
      activeBadge.classList.add('active');
    }
  },

  markPhaseComplete(phase) {
    const badge = document.querySelector(`[data-phase="${phase}"]`);
    if (badge) {
      badge.classList.remove('active');
      badge.classList.add('completed');
    }
  },

  showClarificationUI(questions, researchId) {
    this.hideProgressUI();

    const container = document.getElementById('clarification-container');
    const questionsList = document.getElementById('clarification-questions');

    if (!container || !questionsList) return;

    questionsList.innerHTML = questions.map((q, i) => `
      <div class="clarification-question">
        <label for="clarify-${i}">${q.question}</label>
        <input
          type="text"
          id="clarify-${i}"
          class="form-control"
          data-question-id="${q.id || i}"
          placeholder="${q.placeholder || ''}"
        >
      </div>
    `).join('');

    container.classList.remove('hidden');
    container.dataset.researchId = researchId;
  },

  async submitClarification() {
    const container = document.getElementById('clarification-container');
    const researchId = container?.dataset.researchId;

    if (!researchId) return;

    const inputs = document.querySelectorAll('#clarification-questions input');
    const answers = {};

    inputs.forEach(input => {
      const questionId = input.dataset.questionId;
      answers[questionId] = input.value.trim();
    });

    container.classList.add('hidden');
    this.showProgressUI();

    try {
      const response = await api.submitClarification(researchId, answers);
      await this.handleSSEResponse(response);
    } catch (error) {
      console.error('Clarification failed:', error);
      this.showToast(error.message, 'error');
      this.hideProgressUI();
    }
  },

  showResult(result, quality) {
    this.hideProgressUI();

    const container = document.getElementById('result-container');
    if (!container) return;

    // Quality badge
    const qualityBadge = document.getElementById('quality-badge');
    if (qualityBadge && quality) {
      const score = quality.compositeScore || 0;
      let level = 'low';
      let label = i18n.t('result.qualityLow');

      if (score >= 0.8) {
        level = 'high';
        label = i18n.t('result.qualityHigh');
      } else if (score >= 0.6) {
        level = 'medium';
        label = i18n.t('result.qualityMedium');
      }

      qualityBadge.className = `quality-badge ${level}`;
      qualityBadge.textContent = `${label}: ${Math.round(score * 100)}%`;
    }

    // Report content
    const reportContent = document.getElementById('report-content');
    if (reportContent && result?.report) {
      // Parse markdown to HTML
      reportContent.innerHTML = this.parseMarkdown(result.report);
    }

    // Sources
    const sourcesList = document.getElementById('sources-list');
    if (sourcesList && result?.sources) {
      sourcesList.innerHTML = result.sources.map((source, i) => `
        <div class="source-item">
          <span class="source-index">[${i + 1}]</span>
          <div class="source-content">
            <div class="source-title">
              <a href="${source.url}" target="_blank" rel="noopener">${source.title || source.url}</a>
              <span class="source-authority ${this.getAuthorityClass(source.authorityScore)}">
                ${Math.round((source.authorityScore || 0) * 100)}%
              </span>
            </div>
            <div class="source-domain">${source.domain || new URL(source.url).hostname}</div>
          </div>
        </div>
      `).join('');
    }

    // Export buttons
    if (this.currentResearchId) {
      const exportMd = document.getElementById('export-md');
      const exportJson = document.getElementById('export-json');

      if (exportMd) {
        exportMd.href = api.getExportUrl(this.currentResearchId, 'markdown');
      }
      if (exportJson) {
        exportJson.href = api.getExportUrl(this.currentResearchId, 'json');
      }
    }

    container.classList.remove('hidden');
  },

  getAuthorityClass(score) {
    if (score >= 0.8) return 'high';
    if (score >= 0.5) return 'medium';
    return 'low';
  },

  parseMarkdown(text) {
    // Simple markdown parser
    return text
      // Headers
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      // Bold
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      // Italic
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      // Code blocks
      .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="language-$1">$2</code></pre>')
      // Inline code
      .replace(/`(.+?)`/g, '<code>$1</code>')
      // Links
      .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      // Lists
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
      // Paragraphs
      .replace(/\n\n/g, '</p><p>')
      .replace(/^(.+)$/gm, (match) => {
        if (match.startsWith('<')) return match;
        return `<p>${match}</p>`;
      });
  },

  disableForm(disabled) {
    const form = document.getElementById('research-form');
    if (form) {
      const inputs = form.querySelectorAll('input, textarea, select, button');
      inputs.forEach(input => {
        input.disabled = disabled;
      });
    }
  },

  showToast(message, type = 'info') {
    const container = document.getElementById('toast-container') || this.createToastContainer();

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;

    container.appendChild(toast);

    setTimeout(() => {
      toast.remove();
    }, 5000);
  },

  createToastContainer() {
    const container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
    return container;
  }
};

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  app.init();
});

window.app = app;

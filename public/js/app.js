/**
 * @file public/js/app.js
 * @description Основной модуль приложения
 */

const app = {
  currentResearchId: null,
  eventSource: null,
  abortController: null,

  async init() {
    await i18n.init();
    this.bindEvents();
    this.initBalanceWidget();
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

    // Balance widget
    const balanceTrigger = document.getElementById('balance-trigger');
    if (balanceTrigger) {
      balanceTrigger.addEventListener('click', () => this.toggleBalancePopover());
    }

    const balanceClose = document.getElementById('balance-close');
    if (balanceClose) {
      balanceClose.addEventListener('click', () => this.closeBalancePopover());
    }

    const refreshBalance = document.getElementById('refresh-balance');
    if (refreshBalance) {
      refreshBalance.addEventListener('click', () => this.fetchBalance());
    }

    // Close popover on outside click
    document.addEventListener('click', (e) => {
      const popover = document.getElementById('balance-popover');
      const trigger = document.getElementById('balance-trigger');
      if (popover && !popover.contains(e.target) && !trigger.contains(e.target)) {
        this.closeBalancePopover();
      }
    });

    // Language selector
    const langSelect = document.getElementById('language-select');
    if (langSelect) {
      langSelect.addEventListener('change', (e) => {
        i18n.setLocale(e.target.value);
      });
    }
  },

  initBalanceWidget() {
    this.fetchBalance();
  },

  toggleBalancePopover() {
    const popover = document.getElementById('balance-popover');
    if (popover) {
      popover.classList.toggle('open');
      if (popover.classList.contains('open')) {
        this.fetchBalance();
      }
    }
  },

  closeBalancePopover() {
    const popover = document.getElementById('balance-popover');
    if (popover) {
      popover.classList.remove('open');
    }
  },

  async fetchBalance() {
    const amountEl = document.getElementById('balance-amount');
    const topupBtn = document.getElementById('topup-btn');

    if (amountEl) {
      amountEl.textContent = i18n.t('balance.loading');
    }

    try {
      const result = await api.getBalance();
      if (amountEl && result.data) {
        amountEl.textContent = `${result.data.balance} ${i18n.t('balance.credits')}`;
      }
      if (topupBtn && result.data?.topup_url) {
        topupBtn.href = result.data.topup_url;
        topupBtn.classList.remove('hidden');
      }
    } catch (error) {
      console.error('Failed to fetch balance:', error);
      if (amountEl) {
        amountEl.textContent = i18n.t('balance.error');
      }
      this.showToast(error.message, 'error');
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
